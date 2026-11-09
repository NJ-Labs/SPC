# X-bar R Control Chart (Knowledge)

This file summarizes formulas and steps used in the app for the X-bar R chart implementation.

Overview
- An X-bar R chart is used when the subgroup size is small (commonly 2 ≤ n ≤ 10).
- It consists of two charts stacked vertically:
  - X-bar chart (top): plots subgroup means and monitors process mean.
  - R chart (bottom): plots subgroup ranges and monitors process variability.

Subgrouping
- Given individual observations, group the data into consecutive, non-overlapping subgroups of size n.
- Discard any incomplete trailing subgroup.

Definitions
- For subgroup i with observations x_{i1}, …, x_{in}:
  - Subgroup mean: \bar{x}_i = (1/n) Σ x_{ij}
  - Subgroup range: R_i = max(x_{ij}) − min(x_{ij})
- Across k complete subgroups:
  - X-bar-bar (grand mean): \bar{\bar{x}} = (1/k) Σ \bar{x}_i
  - R-bar: \bar{R} = (1/k) Σ R_i

Control Chart Constants (depend on subgroup size n)
- A2, D3, D4, d2 are used.
- Typical values are standard and included in code tables.

Control Limits
- X-bar chart (uses R-bar):
  - UCL_Xbar = \bar{\bar{x}} + A2 · \bar{R}
  - CL_Xbar  = \bar{\bar{x}}
  - LCL_Xbar = \bar{\bar{x}} − A2 · \bar{R}
- R chart:
  - UCL_R = D4 · \bar{R}
  - CL_R  = \bar{R}
  - LCL_R = D3 · \bar{R}

Sigma Estimate
- Within-process sigma: \sigma ≈ \bar{R} / d2 (the app reports it as processSigma, method "R-bar/d2"). Cp/Cpk use it.
- The X-bar chart plots means, so its own sigma is the standard error \sigma / sqrt(n). A2 · \bar{R} equals 3 · \sigma / sqrt(n).
  Do not quote the standard error as the process sigma.

Notes
- Use subgroup means as X-bar chart points; use R_i as R chart points.
- For small n where D3 is 0, LCL_R = 0.
- In the app, several Y columns mean each row is one subgroup and n = number of Y columns; one Y column means consecutive rows form subgroups of size n.
- The app runs the active rule set on the X-bar chart and only test 1 (beyond limits) on the R chart.
- Read the R chart first: if within-subgroup spread is unstable, the X-bar limits (built from R̄) are not trustworthy.
- Rational subgroups should contain only common-cause variation (same time, setup, and material). Mixing streams inside a subgroup inflates R̄ and hides shifts.

