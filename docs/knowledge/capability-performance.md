# Capability And Performance

Specification limits vs control limits
- Specification limits (LSL, USL, target) come from customer or design requirements. The user enters them; the assistant never sets or invents them.
- Control limits (UCL, LCL) are computed from process data and describe what the process actually does.
- Never derive spec limits from control limits or the reverse. A point inside the specs can still be a control-chart signal,
  and an in-control process can still produce parts outside the specs.
- Stability (control chart) answers "is the process predictable?". Capability answers "does the predictable process fit the specs?".

Within vs overall sigma
- Within-process sigma estimates short-term, common-cause variation from the control chart:
  I-MR uses MR-bar/d2 (d2 = 1.128), X-bar R uses R-bar/d2, X-bar S uses S-bar/c4.
- Overall sigma is the ordinary sample standard deviation of all observations; it also contains shifts and drift between subgroups.
- Cp and Cpk use within sigma (potential capability). Pp and Ppk use overall sigma (actual performance).
- Usually Cp >= Pp. A large gap means the process moves between subgroups or over time; fix stability before trusting Cp/Cpk.
- On X-bar charts the plotted sigma is the standard error of the mean (process sigma divided by the square root of n). It is not the process sigma used for capability.

Indices (the app computes these; quote them, never recompute)
- Cp = (USL - LSL) / (6 x within sigma). Needs both specs.
- Cpk = min(Cpu, Cpl) with Cpu = (USL - mean) / (3 x within sigma) and Cpl = (mean - LSL) / (3 x within sigma).
  With only one spec, Cp is undefined and Cpk equals the one available side.
- Pp, Ppk, Ppu, Ppl: the same formulas with overall sigma.
- Cpm = (USL - LSL) / (6 x sqrt(overall sigma^2 + (mean - target)^2)), the standard NIST/Taguchi definition.
  It needs both specs and a target inside the specs. It penalizes running off target, so Cpm < Pp when the mean is away from the target. An off-center target does not change the numerator.
  Reference: https://www.itl.nist.gov/div898/handbook/pmc/section1/pmc16.htm
- Common reference points: 1.00 means the spec width equals the process 6-sigma spread; 1.33 is a common minimum;
  1.67 is often required for new or critical characteristics. The user's customer requirement always wins.

Partial results (some indices valid, others unavailable)
- Within sigma zero or missing, overall sigma positive: Cp/Cpk are unavailable, Pp/Ppk are still reported, readiness is preliminary.
  Zero within variation often means coarse measurement resolution or repeated identical readings; check the gage.
- Target outside the specification limits: Cpm is unavailable, Cp/Cpk/Pp/Ppk stay valid, readiness is preliminary.
  Ask the user to correct the target rather than ignoring it.
- An unavailable index is reported as missing (n/a). Never fill it in with an estimate.

Readiness (as reported by the app)
- Ready: continuous control chart, valid specs, at least 30 usable observations, no rule signals on the location or variation chart,
  no data-quality or subgroup diagnostics, |skewness| <= 1, |lag-1 autocorrelation| <= 0.35, and every applicable index available.
- Preliminary: at least one index is available, but a check fails (fewer than 30 observations, rule signals, unassessed stability,
  data-quality or time-order diagnostics, skew, autocorrelation, zero within sigma, target outside specs).
  EWMA capability is always preliminary until the underlying I-MR chart is assessed.
- Not applicable: attribute charts (P/NP/C/U), histogram or scatter plot, no spec limit, reversed specs (USL <= LSL),
  non-numeric specs or target, fewer than two usable observations, or no index can be computed at all.

Practitioner guidance
- Report the readiness status beside every index.
- Investigate special-cause signals before promising long-term capability.
- Use stratification when product, tool, recipe, or operator mixing is suspected.
- For skewed data, consider a transformation or a non-normal capability method; do not just quote normal-theory indices.
