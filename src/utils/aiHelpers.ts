import { ChartType, DataSet, ProcessedData, RuleSet } from '../types/DataTypes';
import { summarizeRuleViolations, type RuleViolationSummary } from './aiTools';

const MAX_PREVIEW_ROWS = 5;
const MAX_VALUE_LENGTH = 80;
const MAX_SUMMARY_COLUMNS = 40;

const RULE_SET_LABELS: Record<RuleSet, string> = {
  nelson: 'Nelson tests (8)',
  westernElectric: 'Western Electric rules (4)',
};

const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '—';
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? Number(value).toPrecision(6) : String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const trimmed = String(value).trim();

  if (trimmed === '') {
    return '—';
  }

  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
    return numeric.toPrecision(6);
  }

  if (trimmed.length > MAX_VALUE_LENGTH) {
    return `${trimmed.slice(0, MAX_VALUE_LENGTH)}…`;
  }

  return trimmed;
};

const describeColumns = (dataSet: DataSet): string => {
  if (!dataSet.headers.length) {
    return 'No columns detected.';
  }

  const fragments = dataSet.headers.slice(0, MAX_SUMMARY_COLUMNS).map((header) => {
    const exampleEntry = dataSet.data.find((row) => row[header] !== undefined && row[header] !== null)?.[header];
    const formattedValue = formatValue(exampleEntry);
    let type: string = 'text/categorical';

    if (typeof exampleEntry === 'number') {
      type = 'numeric';
    } else if (typeof exampleEntry === 'string') {
      const numeric = Number(exampleEntry);
      if (!Number.isNaN(numeric)) {
        type = 'numeric (string)';
      } else if (exampleEntry.toLowerCase().includes('date')) {
        type = 'date-like string';
      }
    }

    return `${header}: ${type}${formattedValue !== '—' ? ` (example ${formattedValue})` : ''}`;
  });

  const hidden = dataSet.headers.length - MAX_SUMMARY_COLUMNS;
  return `${fragments.join('; ')}${hidden > 0 ? `; … ${hidden} more columns` : ''}`;
};

const buildPreviewRows = (dataSet: DataSet): string => {
  if (!dataSet.data.length) {
    return 'No rows available. Upload or generate sample data to continue.';
  }

  const headers = dataSet.headers.slice(0, MAX_SUMMARY_COLUMNS);
  const rows = dataSet.data.slice(0, MAX_PREVIEW_ROWS).map((row, index) => {
    const cells = headers.map((header) => `${header}: ${formatValue(row[header])}`);
    return `${index + 1}. ${cells.join(', ')}`;
  });

  return rows.join('\n');
};

const formatNumber = (value: number | null | undefined, precision = 6): string => (
  typeof value === 'number' && Number.isFinite(value) ? Number(value).toPrecision(precision) : 'n/a'
);

const describeRuleSummary = (summary: RuleViolationSummary, label: string): string => {
  if (!summary.rules.length) {
    return `${label}: no signals`;
  }
  const perRule = summary.rules
    .map((rule) => `rule ${rule.ruleNumber} x${rule.signalCount}`)
    .join(', ');
  const approximate = summary.exactSignalCounts ? '' : ' (approximate)';
  return `${label}: ${summary.signalCount} signal(s)${approximate} involving ${summary.flaggedPointCount} point(s) [${perRule}]`;
};

export const summarizeDatasetForAi = (
  dataSet: DataSet | null,
  processedData: ProcessedData | null,
  selectedColumns: string[],
  xAxisColumn: string | null,
  denominatorColumn: string | null,
  sampleSize: number,
  options: { ruleSet?: RuleSet; chartType?: ChartType } = {},
): string | null => {
  if (!dataSet) {
    return null;
  }

  const summary: string[] = [];
  const { data, headers, fileName, fileType } = dataSet;

  summary.push(`File: ${fileName || 'uploaded dataset'} (${fileType || 'unknown type'})`);
  summary.push(`Row count: ${data.length}`);
  summary.push(`Column count: ${headers.length}`);

  const selected = selectedColumns.length ? selectedColumns.join(', ') : 'none';
  summary.push(`Selected Y column(s): ${selected}`);
  summary.push(`X-axis column: ${xAxisColumn ?? 'row index (implicit)'}`);
  summary.push(`Denominator/opportunities column: ${denominatorColumn ?? 'none'}`);
  summary.push(`Stored sample-size setting: ${sampleSize} (chart-dependent; not evidence of rational subgrouping).`);
  const isXbar = options.chartType === 'xBarR' || options.chartType === 'xBarS';
  if (isXbar) {
    const size = selectedColumns.length > 1 ? selectedColumns.length : sampleSize;
    const layout = selectedColumns.length > 1 ? 'one subgroup per row across selected Y columns' : 'consecutive rows grouped from the first Y column';
    summary.push(`Configured subgroup size: ${size}; ${layout}. Confirm rational subgrouping before recommending X-bar charts.`);
  } else if (options.chartType === 'individual' || options.chartType === 'ewma') {
    summary.push('Current observation layout: one observation per row (n=1), using the first selected Y column; the stored sample-size setting is unused.');
  }
  summary.push(`Column overview: ${describeColumns(dataSet)}`);

  if (processedData) {
    const stats = processedData.statistics;
    const limits = processedData.controlLimits;
    summary.push(
      `App-computed plotted values: center line=${formatNumber(stats.mean)}, σ of plotted statistic=${formatNumber(stats.standardDeviation)}, min=${formatNumber(stats.min)}, max=${formatNumber(stats.max)}, count=${stats.count}`
    );
    summary.push(
      `App-computed control limits: UCL=${formatNumber(limits?.ucl)}, LCL=${formatNumber(limits?.lcl)}, within-process σ=${formatNumber(limits?.processSigma)}${limits?.sigmaMethod ? ` (${limits.sigmaMethod})` : ''}`
    );
    const ruleSet = processedData.ruleViolations.find((violation) => violation.ruleSet)?.ruleSet ?? options.ruleSet ?? 'nelson';
    summary.push(describeRuleSummary(summarizeRuleViolations(processedData.ruleViolations, ruleSet), `Rule signals (${RULE_SET_LABELS[ruleSet]})`));
    if (processedData.variationRuleViolations) {
      summary.push(describeRuleSummary(summarizeRuleViolations(processedData.variationRuleViolations, ruleSet), 'Variation chart (MR/R/S) limit signals'));
    }
    if (processedData.dataProfile) {
      const profile = processedData.dataProfile;
      summary.push(
        `SPC data profile: kind=${profile.dataKind}, numeric=${profile.numericCount}/${profile.rowCount}, missing=${profile.missingCount}, nonNumeric=${profile.nonNumericCount}, skew=${profile.skewness?.toPrecision(4) ?? 'n/a'}, lag1=${profile.lag1Autocorrelation?.toPrecision(4) ?? 'n/a'}, timeOrdered=${profile.timeOrdered}`
      );
    }
    if (processedData.diagnostics?.length) {
      summary.push(`SPC diagnostics: ${processedData.diagnostics.map((item) => `${item.severity}:${item.code}`).join(', ')}`);
    }
    if (processedData.chartRecommendations?.length) {
      summary.push(`Top chart candidates: ${processedData.chartRecommendations.slice(0, 3).map((item) => `${item.chartType} (${item.status})`).join(', ')}`);
    }
    if (processedData.capabilityStatus) {
      const capability = processedData.capabilityStatus;
      const { indices } = capability;
      summary.push(`Capability readiness: ${capability.readiness}; ${capability.reasons.join(' ')}`);
      if (capability.readiness !== 'notApplicable') {
        summary.push(
          `App-computed capability: Cp=${formatNumber(indices.cp, 3)}, Cpk=${formatNumber(indices.cpk, 3)} (within σ=${formatNumber(capability.sigmaEstimate?.within)}); Pp=${formatNumber(indices.pp, 3)}, Ppk=${formatNumber(indices.ppk, 3)} (overall σ=${formatNumber(capability.sigmaEstimate?.overall)}); Cpm=${formatNumber(indices.cpm, 3)}`
        );
      }
    }
  }

  summary.push('Sample rows (first rows only):');
  summary.push(buildPreviewRows(dataSet));

  return summary.join('\n');
};

export const buildAssistantSystemPrompt = (language: 'en' | 'he' = 'en', agentMode = false): string => {
  const agentModeInstructionEn = agentMode
    ? `
Additional Agent Mode tool requirement:
- You have explicit tools available for reading and updating SPC controls.
- Use read_controls before changing settings whenever the current state or allowed options matter.
- Use update_controls to change the UI instead of emitting recommendation JSON.
- Only say a setting changed when update_controls reported it as changed; rejected fields stay unchanged.
- After tool use is complete, provide a short user-facing summary of what changed or what still needs input.
`
    : '';

  const agentModeInstructionHe = agentMode
    ? `
דרישת כלים נוספת במצב Agent:
- יש לך כלים מפורשים לקריאה ולעדכון של בקרות ה-SPC.
- השתמש ב-read_controls לפני שינוי הגדרות כאשר המצב הנוכחי או האפשרויות הזמינות חשובים.
- השתמש ב-update_controls כדי לשנות את הממשק במקום להחזיר JSON של המלצה.
- ציין ששינוי בוצע רק אם update_controls דיווח עליו כשינוי; שדות שנדחו נשארים ללא שינוי.
- אחרי השימוש בכלים, החזר סיכום קצר למשתמש על מה השתנה או איזה מידע עדיין חסר.
`
    : '';

  if (language === 'he') {
    return `
אתה יועץ מנוסה בבקרת תהליכים סטטיסטית (SPC).
נתח נתוני ייצור, בריאות ושירות כדי להמליץ על תרשימי בקרה מתאימים.
שקול האם הנתונים מייצגים מדידות בודדות, מדידות מקובצות, נתוני תכונה (עבר/נכשל, ספירות פגמים C/U), או פרופורציות P/NP.
כאשר משתמש מספק הקשר, המלץ על סוג/י התרשים המובילים והסבר מדוע.
הדגש הנחות נדרשות, גדלי תת-קבוצות, וכל עיבוד מקדים נדרש.
אם חסר מידע, שאל שאלות הבהרה תמציתיות לפני שמתחייב להמלצת תרשים.
ספק תשובות שניתן ליישם עבור מתרגלים המטמיעים SPC בסביבות ייצור.
כללי דיוק:
- למדידה רציפה אחת לכל דגימה (n=1), המלץ על I-MR. תרשימי X-bar R/S דורשים תת-קבוצות רציונליות מאומתות עם לפחות שתי מדידות; אין להסיק אותן מהגדרת גודל המדגם, ממספר השורות או מתוויות ציר X.
- אל תחשב סטטיסטיקות בעצמך. צטט רק מספרים שחושבו באפליקציה (גבולות, σ, מדדי יכולת, ספירת אותות). אם מספר חסר, אמור שאינו זמין.
- גבולות בקרה (UCL/LCL) מחושבים מנתוני התהליך; גבולות מפרט (LSL/USL) מגיעים מדרישות. לעולם אל תגזור אחד מהשני.
- Cp/Cpk משתמשים ב-σ פנימי; Pp/Ppk משתמשים ב-σ כולל.
- כשאתה מזכיר מספר חוק, ציין את הסט: מבחני Nelson (8) או חוקי Western Electric (4).
שמור על תשובות קצרות וישירות.
פורמט נדרש:
- עד 5 תבליטים.
- כל תבליט עד 18 מילים.
- ללא הקדמות ארוכות, ללא חזרה על השאלה.
- אם אין מספיק מידע: עד 2 שאלות הבהרה קצרות.
- רק אם המשתמש מבקש הסבר אינטראקטיבי או חזותי: בלוק \`\`\`html אחד עצמאי (CSS/JS פנימיים בלבד, ללא כתובות חיצוניות, ללא קריאות רשת, ללא גישה לאפליקציה).
${agentModeInstructionHe}
`;
  }

  return `
You are an experienced Statistical Process Control (SPC) consultant.
Analyse manufacturing, healthcare, and service process data to recommend appropriate control charts.
Consider whether the data represents individual measurements, subgrouped measurements, attribute data (pass/fail, C/U defect counts), or P/NP proportions/counts.
When a user provides context, recommend the top chart type(s) and explain why.
Highlight required assumptions, subgroup sizes, and any preprocessing needed.
If information is missing, ask concise clarifying questions before committing to a chart recommendation.
Provide answers that are actionable for practitioners implementing SPC in production environments.
Accuracy rules:
- For one continuous measurement per sample (n=1), recommend I-MR. X-bar R/S require confirmed rational subgroups with at least two measurements; never infer them from the stored sample-size setting, row count, or X-axis labels.
- Never calculate statistics yourself. Quote only numbers computed by the app (limits, sigma, capability indices, signal counts). If a number is missing, say it is not available.
- Control limits (UCL/LCL) come from process data; specification limits (LSL/USL) come from requirements. Never derive one from the other.
- Cp/Cpk use within-process sigma; Pp/Ppk use overall sigma.
- When citing a rule number, name the set: Nelson tests (8) or Western Electric rules (4).
Keep responses short and direct.
Required format:
- Maximum 5 bullets.
- Maximum 18 words per bullet.
- No long preamble and no restating the prompt.
- If information is missing, ask up to 2 short clarifying questions.
- Only if the user asks for an interactive or visual explanation: one self-contained \`\`\`html block (inline CSS/JS only, no external URLs, no network calls, no access to the app).
${agentModeInstructionEn}
`;
};

export const buildInitialUserPrompt = (
  summary: string,
  selectedChartType: ChartType,
  selectedChartLabel?: string,
  language: 'en' | 'he' = 'en',
): string => {
  const friendlyName = selectedChartLabel ?? selectedChartType;
  
  if (language === 'he') {
    return `
להלן סיכום מערך הנתונים הנוכחי מכלי SPC:

${summary}

המשתמש בחר כעת "${friendlyName}" בממשק המשתמש. בהתבסס על פרטי מערך הנתונים ושיטות עבודה מומלצות של SPC, אילו תרשימי בקרה כדאי להם לשקול? אנא:
1. המלץ על סוג/י התרשים המתאימים ביותר.
2. הסבר מדוע, תוך התייחסות לגודל תת-קבוצה, סוג נתונים (משתנה לעומת תכונה), ושיקולי יציבות.
3. פרט כל שלב הכנת נתונים או אימות נדרש.
4. הצע שאלת הבהרה אחת או שתיים אם המידע הזמין אינו מספיק.
`;
  }
  
  return `
Here is the current dataset summary from the SPC tool:

${summary}

The user currently has "${friendlyName}" selected in the UI. Based on the dataset details and SPC best practices, which control chart(s) should they consider? Please:
1. Recommend the most suitable chart type(s).
2. Explain why, referencing subgroup size, data type (variable vs. attribute), and stability considerations.
3. Outline any required data preparation or validation steps.
4. Suggest one or two clarifying questions if the available information is insufficient.
`;
};

export const buildDatasetUpdatePrompt = (summary: string, language: 'en' | 'he' = 'en'): string => {
  if (language === 'he') {
    return `
מערך הנתונים עודכן. העריך מחדש את המלצת ה-SPC באמצעות הסיכום החדש:

${summary}

אנא הדגש מה השתנה, האם סוג התרשים המומלץ צריך להשתנות, וכל שיקול חדש שהמתרגל צריך להיות מודע אליו.
`;
  }
  
  return `
The dataset has been updated. Re-evaluate the SPC recommendation using the new summary:

${summary}

Please highlight what changed, whether the recommended chart type should change, and any new considerations the practitioner should be aware of.
`;
};

export const buildAgentAutopilotPrompt = (
  summary: string,
  selectedChartType: ChartType,
  selectedChartLabel?: string,
  language: 'en' | 'he' = 'en',
): string => {
  const friendlyName = selectedChartLabel ?? selectedChartType;

  if (language === 'he') {
    return `
מצב Agent פעיל. עדכן את פרמטרי ה-SPC ישירות בממשק.

סיכום נתונים:
${summary}

הגדרה נוכחית: ${friendlyName}.

החזר המלצה מעשית לבחירת:
- chartType
- yColumns (עמודה אחת או כמה)
- xAxisColumn (או null לשימוש באינדקס שורה)
- denominatorColumn עבור תרשימי P/U כאשר יש מכנה
- sampleSize

החזר גם נימוק קצר.
קרא אבחונים לפני שינוי משפחת תרשימים, בחירת P/U/C, או דיון ביכולת תהליך.
`;
  }

  return `
Agent Mode is enabled. Update SPC UI parameters directly.

Dataset summary:
${summary}

Current selection: ${friendlyName}.

Use the available tools to inspect current controls when needed and apply the right SPC UI changes.
Read diagnostics before changing chart families, choosing P/U/C charts, or discussing capability.
After any tool calls, return a short explanation of what you changed and why.
`;
};
