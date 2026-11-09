# Control-Chart Run Rules: Nelson vs Western Electric

Purpose
- Explain which pattern tests the app runs, how they are numbered, and how to talk about signals.
- The app detects every signal deterministically. Quote its counts; never recount points yourself.

Two rule sets, different numbering
- Nelson (default in the app): 8 tests. Use these numbers when the active rule set is Nelson.
- Western Electric (classic, 1956 handbook): 4 rules. Use these numbers when the active rule set is Western Electric.
- The same pattern can have different numbers in the two sets. Always name the set with the number ("Nelson test 5", "WE rule 2").

| Pattern | Nelson | Western Electric |
|---|---|---|
| One point beyond 3 sigma (outside a control limit) | 1 | 1 |
| 2 of 3 consecutive points beyond 2 sigma, same side | 5 | 2 |
| 4 of 5 consecutive points beyond 1 sigma, same side | 6 | 3 |
| Run on one side of the center line | 2 (9 in a row) | 4 (8 in a row) |
| 6 points in a row steadily increasing or decreasing | 3 | not in the set |
| 14 points in a row alternating up and down | 4 | not in the set |
| 15 points in a row within 1 sigma of the center line | 7 | not in the set |
| 8 points in a row beyond 1 sigma, on both sides | 8 | not in the set |

What each pattern usually suggests
- Beyond 3 sigma: a sudden special cause (setup error, bad lot, measurement error).
- Zone tests (2 of 3, 4 of 5) and runs on one side: a shift in the process mean.
- Trend (Nelson 3): drift, such as tool wear, chamber seasoning, or reagent aging.
- Alternating (Nelson 4): over-adjustment, two alternating streams (two machines, two operators).
- 15 within 1 sigma (Nelson 7): stratification (subgroups mix streams), or limits too wide from a poor baseline.
- 8 beyond 1 sigma on both sides (Nelson 8): a mixture of two populations.

Signals vs points
- A signal is one detected pattern window, reported at its endpoint. Several points participate in one window
  (for example, 9 points for Nelson 2), and overlapping windows can share points.
- Report "N signals" for how many times a pattern fired and "M points involved" for how many plotted points carry a flag.
  Do not call every flagged point a separate out-of-control event.

How the app applies rules
- Location charts (I, X-bar, P, NP, C, U): the active rule set, using each point's own sigma when limits vary (P/U).
- EWMA: only test 1 (beyond the EWMA limits). EWMA points are autocorrelated by design, so run and zone tests are not calibrated.
- Variation charts (MR, R, S): only test 1 (beyond the variation-chart limits). A variation signal means short-term spread changed;
  location-chart limits are then less trustworthy.
- Histogram and scatter plots: no rules (no time order).

Cautions
- More rules mean more false alarms. With all 8 Nelson tests on in-control data, expect occasional false signals.
- Zone tests assume a roughly symmetric, approximately normal plotted statistic. For skewed data or attribute charts
  with small counts, treat zone-test signals as weaker evidence than test 1.
- Autocorrelated data (high lag-1 autocorrelation) produces many run and trend signals that are not special causes.
- A signal is a prompt to investigate, not a verdict about product quality, and has nothing to do with specification limits.
