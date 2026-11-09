# SPC Chart Selection Playbook

Purpose
- Choose a chart from data structure before interpreting signals.
- Confirm process order, rational subgrouping, and measurement credibility before capability claims.

Selection rules (app chart type in parentheses)
- Continuous one-at-a-time measurements: I-MR (`individual`).
- Continuous rational subgroups: X-bar R (`xBarR`) for small subgroups (about n <= 10), X-bar S (`xBarS`) for larger subgroups.
- Proportion nonconforming: P chart (`pChart`); NP (`npChart`) only when every subgroup has the same size.
- Defect counts on a constant opportunity base: C chart (`cChart`).
- Defect counts with varying opportunities or inspected units: U chart (`uChart`) with a denominator column.
- Small sustained shifts or drift in ordered continuous data: EWMA (`ewma`) after baseline limits are credible.
- Histogram (`histogram`) and scatter plot (`scatterPlot`) are exploratory; they have no control limits or rule tests.

How the app reads the data
- P chart with a denominator column: Y holds nonconforming counts (whole numbers, not above the denominator).
  P chart without a denominator: Y must already be proportions between 0 and 1, and the subgroup size n is the sample size setting.
- NP chart: Y holds whole-number counts no larger than the sample size n; it cannot use a denominator column.
- C chart: Y holds non-negative whole-number defect counts.
- U chart: Y holds defect counts; the denominator column gives units per row (without it, each row counts as n units).
- X-bar charts with several Y columns: each row is one subgroup and n equals the number of Y columns.
  With one Y column: consecutive rows form subgroups of size n and an incomplete last subgroup is dropped.
- I-MR, EWMA, and attribute charts use only the first Y column.

Before applying a chart
- Verify time/order sequence is meaningful.
- Verify Y columns represent one process stream, product, tool, or family unless the user intentionally stratifies.
- Ask for denominator/opportunity data when recommending P or U charts from counts.
- Ask what a subgroup means (same time, same lot, same fixture) before recommending X-bar charts.
- A stored sample-size setting (including the default 5), enough rows to divide into blocks, or a Sample/X-axis column does not establish rational subgrouping. For one measurement per sample, recommend I-MR; configure consecutive-row X-bar groups only after confirming their process meaning.
- Treat control limits and specification limits as different concepts.
- Use the app's chart candidates and diagnostics as evidence; explain them rather than overriding them silently.
