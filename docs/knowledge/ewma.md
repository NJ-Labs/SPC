# EWMA Control Chart (Knowledge)

Purpose
- The exponentially weighted moving average chart detects small, sustained shifts and slow drift faster than an I chart.
- It needs time-ordered continuous data and a credible baseline (center line and within sigma from the I-MR logic).

How the app computes it
- Plotted value: z_i = lambda x x_i + (1 - lambda) x z_(i-1), with lambda = 0.2 and z_0 = the baseline mean.
- Missing observations are gaps: the gap is not plotted, z is not reset, and the next valid observation continues from the last z.
- Within sigma comes from the moving range: MR-bar / 1.128.
- Limits are time-varying and widen toward their steady state:
  center line +/- 3 x within sigma x sqrt( lambda / (2 - lambda) x (1 - (1 - lambda)^(2i)) ),
  where i counts valid observations only (gaps do not advance it).
- Only test 1 (point beyond the EWMA limits) is evaluated. EWMA points are autocorrelated by construction, so run and zone tests do not apply.
- Capability on an EWMA view is always preliminary: assess the underlying I-MR chart for stability first.

Interpretation
- A signal says the weighted recent average moved, not that one observation was extreme.
- Pair EWMA with an I-MR chart: I-MR catches large sudden shifts; EWMA catches small persistent ones.
- Large lambda (near 1) behaves like an I chart; small lambda smooths more and reacts later to big jumps.

Common mistakes
- Do not use EWMA on attribute counts without a suitable transformation.
- Do not start EWMA monitoring before the baseline is stable; a contaminated baseline hides the shifts EWMA should find.
