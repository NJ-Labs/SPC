"""Offline behavior tests for the SPC agent harness.

A scripted LM replays ChatAdapter-formatted (or deliberately malformed) replies, so the full
DSPy ReAct loop, validation, guards, and fallbacks run without a live model.
"""

import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

import dspy
import litellm
from dspy.utils.dummies import DummyLM
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))
from main import (  # noqa: E402
    DEFAULT_MAX_LATEST_REQUEST_CHARS,
    ENV_PATH,
    MAX_SAFE_INTEGER,
    TOOL_PARAMETER_SCHEMAS,
    AgentTurnRequest,
    ChatCompletionRequest,
    DEFAULT_GATEWAY_API_KEY,
    DSPyGateway,
    RequestTooLargeError,
    SPCAgentHarness,
    SPCAgentToolSession,
    SPCKnowledgeLoader,
    _ancestor,
    agent_turn as agent_turn_endpoint,
    build_spc_evidence,
    chat_completions,
    evidence_prompt_text,
    find_ungrounded_numbers,
    normalize_chart_type,
    rescue_answer_from_raw,
    sanitize_html_blocks,
    summarize_rule_violations,
    upstream_http_error,
)


def fields(**values: Any) -> str:
    parts = []
    for name, value in values.items():
        rendered = json.dumps(value) if isinstance(value, (dict, list)) else str(value)
        parts.append(f"[[ ## {name} ## ]]\n{rendered}")
    parts.append("[[ ## completed ## ]]")
    return "\n\n".join(parts)


def step(tool: str, args: dict[str, Any] | None = None, thought: str = "ok") -> str:
    return fields(next_thought=thought, next_tool_name=tool, next_tool_args=args or {})


def final(answer: str, needs_clarification: str = "false") -> str:
    return fields(reasoning="done", answer=answer, needs_clarification=needs_clarification)


class FakeClock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def after(clock: FakeClock, seconds: float, reply: str) -> Any:
    """A scripted reply that takes `seconds` of (fake) model time."""
    def produce() -> str:
        clock.now += seconds
        return reply
    return produce


class ScriptedLM(DummyLM):
    """Returns the scripted replies in order; an Exception instance is raised, a callable is called for the reply."""

    def __init__(self, replies: list[Any]) -> None:
        super().__init__([])
        self.replies = list(replies)
        self.prompts: list[str] = []
        self.call_kwargs: list[dict[str, Any]] = []

    def __call__(self, prompt: Any = None, messages: Any = None, **kwargs: Any) -> list[str]:
        self.prompts.append("\n".join(str(message.get("content", "")) for message in messages or []))
        self.call_kwargs.append(kwargs)
        reply = self.replies.pop(0) if self.replies else final("Out of script.")
        if isinstance(reply, BaseException):
            raise reply
        if callable(reply):
            reply = reply()
        return [reply]


def run_agent(request: AgentTurnRequest, replies: list[Any], harness: SPCAgentHarness | None = None) -> tuple[Any, ScriptedLM]:
    lm = ScriptedLM(replies)
    harness = harness or SPCAgentHarness(max_iters=4, deadline_seconds=60)
    knowledge = SPCKnowledgeLoader().select(request)
    with dspy.context(lm=lm, adapter=dspy.ChatAdapter(use_json_adapter_fallback=False)):
        response = harness.run(request, knowledge, "scripted")
    return response, lm


PROCESSED = {
    "statistics": {"mean": 10.0, "standardDeviation": 0.1, "min": 9.7, "max": 10.4, "count": 40},
    "ruleViolationCount": 12,
    "ruleSummary": {
        "ruleSet": "nelson",
        "signalCount": 3,
        "flaggedPointCount": 12,
        "exactSignalCounts": True,
        "rules": [
            {"ruleNumber": 1, "description": "One point beyond a control limit", "signalCount": 1, "pointCount": 1, "firstIndex": 17, "lastIndex": 17, "signalIndices": [17]},
            {"ruleNumber": 2, "description": "9 consecutive points on the same side of the centerline", "signalCount": 2, "pointCount": 11, "firstIndex": 20, "lastIndex": 30, "signalIndices": [28, 30]},
        ],
    },
    "variationRuleSummary": {"ruleSet": "nelson", "signalCount": 1, "flaggedPointCount": 1, "rules": [
        {"ruleNumber": 1, "description": "One point beyond a control limit", "signalCount": 1, "pointCount": 1, "firstIndex": 5, "lastIndex": 5, "signalIndices": [5]},
    ]},
    "controlLimits": {
        "centerLine": 10.0, "ucl": 10.3, "lcl": 9.7, "sigma": 0.1, "processSigma": 0.1, "sigmaMethod": "MR-bar/d2 (n=2)",
        "variationChart": {"centerLine": 0.1128, "ucl": 0.3685, "lcl": 0, "sigma": 0.085},
    },
    "dataProfile": {"column": "A", "dataKind": "continuous", "rowCount": 40, "numericCount": 40, "missingCount": 0, "nonNumericCount": 0, "skewness": 0.12, "lag1Autocorrelation": 0.05, "timeOrdered": True},
    "diagnostics": [{"code": "small-baseline", "severity": "warning", "message": "Baseline has fewer than 50 points."}],
    "chartRecommendations": [{"chartType": "individual", "status": "recommended", "score": 92, "reason": "Continuous single readings."}],
    "capabilityStatus": {
        "readiness": "preliminary",
        "reasons": ["Capability is preliminary because control-chart rules indicate instability."],
        "indices": {"cp": 1.6667, "cpk": 1.2345, "cpl": 1.2345, "cpu": 2.1, "pp": 1.4, "ppk": 0.9012, "ppl": 0.9012, "ppu": 1.9, "cpm": None},
        "sigmaEstimate": {"within": 0.1, "overall": 0.119, "method": "MR-bar/d2 (n=2)", "observationCount": 40},
    },
}

# What current clients send: a full-data profile (sampled: false) for every header.
COLUMN_PROFILES = [
    {"name": "A", "numeric": 40, "nonNumeric": 0, "missing": 0, "integerLike": False, "nonNegative": True, "min": 9.7, "max": 10.4, "sampled": False},
    {"name": "B", "numeric": 40, "nonNumeric": 0, "missing": 0, "integerLike": False, "nonNegative": True, "min": 9.6, "max": 10.5, "sampled": False},
    {"name": "Date", "numeric": 0, "nonNumeric": 40, "missing": 0, "integerLike": False, "nonNegative": False, "min": None, "max": None, "sampled": False},
    {"name": "Defects", "numeric": 40, "nonNumeric": 0, "missing": 0, "integerLike": True, "nonNegative": True, "min": 0, "max": 9, "sampled": False},
    {"name": "Units", "numeric": 40, "nonNumeric": 0, "missing": 0, "integerLike": True, "nonNegative": True, "min": 20, "max": 60, "sampled": False},
    {"name": "Offset", "numeric": 40, "nonNumeric": 0, "missing": 0, "integerLike": True, "nonNegative": False, "min": -3, "max": 4, "sampled": False},
    {"name": "Area", "numeric": 40, "nonNumeric": 0, "missing": 0, "integerLike": False, "nonNegative": True, "min": 0.5, "max": 3.5, "sampled": False},
]
HEADERS = [profile["name"] for profile in COLUMN_PROFILES]


def make_request(message: str = "Configure an X-bar R chart for A and B by Date", **overrides: Any) -> AgentTurnRequest:
    controls = {
        "chartType": "individual",
        "yColumns": ["A"],
        "xAxisColumn": None,
        "sampleSize": 3,
        "chartLabel": "SPC Analysis Chart",
        "zAxisLabel": "Sample",
        "yAxisLabel": "Value",
        "showControlLimits": True,
        "showCenterLine": True,
        "showRuleViolations": True,
        "showSigma1": True,
        "showSigma2": True,
        "showSigma3": True,
        "colorScheme": "default",
        "ruleSet": "nelson",
        "lowerSpecLimit": 9.5,
        "upperSpecLimit": 10.5,
        "targetValue": 10.0,
    }
    controls.update(overrides.pop("controls", {}))
    payload: dict[str, Any] = {
        "messages": [
            {"role": "system", "content": "You are an SPC consultant. Maximum 5 bullets."},
            {"role": "user", "content": message},
        ],
        "language": "en",
        "controls": controls,
        "availableHeaders": list(HEADERS),
        "worksheet": {"activeSheetIndex": 0, "activeSheetName": "Sheet1", "worksheetCount": 1},
        "dataset": {"rowCount": 40, "columnCount": len(HEADERS), "headers": list(HEADERS), "columnProfiles": COLUMN_PROFILES},
        "processed": PROCESSED,
    }
    payload.update(overrides)
    return AgentTurnRequest(**payload)


class AgentLoopRobustnessTest(unittest.TestCase):
    def test_weak_model_paraphrases_are_normalized_into_a_validated_patch(self) -> None:
        response, _ = run_agent(make_request(), [
            step("Update_Controls", {"chartType": "X-bar R", "yColumns": "a, b", "xAxisColumn": "date", "sampleSize": "9", "reason": "subgroups"}),
            step("Finish"),
            final("- Switched to an X-bar R chart using A and B as one subgroup per row."),
        ])

        patch_ = response.controlPatch
        self.assertEqual(response.status, "ok")
        self.assertEqual(response.stopReason, "finish")
        self.assertEqual(patch_["chartType"], "xBarR")
        self.assertEqual(patch_["yColumns"], ["A", "B"])
        self.assertEqual(patch_["xAxisColumn"], "Date")
        self.assertEqual(patch_["sampleSize"], 2)
        self.assertIn({"field": "chartType", "from": "individual", "to": "xBarR"}, patch_["changes"])
        self.assertTrue(any("locked to 2" in warning for warning in patch_["warnings"]))
        self.assertNotIn("unverifiedChangeClaim", response.warnings)

    def test_single_malformed_step_is_recovered_with_a_format_hint(self) -> None:
        response, lm = run_agent(make_request("What chart fits column A?"), [
            "I think an individuals chart is right.",
            step("finish"),
            final("- An I-MR chart fits single readings of A."),
        ])

        self.assertEqual(response.status, "ok")
        self.assertEqual(response.stopReason, "finish")
        self.assertIn("FORMAT ERROR", lm.prompts[1])
        self.assertIsNone(response.controlPatch)

    def test_unformatted_final_answer_is_rescued_without_inventing_changes(self) -> None:
        response, _ = run_agent(make_request("What chart fits column A?"), [
            "garbage one",
            "garbage two",
            "An I-MR chart fits individual readings of A.",
        ])

        self.assertEqual(response.status, "ok")
        self.assertEqual(response.stopReason, "format_error")
        self.assertIn("An I-MR chart fits individual readings of A.", response.content)
        self.assertIn("answerFormatRecovered", response.warnings)
        self.assertIn("agentStopped:format_error", response.warnings)
        self.assertIsNone(response.controlPatch)

    def test_total_model_failure_returns_deterministic_fallback_with_app_evidence(self) -> None:
        response, _ = run_agent(make_request("Is the process capable?"), [
            "garbage one",
            "garbage two",
            "[[ ## reasoning ## ]]\nthinking without an answer",
        ])

        self.assertEqual(response.status, "fallback")
        self.assertIn("No chart settings were changed", response.content)
        self.assertIn("App-computed evidence", response.content)
        self.assertIn("1.23", response.content)
        self.assertIsNone(response.controlPatch)
        self.assertFalse(response.needsClarification)

    def test_validated_changes_survive_a_failed_final_summary_with_deterministic_summary(self) -> None:
        response, _ = run_agent(make_request("Use an X-bar S chart for A and B"), [
            step("update_controls", {"chartType": "xBarS", "yColumns": ["A", "B"]}),
            "garbage",
            "garbage",
            "Done.",
        ])

        self.assertEqual(response.controlPatch["chartType"], "xBarS")
        self.assertIn("Applied changes (validated by the app)", response.content)
        self.assertIn("chartType: individual → xBarS", response.content)

    def test_repeated_identical_calls_stop_the_loop(self) -> None:
        call = step("read_controls", {"include": ["current"]})
        response, lm = run_agent(make_request("What are my settings?"), [call, call, call, final("- Chart: individual on A.")], SPCAgentHarness(max_iters=6))

        self.assertEqual(response.stopReason, "repeated_calls")
        self.assertEqual(len(lm.prompts), 4)

    def test_context_window_overflow_retries_once_with_minimal_context(self) -> None:
        overflow = litellm.ContextWindowExceededError(message="context window exceeded", model="scripted", llm_provider="openai")
        response, lm = run_agent(make_request("Explain the chart"), [overflow, overflow, step("finish"), final("- Short answer.")])

        self.assertEqual(response.status, "ok")
        self.assertIn("contextReduced", response.warnings)
        self.assertLess(len(lm.prompts[2]), len(lm.prompts[0]))

    def test_upstream_errors_propagate_instead_of_becoming_fake_answers(self) -> None:
        rate_limited = litellm.RateLimitError(message="429 Too Many Requests", model="scripted", llm_provider="openai")
        with self.assertRaises(litellm.RateLimitError):
            run_agent(make_request("Explain the chart"), [rate_limited])

        error = upstream_http_error(rate_limited, "agent request")
        self.assertEqual(error.status_code, 429)


class GroundingGuardsTest(unittest.TestCase):
    def test_unverified_change_claim_is_flagged(self) -> None:
        response, _ = run_agent(make_request("Switch to X-bar R"), [
            step("finish"),
            final("- I've switched the chart to X-bar R."),
        ])

        self.assertIsNone(response.controlPatch)
        self.assertIn("unverifiedChangeClaim", response.warnings)
        self.assertIn("no chart settings were changed", response.content)

    def test_numbers_not_computed_by_the_app_are_flagged(self) -> None:
        response, _ = run_agent(make_request("How capable is the process?"), [
            step("finish"),
            final("- Cpk is 1.23 (preliminary) but Ppk is 0.71."),
        ])

        self.assertEqual(response.grounding["ungroundedNumbers"], ["0.71"])
        self.assertIn("ungroundedNumbers", response.warnings)

    def test_requested_evidence_is_appended_from_app_values(self) -> None:
        response, _ = run_agent(make_request("Which rules fired?"), [step("finish"), final("- Two Nelson tests fired.")])

        self.assertIn("Nelson (8 tests)", response.content)
        self.assertIn("| 2: 9 consecutive points on the same side of the centerline | 2 | 11 | #29, #31 |", response.content)
        self.assertIn("MR", response.content)
        self.assertEqual(response.evidence["rules"]["signalCount"], 3)

    def test_ungrounded_number_detection_ignores_code_and_accepts_rounding(self) -> None:
        references = [1.2345, 0.1128, 12.5]
        text = "Cpk 1.23, MR-bar 0.113, share 12.5%, bad 3.14\n```html\n<p>9.99</p>\n```"
        self.assertEqual(find_ungrounded_numbers(text, sorted(references)), ["3.14"])


class HtmlBlockTest(unittest.TestCase):
    def test_unsafe_and_unclosed_html_blocks_are_removed(self) -> None:
        unsafe = "Intro\n```html\n<script>fetch('https://x.example')</script>\n```"
        cleaned, warnings = sanitize_html_blocks(unsafe)
        self.assertNotIn("fetch", cleaned)
        self.assertTrue(any("network call" in warning for warning in warnings))

        external = "```html\n<script src=\"https://cdn.example/x.js\"></script>\n```"
        self.assertNotIn("cdn.example", sanitize_html_blocks(external)[0])

        parent = "```html\n<script>window.parent.postMessage('x','*')</script>\n```"
        self.assertNotIn("postMessage", sanitize_html_blocks(parent)[0])

        truncated, warnings = sanitize_html_blocks("Here:\n```html\n<div><script>var a = 1")
        self.assertNotIn("<script>", truncated)
        self.assertIn("htmlBlockRemoved: unclosed block", warnings)

    def test_safe_html_block_is_kept_and_only_one_is_allowed(self) -> None:
        block = "```html\n<div id=\"x\"></div><script>document.getElementById('x').textContent='hi'</script>\n```"
        cleaned, warnings = sanitize_html_blocks(f"{block}\n{block}")
        self.assertEqual(cleaned.count("```html"), 1)
        self.assertEqual(warnings, ["htmlBlockRemoved: only one interactive block is allowed per answer"])

    def test_model_html_is_preserved_when_valid(self) -> None:
        block = "```html\n<p id=\"demo\">Zones</p><script>document.getElementById('demo').title='z'</script>\n```"
        response, _ = run_agent(make_request("Show an interactive demo of sigma zones"), [step("finish"), final(f"- Demo below.\n\n{block}")])

        self.assertIn(block, response.content)
        self.assertNotIn("htmlVisualFallback", response.warnings)

    def test_deterministic_capability_visual_replaces_missing_model_html(self) -> None:
        response, _ = run_agent(make_request("Give me an interactive capability what-if"), [step("finish"), final("- Move the mean to see Cpk change.")])

        self.assertIn("htmlVisualFallback", response.warnings)
        self.assertEqual(response.content.count("```html"), 1)
        self.assertIn("Capability what-if", response.content)
        self.assertIn('"lsl": 9.5', response.content)

    def test_deterministic_rules_visual_replaces_unsafe_model_html_in_hebrew(self) -> None:
        unsafe = "```html\n<script>fetch('/steal')</script>\n```"
        request = make_request("הדגמה אינטראקטיבית של החוקים", language="he")
        response, _ = run_agent(request, [step("finish"), final(f"- הנה הדגמה.\n\n{unsafe}")])

        self.assertNotIn("fetch(", response.content)
        self.assertIn("htmlVisualFallback", response.warnings)
        self.assertIn('dir="rtl"', response.content)
        self.assertIn('"count": 2', response.content)

    def test_visual_unavailable_without_specs_is_reported_not_faked(self) -> None:
        request = make_request("interactive capability demo", controls={"lowerSpecLimit": None, "upperSpecLimit": None})
        response, _ = run_agent(request, [step("finish"), final("- Add specification limits first.")])

        self.assertNotIn("```html", response.content)
        self.assertIn("htmlVisualUnavailable", response.warnings)

    def test_unrelated_interactive_requests_are_not_answered_with_the_rules_explorer(self) -> None:
        for message in ("Give me an interactive EWMA weighting demo", "Build an interactive scatter plot playground"):
            with self.subTest(message=message):
                response, _ = run_agent(make_request(message), [step("finish"), final("- Here is how it works in words.")])
                self.assertNotIn("```html", response.content)
                self.assertIn("htmlVisualUnavailable", response.warnings)
                self.assertNotIn("htmlVisualFallback", response.warnings)


class TrustedPatchValidationTest(unittest.TestCase):
    def session(self, request: AgentTurnRequest | None = None) -> SPCAgentToolSession:
        return SPCAgentToolSession(request or make_request(), SPCAgentHarness().tool_metadata)

    def test_attribute_charts_must_fit_the_column_profile(self) -> None:
        session = self.session()
        result = json.loads(session.update_controls(chartType="pChart", yColumns=["Defects"]))
        self.assertFalse(result["ok"])
        self.assertIn("proportions", result["rejected"][0]["reason"])
        self.assertNotIn("chartType", session.patch)

        result = json.loads(session.update_controls(chartType="cChart", yColumns=["Offset"]))
        self.assertIn("non-negative integer counts", result["rejected"][0]["reason"])

        result = json.loads(session.update_controls(chartType="pChart", yColumns=["Defects"], denominatorColumn="Units"))
        self.assertTrue(result["ok"])
        self.assertEqual(session.patch["chartType"], "pChart")

    def test_np_chart_clears_denominator_and_checks_subgroup_size(self) -> None:
        session = self.session(make_request(controls={"chartType": "pChart", "yColumns": ["Defects"], "denominatorColumn": "Units", "sampleSize": 50}))
        result = json.loads(session.update_controls(chartType="np"))
        self.assertTrue(result["ok"])
        self.assertIsNone(session.patch["denominatorColumn"])
        self.assertTrue(any("NP charts use a constant subgroup size" in warning for warning in result["warnings"]))

        tight = self.session(make_request(controls={"yColumns": ["Defects"], "sampleSize": 5}))
        result = json.loads(tight.update_controls(chartType="npChart"))
        self.assertIn("above subgroup size", result["rejected"][0]["reason"])

    def test_invalid_columns_specs_and_non_numeric_y_are_rejected(self) -> None:
        session = self.session()
        result = json.loads(session.update_controls(yColumns=["Date"], denominatorColumn="Offset", lowerSpecLimit=1, mystery=True))
        reasons = {entry["field"]: entry["reason"] for entry in result["rejected"]}
        self.assertIn("no numeric values", reasons["yColumns"])
        self.assertIn("positive values", reasons["denominatorColumn"])
        self.assertIn("Specification limits", reasons["lowerSpecLimit"])
        self.assertIn("Unknown field", reasons["mystery"])
        self.assertEqual(session.patch["applied"], [])

    def test_no_op_updates_produce_no_patch_and_rule_set_is_normalized(self) -> None:
        session = self.session()
        result = json.loads(session.update_controls(chartType="individual", showSigma1="true"))
        self.assertEqual(result["unchanged"], ["chartType", "showSigma1"])
        self.assertEqual(session.patch, {})

        result = json.loads(session.update_controls(ruleSet="Western Electric"))
        self.assertEqual(session.patch["ruleSet"], "westernElectric")

        legacy = self.session(make_request(controls={"ruleSet": None}))
        result = json.loads(legacy.update_controls(ruleSet="nelson"))
        self.assertIn("does not expose", result["rejected"][0]["reason"])

    def test_update_calls_are_bounded(self) -> None:
        session = self.session()
        for title in ("a", "b", "c", "d"):
            session.update_controls(chartLabel=title)
        result = json.loads(session.update_controls(chartLabel="e"))
        self.assertFalse(result["ok"])
        self.assertIn("Update limit", result["error"])
        self.assertEqual(session.patch["chartLabel"], "d")

    def test_chart_type_aliases(self) -> None:
        self.assertEqual(normalize_chart_type("I-MR chart"), "individual")
        self.assertEqual(normalize_chart_type("X̄-S"), "xBarS")
        self.assertEqual(normalize_chart_type("x bar & R"), "xBarR")
        self.assertEqual(normalize_chart_type("U chart"), "uChart")
        self.assertIsNone(normalize_chart_type("pie chart"))


class EvidenceAndContextTest(unittest.TestCase):
    def test_rule_summary_prefers_exact_signal_counts(self) -> None:
        records = [
            {"ruleNumber": 2, "index": i, "signalCount": 1 if i in (8, 9) else 0, "signals": [{"signalIndex": 8}]}
            for i in range(10)
        ]
        summary = summarize_rule_violations(records, "nelson")
        self.assertEqual(summary["rules"][0]["signalCount"], 2)
        self.assertEqual(summary["rules"][0]["pointCount"], 10)
        self.assertEqual(summary["rules"][0]["signalIndices"], [8, 9])

        legacy = summarize_rule_violations([{"ruleNumber": 1, "index": 3}, {"ruleNumber": 1, "index": 7}], "westernElectric")
        self.assertFalse(legacy["exactSignalCounts"])
        self.assertEqual(legacy["ruleSet"], "westernElectric")

    def test_legacy_processed_payload_is_reduced_without_arrays(self) -> None:
        processed = {
            "statistics": {"mean": 0.1},
            "ruleViolationCount": 4,
            "controlLimits": {"centerLine": 0.1, "ucl": 0.2, "lcl": 0.0, "sigma": 0.03, "uclSeries": [0.2, 0.25, 0.18], "chartValues": list(range(5000))},
            "ruleViolations": [{"ruleNumber": 1, "index": 4, "signalCount": 1}],
        }
        evidence = build_spc_evidence(make_request(processed=processed))
        self.assertEqual(evidence["limits"]["variableLimits"]["ucl"], {"min": 0.18, "max": 0.25})
        self.assertEqual(evidence["rules"]["signalCount"], 1)
        self.assertLess(len(evidence_prompt_text(evidence)), 2500)

    def test_evidence_text_labels_sigma_and_rule_set(self) -> None:
        text = evidence_prompt_text(build_spc_evidence(make_request()))
        self.assertIn("within-process sigma=0.1 (MR-bar/d2 (n=2))", text)
        self.assertIn("RULE SIGNALS(app) (Nelson (8 tests)): 3 signal(s)", text)
        self.assertIn("MR CHART SIGNALS(app)", text)
        self.assertIn("Cpk=1.23", text)

    def test_history_is_bounded_and_keeps_app_verification_trailer(self) -> None:
        long_answer = "x" * 5000 + "\n\n[App verification: applied chartType individual -> xBarR.]"
        messages = [
            {"role": "system", "content": "SYSTEM PROMPT"},
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": long_answer},
            {"role": "user", "content": "latest question"},
        ]
        context = SPCAgentHarness._message_context(make_request(messages=messages).messages)
        self.assertNotIn("SYSTEM PROMPT", context)
        self.assertNotIn("latest question", context)
        self.assertIn("[App verification: applied chartType individual -> xBarR.]", context)
        self.assertLess(len(context), 1500)

    def test_knowledge_selection_uses_word_boundaries_and_core_rules(self) -> None:
        loader = SPCKnowledgeLoader()
        selection = loader.select_for_text("Is there a pattern in my Nelson rule signals?", chart_type="individual")
        self.assertIn("control-chart-rules.md", selection.sources)
        self.assertNotIn("pharma-cpv-pat.md", selection.sources)
        self.assertTrue(selection.markdown.startswith("# Core SPC rules"))

        missing = SPCKnowledgeLoader(root=Path(__file__).parent / "no-such-dir")
        self.assertIn("Specification limits", missing.select_for_text("capability").markdown)

    def test_shallow_container_paths_do_not_crash(self) -> None:
        self.assertIsNone(_ancestor(Path("/app/main.py"), 2))

    def test_rescue_extracts_answer_section_or_plain_text(self) -> None:
        self.assertEqual(rescue_answer_from_raw("[[ ## reasoning ## ]]\nr\n\n[[ ## answer ## ]]\nA\n\n[[ ## completed ## ]]"), "A")
        self.assertEqual(rescue_answer_from_raw('{"answer": "B"}'), "B")
        self.assertEqual(rescue_answer_from_raw("plain C"), "plain C")


class GatewayIntegrationTest(unittest.TestCase):
    def test_agent_turn_uses_thread_local_lm_and_keeps_response_contract(self) -> None:
        gateway_instance = DSPyGateway()
        gateway_instance._lm = ScriptedLM([step("finish"), final("- Hello! Ask me about your chart.")])
        gateway_instance._agent_harness = SPCAgentHarness()
        with patch.object(DSPyGateway, "_configure", return_value=None), patch.dict(os.environ, {"DSPY_AGENT_MAX_TOKENS": "256"}):
            response = gateway_instance.agent_turn(make_request("hi"))

        for key in ("content", "controlPatch", "toolTrace", "knowledgeSources", "needsClarification", "model", "usage"):
            self.assertIn(key, response)
        self.assertEqual(response["status"], "ok")
        self.assertIsNone(response["controlPatch"])

    def test_configure_never_touches_global_dspy_settings(self) -> None:
        gateway_instance = DSPyGateway()
        gateway_instance._env_mtime = ENV_PATH.stat().st_mtime if ENV_PATH.is_file() else None
        env = {"AI_MODEL": "openai/test-model", "AI_API_KEY": "test-key", "AI_API_URL": "https://offline.invalid/v1", "AI_API_BASE": "", "DSPY_API_BASE": "", "AI_PROVIDER": "", "LITELLM_LOCAL_MODEL_COST_MAP": "true"}
        with patch.dict(os.environ, env, clear=True), patch.object(gateway_instance, "_reload_env_if_changed"), patch.object(dspy, "configure", side_effect=AssertionError("global configure")):
            gateway_instance._configure()
        self.assertIsNotNone(gateway_instance._lm)

    def test_http_errors_are_not_swallowed_into_500(self) -> None:
        payload = ChatCompletionRequest(
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": "read_controls", "parameters": {"type": "object"}}}],
            stream=True,
        )
        with self.assertRaises(HTTPException) as raised:
            chat_completions(payload, authorization=f"Bearer {DEFAULT_GATEWAY_API_KEY}")
        self.assertEqual(raised.exception.status_code, 400)

        with self.assertRaises(HTTPException) as raised:
            chat_completions(payload, authorization="Bearer wrong")
        self.assertEqual(raised.exception.status_code, 401)

    def test_upstream_error_mapping(self) -> None:
        overflow = litellm.ContextWindowExceededError(message="context window exceeded", model="m", llm_provider="openai")
        auth = litellm.AuthenticationError(message="Incorrect API key", model="m", llm_provider="openai")
        timeout = litellm.Timeout(message="Request timed out", model="m", llm_provider="openai")
        self.assertEqual(upstream_http_error(overflow, "request").status_code, 413)
        self.assertEqual(upstream_http_error(auth, "request").status_code, 502)
        self.assertEqual(upstream_http_error(timeout, "request").status_code, 504)
        self.assertEqual(upstream_http_error(RuntimeError("Missing AI_MODEL. Set it"), "request").status_code, 503)
        passthrough = HTTPException(status_code=400, detail="bad")
        self.assertIs(upstream_http_error(passthrough, "request"), passthrough)


class SampleSizeContractTest(unittest.TestCase):
    def test_attribute_sizes_and_fractional_u_opportunities_survive_the_agent_contract(self):
        for chart_type, size in [('npChart', 500), ('uChart', 0.5)]:
            with self.subTest(chart=chart_type):
                request = make_request(controls={'chartType': chart_type, 'yColumns': ['Defects'], 'sampleSize': size})
                session = SPCAgentToolSession(request, SPCAgentHarness().tool_metadata)
                result = json.loads(session.update_controls(sampleSize=size * 2))
                self.assertTrue(result['ok'])
                self.assertEqual(session.patch['sampleSize'], size * 2)
        request = make_request(controls={'chartType': 'uChart', 'yColumns': ['Defects'], 'sampleSize': 0.5})
        self.assertEqual(request.controls.sampleSize, 0.5)

    def test_chart_switch_uses_target_chart_sample_bounds(self):
        session = SPCAgentToolSession(make_request(), SPCAgentHarness().tool_metadata)
        result = json.loads(session.update_controls(chartType='npChart', yColumns=['Defects'], sampleSize=500))
        self.assertTrue(result['ok'])
        self.assertEqual(session.patch['sampleSize'], 500)

    def test_tool_contract_and_read_controls_describe_the_chart_specific_rule(self) -> None:
        schema = TOOL_PARAMETER_SCHEMAS["update_controls"]["properties"]["sampleSize"]
        self.assertEqual(schema["type"], ["number", "null"])
        self.assertEqual(schema["exclusiveMinimum"], 0)
        expected = {
            "npChart": (500, {"integer": True, "min": 1, "max": MAX_SAFE_INTEGER}),
            "uChart": (0.5, {"integer": False, "min": 0, "exclusiveMinimum": True}),
            "xBarR": (5, {"integer": True, "min": 2, "max": 25}),
        }
        for chart_type, (size, rule) in expected.items():
            with self.subTest(chart=chart_type):
                session = SPCAgentToolSession(make_request(controls={"chartType": chart_type, "yColumns": ["Defects"], "sampleSize": size}), SPCAgentHarness().tool_metadata)
                available = json.loads(session.read_controls(include=["available"]))["snapshot"]["available"]["sampleSize"]
                self.assertEqual(available["current"], size)
                self.assertEqual(available["effective"], size)
                for key, value in rule.items():
                    self.assertEqual(available[key], value)

    def test_invalid_sizes_for_the_target_chart_are_rejected_not_clamped(self) -> None:
        cases = [
            ({"chartType": "npChart", "yColumns": ["Defects"], "sampleSize": 50}, {"sampleSize": 12.5}, "whole number"),
            ({"chartType": "uChart", "yColumns": ["Defects"], "sampleSize": 0.5}, {"sampleSize": 0}, "greater than 0"),
            ({"chartType": "xBarR", "yColumns": ["A"], "sampleSize": 5}, {"sampleSize": 30}, "2 to 25"),
            # Switching away from NP n=500 without a new size: 500 is not a valid X-bar subgroup size.
            ({"chartType": "npChart", "yColumns": ["Defects"], "sampleSize": 500}, {"chartType": "xBarR", "yColumns": ["A"]}, "2 to 25"),
        ]
        for controls, update, reason in cases:
            with self.subTest(update=update):
                session = SPCAgentToolSession(make_request(controls=controls), SPCAgentHarness().tool_metadata)
                result = json.loads(session.update_controls(**update))
                self.assertFalse(result["ok"])
                self.assertIn(reason, result["rejected"][0]["reason"])
                for field in update:
                    self.assertNotIn(field, session.patch.get("applied", []))
                self.assertEqual(session.current["sampleSize"], controls["sampleSize"])


class StaleAnalysisTest(unittest.TestCase):
    def session(self, request: AgentTurnRequest | None = None) -> SPCAgentToolSession:
        return SPCAgentToolSession(request or make_request(), SPCAgentHarness().tool_metadata)

    def test_diagnostics_stop_reporting_the_original_analysis_after_an_analytical_change(self) -> None:
        changes = [
            {"chartType": "xBarR", "yColumns": ["A", "B"]},
            {"yColumns": ["B"]},
            {"xAxisColumn": "Date"},
            {"ruleSet": "westernElectric"},
            {"chartType": "xBarR", "sampleSize": 4},
        ]
        for update in changes:
            with self.subTest(update=update):
                session = self.session()
                self.assertTrue(json.loads(session.update_controls(**update))["ok"])
                self.assertTrue(session.stale_fields)
                diagnostics = session.read_spc_diagnostics()
                result = json.loads(diagnostics)
                self.assertFalse(result["available"])
                self.assertTrue(result["analysisStale"])
                self.assertNotIn("diagnostics", result)
                snapshot = json.loads(session.read_controls(include=["processed", "diagnostics"]))["snapshot"]
                self.assertTrue(snapshot["processed"]["analysisStale"])
                self.assertTrue(snapshot["diagnostics"]["analysisStale"])
                for stale_number in ("10.3", "1.23", "0.368"):
                    self.assertNotIn(stale_number, diagnostics)
                    self.assertNotIn(stale_number, json.dumps(snapshot))

    def test_cosmetic_changes_keep_the_analysis_current(self) -> None:
        session = self.session()
        result = json.loads(session.update_controls(chartLabel="Line 4", showSigma1=False, colorScheme="ocean"))
        self.assertTrue(result["ok"])
        self.assertNotIn("analysis", result)
        self.assertEqual(session.stale_fields, [])
        diagnostics = json.loads(session.read_spc_diagnostics(include=["controlLimits"]))
        self.assertTrue(diagnostics["available"])
        self.assertEqual(diagnostics["diagnostics"]["controlLimits"]["ucl"], 10.3)

        # A label change on a multi-column X-bar chart must not rewrite the stored subgroup size.
        xbar = self.session(make_request(controls={"chartType": "xBarR", "yColumns": ["A", "B"], "sampleSize": 5}))
        xbar.update_controls(chartLabel="Subgroups")
        self.assertEqual(xbar.patch["applied"], ["chartLabel"])
        self.assertEqual(xbar.stale_fields, [])

    def test_final_answer_after_an_analytical_change_never_reports_the_old_analysis(self) -> None:
        response, lm = run_agent(make_request("Switch to X-bar R for A and B and tell me the Cpk"), [
            step("read_spc_diagnostics"),
            step("update_controls", {"chartType": "xBarR", "yColumns": ["A", "B"]}),
            step("finish"),
            final("- Switched to X-bar R. Cpk is 1.23 and UCL is 10.3, so the process is capable."),
        ])

        self.assertEqual(response.controlPatch["chartType"], "xBarR")
        for stale_number in ("1.23", "10.3"):
            self.assertNotIn(stale_number, response.content)
        self.assertIn("analysisStale", response.warnings)
        self.assertIn("staleNumbersRemoved", response.warnings)
        self.assertEqual(response.grounding["removedStaleNumbers"], ["1.23", "10.3"])
        self.assertIn("chartType: individual → xBarR", response.content)
        self.assertIn("recalculates", response.content)
        self.assertNotIn("App-computed evidence", response.content)
        self.assertTrue(response.evidence["stale"])
        self.assertEqual(response.evidence["chart"]["chartType"], "xBarR")
        self.assertNotIn("capability", response.evidence)
        # The final-answer call saw the pending settings and a stale notice, not the old evidence block.
        self.assertIn("APP ANALYSIS: out of date", lm.prompts[-1])
        self.assertNotIn("CONTROL LIMITS(app)", lm.prompts[-1])

    def test_stale_turn_keeps_number_free_prose_and_withholds_the_app_visual(self) -> None:
        response, _ = run_agent(make_request("Switch to X-bar R for A and B and show an interactive rules demo"), [
            step("update_controls", {"chartType": "xBarR", "yColumns": ["A", "B"]}),
            step("finish"),
            final("- Switched to X-bar R so each row is one subgroup."),
        ])

        self.assertIn("Switched to X-bar R so each row is one subgroup.", response.content)
        self.assertNotIn("staleNumbersRemoved", response.warnings)
        self.assertIn("htmlVisualUnavailable", response.warnings)
        self.assertNotIn("```html", response.content)

    def test_cosmetic_turn_still_appends_current_evidence(self) -> None:
        response, _ = run_agent(make_request("Rename the chart to Line A and tell me which rules fired"), [
            step("update_controls", {"chartLabel": "Line A"}),
            step("finish"),
            final("- Two Nelson tests fired: rule 1 once and rule 2 twice."),
        ])

        self.assertEqual(response.controlPatch["chartLabel"], "Line A")
        self.assertNotIn("analysisStale", response.warnings)
        self.assertIn("| 2: 9 consecutive points on the same side of the centerline | 2 | 11 | #29, #31 |", response.content)
        self.assertEqual(response.evidence["rules"]["signalCount"], 3)


class SetupCompatibilityTest(unittest.TestCase):
    def session(self, request: AgentTurnRequest | None = None) -> SPCAgentToolSession:
        return SPCAgentToolSession(request or make_request(), SPCAgentHarness().tool_metadata)

    def test_analytical_change_that_breaks_the_current_chart_is_rejected_but_cosmetics_apply(self) -> None:
        session = self.session(make_request(controls={"chartType": "pChart", "yColumns": ["Defects"], "denominatorColumn": "Units", "sampleSize": 50}))
        result = json.loads(session.update_controls(yColumns=["A"], chartLabel="Line 4 yield"))

        self.assertFalse(result["ok"])
        self.assertEqual([entry["field"] for entry in result["rejected"]], ["yColumns"])
        self.assertIn("non-negative integer counts in 'A'", result["rejected"][0]["reason"])
        self.assertNotIn("yColumns", session.patch)
        self.assertEqual(session.patch["chartLabel"], "Line 4 yield")
        self.assertEqual(session.stale_fields, [])

        np_session = self.session(make_request(controls={"chartType": "npChart", "yColumns": ["Defects"], "sampleSize": 50}))
        result = json.loads(np_session.update_controls(sampleSize=5))
        self.assertIn("above subgroup size", result["rejected"][0]["reason"])
        self.assertNotIn("sampleSize", np_session.patch)

    def test_rejected_setup_rolls_back_every_fit_field_of_the_call(self) -> None:
        session = self.session()
        result = json.loads(session.update_controls(chartType="pChart", yColumns=["Defects"], sampleSize=40, showSigma2=False))

        self.assertEqual({entry["field"] for entry in result["rejected"]}, {"chartType", "yColumns", "sampleSize"})
        self.assertEqual(session.patch["applied"], ["showSigma2"])
        self.assertEqual(session.current["yColumns"], ["A"])

    def test_p_chart_denominators_must_be_positive_whole_numbers(self) -> None:
        session = self.session()
        result = json.loads(session.update_controls(chartType="pChart", yColumns=["Defects"], denominatorColumn="Area"))
        self.assertFalse(result["ok"])
        self.assertIn("positive whole numbers", result["rejected"][0]["reason"])
        self.assertEqual(session.patch["applied"], [])

        # U charts take fractional units per row (for example inspected area).
        result = json.loads(session.update_controls(chartType="uChart", yColumns=["Defects"], denominatorColumn="Area"))
        self.assertTrue(result["ok"])
        self.assertEqual(session.patch["denominatorColumn"], "Area")


class ColumnProfileCoverageTest(unittest.TestCase):
    def legacy_request(self) -> AgentTurnRequest:
        # A pre-full-scan client: profiles sampled from the first rows, and some headers never profiled.
        sampled = [dict(profile, sampled=True) for profile in COLUMN_PROFILES]
        sampled.append({"name": "Late", "numeric": 0, "nonNumeric": 5000, "missing": 0, "integerLike": False, "nonNegative": False, "min": None, "max": None, "sampled": True})
        headers = [*HEADERS, "Late", "Extra"]
        return make_request(availableHeaders=headers, dataset={"rowCount": 9000, "columnCount": len(headers), "headers": headers, "columnProfiles": sampled})

    def test_sampled_or_missing_profiles_cannot_affirm_a_column(self) -> None:
        session = SPCAgentToolSession(self.legacy_request(), SPCAgentHarness().tool_metadata)

        result = json.loads(session.update_controls(yColumns=["Late"]))
        reason = result["rejected"][0]["reason"]
        self.assertIn("Cannot verify that 'Late'", reason)
        self.assertIn("only part of the rows", reason)
        self.assertNotIn("no numeric values", reason)

        result = json.loads(session.update_controls(yColumns=["Extra"]))
        self.assertIn("no column profile", result["rejected"][0]["reason"])

        # A sample can confirm "has numbers" but not "only whole-number counts".
        result = json.loads(session.update_controls(chartType="cChart", yColumns=["Defects"]))
        self.assertIn("Cannot verify that 'Defects' holds non-negative whole-number counts", result["rejected"][0]["reason"])
        # ...while a counterexample seen in the sample is conclusive.
        result = json.loads(session.update_controls(chartType="cChart", yColumns=["Offset"]))
        self.assertIn("non-negative integer counts in 'Offset'", result["rejected"][0]["reason"])
        self.assertEqual(session.patch["applied"], [])

        available = json.loads(session.read_controls(include=["available"]))["snapshot"]["available"]
        self.assertEqual(available["unverifiedHeaders"], [*HEADERS, "Late", "Extra"])

    def test_full_profiles_verify_every_header(self) -> None:
        session = SPCAgentToolSession(make_request(), SPCAgentHarness().tool_metadata)
        available = json.loads(session.read_controls(include=["available"]))["snapshot"]["available"]
        self.assertIsNone(available["unverifiedHeaders"])
        self.assertNotIn("Date", available["numericHeaders"])


class NumericGroundingTest(unittest.TestCase):
    REFERENCES = sorted([1.2345, 10.3, 40.0, 0.1128])

    def test_meaningful_integers_and_wrong_signs_are_flagged(self) -> None:
        self.assertEqual(find_ungrounded_numbers("Cpk is 999 across 40 points.", self.REFERENCES), ["999"])
        self.assertEqual(find_ungrounded_numbers("Cpk is 3.", self.REFERENCES), ["3"])
        self.assertEqual(find_ungrounded_numbers("Cpk is -1.23 and LCL is −10.3.", self.REFERENCES), ["-1.23", "−10.3"])
        self.assertEqual(find_ungrounded_numbers("Cpk is 1.23, UCL is 10.3, MR-bar 0.113, 1,000 rows.", self.REFERENCES), ["1,000"])

    def test_rule_numbers_sigma_multiples_and_labels_are_not_flagged(self) -> None:
        benign = (
            "1. Nelson rules 1, 2 and 5 fired; Western Electric rule 4 and tests 7-8 did not.\n"
            "2. Watch points beyond ±3 sigma, the 2-sigma zone, 1σ bands, and a 1.5 sigma shift.\n"
            "15. Use 2 columns and the top 3 candidates; point #29 on 2024-01-15 at 10:30 in column Sample 12; lag-1 is low."
        )
        self.assertEqual(find_ungrounded_numbers(benign, self.REFERENCES, ["Sample 12"]), [])

    def test_harness_flags_an_invented_integer_statistic(self) -> None:
        response, _ = run_agent(make_request("How capable is the process?"), [step("finish"), final("- Cpk is 999, far above target.")])
        self.assertEqual(response.grounding["ungroundedNumbers"], ["999"])
        self.assertIn("ungroundedNumbers", response.warnings)


class ModelErrorPropagationTest(unittest.TestCase):
    def test_non_parser_value_error_propagates_as_an_upstream_error(self) -> None:
        provider_error = ValueError("Unsupported parameter: 'response_format' is not supported by this model")
        with self.assertRaises(ValueError):
            run_agent(make_request("Explain the chart"), [provider_error, step("finish"), final("- Should never be reached.")])
        self.assertEqual(upstream_http_error(provider_error, "agent request").status_code, 500)


class LatestRequestSizeTest(unittest.TestCase):
    ENV = {"DSPY_MAX_REQUEST_CHARS": str(DEFAULT_MAX_LATEST_REQUEST_CHARS), "AI_GATEWAY_API_KEY": "", "DSPY_GATEWAY_API_KEY": ""}

    def test_long_latest_request_reaches_the_model_in_full_on_both_attempts(self) -> None:
        marker = "FINAL-INSTRUCTION-MARKER: answer in one bullet"
        message = "Explain the chart. " + "Background note. " * 400 + marker
        self.assertGreater(len(message), 6000)
        overflow = litellm.ContextWindowExceededError(message="context window exceeded", model="scripted", llm_provider="openai")
        with patch.dict(os.environ, self.ENV):
            response, lm = run_agent(make_request(message), [overflow, overflow, step("finish"), final("- Short answer.")])

        self.assertIn("contextReduced", response.warnings)
        self.assertIn(marker, lm.prompts[0])
        self.assertIn(marker, lm.prompts[2])

    def test_oversize_latest_request_is_rejected_with_413_before_any_work(self) -> None:
        oversize = "x" * (DEFAULT_MAX_LATEST_REQUEST_CHARS + 1)
        request = make_request(oversize)
        gateway_instance = DSPyGateway()
        with patch.dict(os.environ, self.ENV), patch.object(DSPyGateway, "_configure", side_effect=AssertionError("configured")):
            with self.assertRaises(RequestTooLargeError):
                gateway_instance.agent_turn(request)
            with self.assertRaises(RequestTooLargeError):
                gateway_instance.answer(request.messages)
            with self.assertRaises(RequestTooLargeError):
                SPCAgentHarness().run(request, SPCKnowledgeLoader().select_for_text(""), "scripted")
            with self.assertRaises(HTTPException) as raised:
                agent_turn_endpoint(request, authorization=f"Bearer {DEFAULT_GATEWAY_API_KEY}")
            self.assertEqual(raised.exception.status_code, 413)
            self.assertIn(f"at most {DEFAULT_MAX_LATEST_REQUEST_CHARS}", raised.exception.detail)
            with self.assertRaises(HTTPException) as raised:
                chat_completions(ChatCompletionRequest(messages=[{"role": "user", "content": oversize}]), authorization=f"Bearer {DEFAULT_GATEWAY_API_KEY}")
            self.assertEqual(raised.exception.status_code, 413)


class HotReloadTest(unittest.TestCase):
    def test_reload_between_configure_and_run_keeps_request_local_handles(self) -> None:
        gateway_instance = DSPyGateway()
        lm = ScriptedLM([step("finish"), final("- Hello from the captured model.")])
        harness = SPCAgentHarness()

        def configure() -> None:
            gateway_instance._lm, gateway_instance._agent_harness = lm, harness
            gateway_instance._predictor, gateway_instance._model_name = object(), "captured"

        select = gateway_instance._knowledge_loader.select

        def reload_then_select(request: AgentTurnRequest) -> Any:
            # Another request notices a changed .env and resets the gateway mid-turn.
            gateway_instance._env_mtime = -1.0
            with patch("main.load_dotenv"), patch("main.sync_managed_env_from_root"), patch("main.configure_combined_ca_bundle"):
                gateway_instance._reload_env_if_changed()
            self.assertIsNone(gateway_instance._agent_harness)
            return select(request)

        with patch.object(gateway_instance, "_configure", side_effect=configure), \
                patch.object(gateway_instance._knowledge_loader, "select", side_effect=reload_then_select), \
                patch.dict(os.environ, {"DSPY_AGENT_MAX_TOKENS": "256"}):
            response = gateway_instance.agent_turn(make_request("hi"))

        self.assertEqual(response["status"], "ok")
        self.assertIn("Hello from the captured model.", response["content"])


class DeadlineTest(unittest.TestCase):
    def harness(self, clock: FakeClock) -> SPCAgentHarness:
        return SPCAgentHarness(max_iters=4, deadline_seconds=10, clock=clock)

    def test_late_finish_is_not_reported_and_extraction_is_not_started(self) -> None:
        clock = FakeClock()
        response, lm = run_agent(make_request("Explain the chart"), [after(clock, 11, step("finish")), final("- Too late to count.")], self.harness(clock))

        self.assertEqual(response.stopReason, "deadline")
        self.assertEqual(response.status, "fallback")
        self.assertEqual(len(lm.prompts), 1)
        self.assertIn("time limit reached", response.content)
        self.assertNotIn("Too late to count.", response.content)
        self.assertIn("agentStopped:deadline", response.warnings)

    def test_tool_requested_after_the_deadline_is_not_run(self) -> None:
        clock = FakeClock()
        late_update = after(clock, 11, step("update_controls", {"chartType": "xBarR", "yColumns": ["A", "B"]}))
        response, _ = run_agent(make_request("Use X-bar R for A and B"), [late_update], self.harness(clock))

        self.assertIsNone(response.controlPatch)
        self.assertEqual(response.toolTrace, [])
        self.assertEqual(response.stopReason, "deadline")

    def test_each_call_gets_the_remaining_budget_as_its_timeout(self) -> None:
        clock = FakeClock()
        response, lm = run_agent(make_request("What are my settings?"), [
            after(clock, 4, step("read_controls")),
            after(clock, 1, step("finish")),
            final("- Individual chart on A."),
        ], self.harness(clock))

        self.assertEqual(response.stopReason, "finish")
        self.assertEqual([kwargs.get("timeout") for kwargs in lm.call_kwargs], [10, 6, 5])


if __name__ == "__main__":
    unittest.main()