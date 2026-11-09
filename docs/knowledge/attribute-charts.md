# Attribute Control Charts

P chart
- Use for proportion nonconforming.
- Works with varying subgroup sizes when each row has a nonconforming count and a denominator.
- Center line is total nonconforming divided by total inspected.
- Limits vary by row when subgroup size varies.

NP chart
- Use for number nonconforming when subgroup size is constant.
- Data are non-negative integer counts of defective units.
- Limits are constant for a fixed sample size.

C chart
- Use for defect counts when the area of opportunity is constant.
- Data are non-negative integer defect counts.
- Center line is average count; sigma is the square root of average count.

U chart
- Use for defects per unit when opportunity size varies.
- Data require defect count plus units/opportunities denominator.
- Center line is total defects divided by total opportunities.
- Limits vary by row using each denominator.

Common mistakes
- Do not use P charts for defect counts unless counts are defective units with inspected-unit denominators.
- Do not use C charts when inspected area or opportunity size changes.
- Do not interpret attribute capability with Cp/Cpk.
- Do not use NP when subgroup sizes vary; use P with a denominator column.

How the app reads attribute data
- P with a denominator column: Y = nonconforming count per row (whole number, not above the denominator).
- P without a denominator: Y must already be proportions between 0 and 1; n is the sample size setting.
- NP: Y = whole-number count, at most the sample size n; a denominator column is not allowed.
- C: Y = non-negative whole-number defect count.
- U: Y = defect count; denominator = units or opportunities per row (without it, each row counts as n units).
- Rows with invalid values (negative, non-integer counts, count above its denominator) are excluded, not guessed.

Rule interpretation
- Limits that vary by row (P, U) are evaluated point by point, so compare each point with its own limits.
- With small expected counts the distribution is skewed; treat zone-test signals as weaker evidence than a point beyond a limit.
- Many points beyond both limits across the series (overdispersion) can mean the binomial/Poisson model does not fit;
  a Laney P'/U' chart or an I chart of the rates may be more appropriate.
