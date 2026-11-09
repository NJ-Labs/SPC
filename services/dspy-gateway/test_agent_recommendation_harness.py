import json
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from main import (
    AgentRecommendationHarness,
    AgentTurnRequest,
    ChatCompletionRequest,
    DEFAULT_GATEWAY_API_KEY,
    DSPyGateway,
    SPCAgentHarness,
    SPCAgentToolSession,
    SPCKnowledgeLoader,
    chat_completions,
    gateway,
)


class AgentRecommendationHarnessTest(unittest.TestCase):
    def test_recovers_xbar_s_recommendation_from_messy_answer(self) -> None:
        answer = """Switch to X-bar S chart to utilize all five available measurement columns per subgroup.
Use all five columns (Sample_1 through Sample_5) as Y-columns for accurate subgroup statistics.
The X-bar S chart provides superior sensitivity for detecting process shifts compared to Individual charts.
Ensure all five samples are collected under consistent conditions to maintain subgroup integrity.
{
  "recommendation": {
    "chartType": "xBarS",
    "yColumns": ["Sample_1", "Sample_2", "Sample_3", "Sample_4", "Sample_5"],
    "yColumn": null,
    "xAxisColumn": null,
    "sampleSize": 5,
    "chartLabel": "X-bar and S Control Chart",
    "zAxisLabel": "Subgroup Index",
    "yAxisLabel": "Measurement Value",
    "reason": "Utilizes all 5 available columns as subgroups

json
{"recommendation": {"chartType": null, "yColumns": [], "yColumn": null, "xAxisColumn": null, "sampleSize": null, "chartLabel": null, "zAxisLabel": null, "yAxisLabel": null, "reason": ""}}
"""

        envelope = AgentRecommendationHarness.build_envelope(answer)
        recommendation = envelope.recommendation

        self.assertEqual(recommendation.chartType, "xBarS")
        self.assertEqual(
            recommendation.yColumns,
            ["Sample_1", "Sample_2", "Sample_3", "Sample_4", "Sample_5"],
        )
        self.assertEqual(recommendation.sampleSize, 5)
        self.assertEqual(recommendation.chartLabel, "X-bar and S Control Chart")
        self.assertEqual(recommendation.zAxisLabel, "Subgroup Index")
        self.assertEqual(recommendation.yAxisLabel, "Measurement Value")

    def test_gateway_appends_one_final_json_block(self) -> None:
        response = DSPyGateway()._ensure_agent_mode_response(
            """- Use all five columns (Sample_1 through Sample_5).

```json
{"recommendation":{"chartType":null,"yColumns":[],"sampleSize":null,"reason":""}}
```

{"recommendation":{"chartType":"xBarS","yColumns":["Sample_1","Sample_2","Sample_3","Sample_4","Sample_5"],"sampleSize":5,"reason":"subgroups"}}
"""
        )

        blocks = re.findall(r"```json\s*([\s\S]*?)```", response, flags=re.IGNORECASE)

        self.assertEqual(len(blocks), 1)
        payload = json.loads(blocks[0])
        self.assertEqual(payload["recommendation"]["chartType"], "xBarS")
        self.assertEqual(payload["recommendation"]["sampleSize"], 5)
        self.assertNotIn('{"recommendation"', response[: response.rfind("```json")])

    def test_gateway_strips_malformed_recommendation_tail_from_visible_narrative(self) -> None:
        response = DSPyGateway()._ensure_agent_mode_response(
            """* Switch to X-bar R chart.

{
  "recommendation": {
    "chartType": "xBarR",
    "yColumns": ["Sample_1", "Sample_2"],
    "reason": "Subgroup

json
{"recommendation":{"chartType":"xBarR","yColumns":["Sample_1","Sample_2"],"sampleSize":2,"reason":"hidden"}}
"""
        )

        narrative = response[: response.rfind("```json")].strip()
        self.assertEqual(narrative, "* Switch to X-bar R chart.")
        self.assertNotIn("recommendation", narrative)


FULL_PROFILES = [
    {"name": "A", "numeric": 3, "nonNumeric": 0, "missing": 0, "integerLike": False, "nonNegative": True, "min": 1.0, "max": 2.5, "sampled": False},
    {"name": "B", "numeric": 3, "nonNumeric": 0, "missing": 0, "integerLike": False, "nonNegative": True, "min": 1.5, "max": 3.5, "sampled": False},
    {"name": "Date", "numeric": 0, "nonNumeric": 3, "missing": 0, "integerLike": False, "nonNegative": False, "min": None, "max": None, "sampled": False},
]


def build_agent_request(**overrides: object) -> AgentTurnRequest:
    payload = {
        "messages": [{"role": "user", "content": "Configure an X-bar R chart for A and B by Date"}],
        "language": "en",
        "controls": {
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
        },
        "availableHeaders": ["A", "B", "Date"],
        "worksheet": {"activeSheetIndex": 0, "activeSheetName": "Sheet1", "worksheetCount": 1},
        "dataset": {
            "summary": "Columns A, B, Date",
            "headers": ["A", "B", "Date"],
            "previewRows": [{"A": 1, "B": 2, "Date": "2024-01-01"}],
            "columnProfiles": FULL_PROFILES,
        },
        "processed": {"statistics": {"mean": 1.5}, "ruleViolationCount": 0},
        "selectedSheetIndex": 0,
    }
    payload.update(overrides)
    return AgentTurnRequest(**payload)


class SPCAgentToolsAndKnowledgeTest(unittest.TestCase):
    def test_tool_registry_exposes_expected_tools_with_markdown(self) -> None:
        harness = SPCAgentHarness()
        names = [tool.name for tool in harness.tool_metadata]

        self.assertEqual(names, ["list-tools", "read_controls", "read_spc_diagnostics", "update_controls"])
        for tool in harness.tool_metadata:
            self.assertTrue(tool.markdown.startswith("# "))
            self.assertIn("Purpose:", tool.markdown)
            self.assertTrue(tool.parameters)

    def test_read_controls_and_update_controls_return_validated_patch(self) -> None:
        harness = SPCAgentHarness()
        session = SPCAgentToolSession(build_agent_request(), harness.tool_metadata)

        snapshot = json.loads(session.read_controls(include=["current", "available"]))
        self.assertTrue(snapshot["ok"])
        self.assertEqual(snapshot["snapshot"]["current"]["chartType"], "individual")
        self.assertEqual(snapshot["snapshot"]["available"]["headers"], ["A", "B", "Date"])

        result = json.loads(session.update_controls(
            chartType="xBarR",
            yColumns=["A", "Missing", "B"],
            xAxisColumn="Date",
            sampleSize=9,
            chartLabel="XBar-R by Date",
            zAxisLabel="Collection Date",
        ))

        self.assertTrue(result["ok"])
        self.assertEqual(result["patch"]["chartType"], "xBarR")
        self.assertEqual(result["patch"]["yColumns"], ["A", "B"])
        self.assertEqual(result["patch"]["xAxisColumn"], "Date")
        self.assertEqual(result["patch"]["sampleSize"], 2)
        self.assertIn("yColumns", result["applied"])

    def test_read_spc_diagnostics_returns_processed_profile(self) -> None:
        request = build_agent_request(processed={
            "statistics": {"mean": 1.5},
            "ruleViolationCount": 0,
            "dataProfile": {"dataKind": "count", "numericCount": 3},
            "diagnostics": [{"code": "small-baseline", "severity": "warning", "message": "short"}],
            "chartRecommendations": [{"chartType": "uChart", "score": 92}],
            "capabilityStatus": {"readiness": "notApplicable"},
        })
        harness = SPCAgentHarness()
        session = SPCAgentToolSession(request, harness.tool_metadata)

        result = json.loads(session.read_spc_diagnostics())

        self.assertTrue(result["ok"])
        self.assertEqual(result["diagnostics"]["dataProfile"]["dataKind"], "count")
        self.assertEqual(result["diagnostics"]["chartRecommendations"][0]["chartType"], "uChart")

    def test_update_controls_blocks_p_chart_counts_without_denominator(self) -> None:
        request = build_agent_request(processed={
            "statistics": {"mean": 4},
            "ruleViolationCount": 0,
            "dataProfile": {"dataKind": "count"},
            "diagnostics": [],
            "chartRecommendations": [{"chartType": "cChart", "score": 92}],
        })
        harness = SPCAgentHarness()
        session = SPCAgentToolSession(request, harness.tool_metadata)

        result = json.loads(session.update_controls(chartType="pChart", yColumns=["A"]))

        self.assertNotIn("chartType", result["patch"])
        self.assertIn("chartType", result["skipped"])

    def test_update_controls_skips_invalid_columns(self) -> None:
        harness = SPCAgentHarness()
        session = SPCAgentToolSession(build_agent_request(), harness.tool_metadata)

        result = json.loads(session.update_controls(yColumns=["Missing"], xAxisColumn="AlsoMissing"))

        self.assertIn("yColumns", result["skipped"])
        self.assertIn("xAxisColumn", result["skipped"])
        self.assertNotIn("yColumns", result["patch"])

    def test_legacy_request_without_profiles_cannot_switch_to_unverified_columns(self) -> None:
        request = build_agent_request(
            dataset={"summary": "Columns A, B, Date", "headers": ["A", "B", "Date"]},
            processed={"statistics": {"mean": 1.5}, "dataProfile": {"column": "A", "dataKind": "continuous", "numericCount": 3, "integerLike": False, "nonNegative": True}},
        )
        session = SPCAgentToolSession(request, SPCAgentHarness().tool_metadata)

        result = json.loads(session.update_controls(yColumns=["Date"]))
        self.assertIn("Cannot verify that 'Date' holds numeric values", result["rejected"][0]["reason"])
        self.assertIn("no column profile", result["rejected"][0]["reason"])

        # The currently charted column is still known from the app's full-data profile.
        result = json.loads(session.update_controls(chartType="ewma", yColumns=["A"]))
        self.assertTrue(result["ok"])
        self.assertEqual(result["patch"]["chartType"], "ewma")

    def test_knowledge_loader_selects_expected_markdown(self) -> None:
        loader = SPCKnowledgeLoader()

        docs = loader.load()
        self.assertIn("i-mr.md", docs)
        self.assertIn("xbar-r.md", docs)
        self.assertIn("xbar-s.md", docs)
        self.assertIn("attribute-charts.md", docs)

        selection = loader.select(build_agent_request())
        self.assertIn("xbar-r.md", selection.sources)
        self.assertIn("X-bar R", selection.markdown)

    def test_agent_turn_returns_mocked_harness_response(self) -> None:
        request = build_agent_request()
        expected = {
            "content": "- Applied.",
            "controlPatch": {"chartType": "xBarR", "yColumns": ["A", "B"], "sampleSize": 2},
            "toolTrace": [{"tool": "update_controls"}],
            "knowledgeSources": ["xbar-r.md"],
            "needsClarification": False,
            "model": "test-model",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

        with patch.object(DSPyGateway, "_configure", return_value=None):
            gateway_instance = DSPyGateway()
            gateway_instance._agent_harness = unittest.mock.Mock()
            gateway_instance._agent_harness.run.return_value.model_dump.return_value = expected
            gateway_instance._model_name = "test-model"
            response = gateway_instance.agent_turn(request)

        self.assertEqual(response, expected)


class DSPyGatewayProviderResolutionTest(unittest.TestCase):
    def test_routes_google_openai_compat_base_to_native_gemini_provider(self) -> None:
        with patch.dict("os.environ", {"AI_PROVIDER": ""}):
            model, provider, api_base = DSPyGateway._resolve_litellm_target(
                "gemini-3.1-flash-lite-preview",
                "https://generativelanguage.googleapis.com/v1beta/openai",
            )

        self.assertEqual(model, "gemini/gemini-3.1-flash-lite-preview")
        self.assertIsNone(provider)
        self.assertIsNone(api_base)

    def test_keeps_custom_openai_compatible_base_as_openai_provider(self) -> None:
        with patch.dict("os.environ", {"AI_PROVIDER": ""}):
            model, provider, api_base = DSPyGateway._resolve_litellm_target(
                "local-model",
                "http://localhost:11434/v1",
            )

        self.assertEqual(model, "local-model")
        self.assertEqual(provider, "openai")
        self.assertEqual(api_base, "http://localhost:11434/v1")


class GatewayToolRoutingTest(unittest.TestCase):
    def test_routes_tool_enabled_requests_to_completion_passthrough(self) -> None:
        expected = {"id": "chatcmpl-tool", "choices": [{"message": {"role": "assistant", "content": "done"}}]}
        payload = ChatCompletionRequest(
            messages=[{"role": "user", "content": "Inspect controls and update them"}],
            tools=[{"type": "function", "function": {"name": "read_controls", "parameters": {"type": "object"}}}],
        )

        with patch.dict("os.environ", {"AI_GATEWAY_API_KEY": "", "DSPY_GATEWAY_API_KEY": ""}, clear=False):
            with patch.object(gateway, "complete_with_tools", return_value=expected) as complete_with_tools:
                response = chat_completions(payload, authorization=f"Bearer {DEFAULT_GATEWAY_API_KEY}")

        self.assertEqual(response, expected)
        complete_with_tools.assert_called_once_with(payload)


if __name__ == "__main__":
    unittest.main()
