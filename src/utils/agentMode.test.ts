import { describe, expect, it } from 'vitest';
import {
  extractAgentRecommendationFromMessage,
  normalizeAgentChartType,
  resolveHeaderName,
  stripAgentRecommendationFromMessage,
  validateAgentRecommendationAgainstHeaders,
} from './agentMode';

describe('agentMode utilities', () => {
  it('extracts multi-column recommendation and clamps sample size', () => {
    const message = `- Recommendation\n\n\`\`\`json
{"recommendation":{"chartType":"xBarR","yColumns":["A","B"],"xAxisColumn":"Date","sampleSize":40,"chartLabel":"XBar R Monitoring","zAxisLabel":"Date","yAxisLabel":"Measurement","reason":"Subgroups available"}}
\`\`\``;

    const recommendation = extractAgentRecommendationFromMessage(message);

    expect(recommendation).not.toBeNull();
    expect(recommendation?.chartType).toBe('xBarR');
    expect(recommendation?.yColumns).toEqual(['A', 'B']);
    expect(recommendation?.xAxisColumn).toBe('Date');
    expect(recommendation?.sampleSize).toBe(25);
    expect(recommendation?.chartLabel).toBe('XBar R Monitoring');
    expect(recommendation?.zAxisLabel).toBe('Date');
    expect(recommendation?.yAxisLabel).toBe('Measurement');
  });

  it('supports legacy single yColumn shape', () => {
    const message = `\`\`\`json
{"recommendation":{"chartType":"individual","yColumn":"Measurement","reason":"Single metric"}}
\`\`\``;

    const recommendation = extractAgentRecommendationFromMessage(message);

    expect(recommendation?.yColumns).toEqual(['Measurement']);
  });

  it('validates columns against headers and preserves explicit null xAxis', () => {
    const validated = validateAgentRecommendationAgainstHeaders(
      {
        chartType: 'xBarS',
        yColumns: ['A', 'Missing', 'B'],
        xAxisColumn: null,
        sampleSize: 5,
        reason: 'test',
      },
      ['A', 'B', 'Date'],
    );

    expect(validated.yColumns).toEqual(['A', 'B']);
    expect(validated.xAxisColumn).toBeNull();
    expect(validated.sampleSize).toBe(5);
  });

  it('supports xAxisLabel alias for zAxisLabel in recommendation payload', () => {
    const message = `\`\`\`json
{"recommendation":{"chartType":"individual","yColumns":["A"],"xAxisColumn":"Date","sampleSize":5,"xAxisLabel":"Batch Date","yAxisLabel":"Value","chartLabel":"I Chart","reason":"test"}}
\`\`\``;

    const recommendation = extractAgentRecommendationFromMessage(message);

    expect(recommendation?.zAxisLabel).toBe('Batch Date');
    expect(recommendation?.yAxisLabel).toBe('Value');
    expect(recommendation?.chartLabel).toBe('I Chart');
  });

  it('extracts denominator column recommendations for U charts', () => {
    const message = `\`\`\`json
{"recommendation":{"chartType":"uChart","yColumns":["Defects"],"denominatorColumn":"Opportunities","reason":"Varying opportunity counts"}}
\`\`\``;

    const recommendation = extractAgentRecommendationFromMessage(message);
    const validated = validateAgentRecommendationAgainstHeaders(
      recommendation!,
      ['Defects', 'Opportunities'],
    );

    expect(validated.chartType).toBe('uChart');
    expect(validated.denominatorColumn).toBe('Opportunities');
  });

  it('uses the most actionable recommendation when multiple JSON blocks are present', () => {
    const message = `- Switch to X-bar S

\`\`\`json
{"recommendation":{"chartType":null,"yColumns":[],"yColumn":null,"xAxisColumn":null,"sampleSize":null,"chartLabel":null,"zAxisLabel":null,"yAxisLabel":null,"reason":""}}
\`\`\`

{"recommendation":{"chartType":"xBarS","yColumns":["Sample_1","Sample_2","Sample_3","Sample_4","Sample_5"],"xAxisColumn":null,"sampleSize":5,"chartLabel":"X-bar and S Control Chart","zAxisLabel":"Subgroup Index","yAxisLabel":"Measurement Value","reason":"Use all five samples"}}
`;

    const recommendation = extractAgentRecommendationFromMessage(message);

    expect(recommendation?.chartType).toBe('xBarS');
    expect(recommendation?.yColumns).toEqual(['Sample_1', 'Sample_2', 'Sample_3', 'Sample_4', 'Sample_5']);
    expect(recommendation?.xAxisColumn).toBeNull();
    expect(recommendation?.sampleSize).toBe(5);
  });

  it('strips malformed and final recommendation payloads from agent mode display text', () => {
    const message = `* Switch to X-bar R chart.

{
  "recommendation": {
    "chartType": "xBarR",
    "yColumns": ["Sample_1", "Sample_2"],
    "reason": "Subgroup

json
{"recommendation":{"chartType":"xBarR","yColumns":["Sample_1","Sample_2"],"reason":"hidden"}}

\`\`\`json
{"recommendation":{"chartType":"xBarR","yColumns":["Sample_1","Sample_2"],"sampleSize":2,"reason":"final"}}
\`\`\``;

    expect(stripAgentRecommendationFromMessage(message, 'fallback')).toBe('* Switch to X-bar R chart.');
  });

  it('normalizes chart-type paraphrases and numeric strings from weaker models', () => {
    const message = `\`\`\`json
{"recommendation":{"chartType":"X-bar R chart","yColumns":["a","b"],"sampleSize":"4","reason":"subgroups"}}
\`\`\``;

    const recommendation = extractAgentRecommendationFromMessage(message);

    expect(recommendation?.chartType).toBe('xBarR');
    expect(recommendation?.sampleSize).toBe(4);
    expect(normalizeAgentChartType('I-MR')).toBe('individual');
    expect(normalizeAgentChartType('u chart')).toBe('uChart');
    expect(normalizeAgentChartType('pie chart')).toBeNull();
  });

  it('ignores non-object recommendation payloads', () => {
    expect(extractAgentRecommendationFromMessage('```json\n{"recommendation":"xBarR"}\n```')).toBeNull();
    expect(extractAgentRecommendationFromMessage('```json\n{"recommendation":["xBarR"]}\n```')).toBeNull();
  });

  it('resolves header case uniquely and drops a denominator equal to the Y column', () => {
    const validated = validateAgentRecommendationAgainstHeaders(
      { chartType: 'uChart', yColumns: ['defects', 'DEFECTS'], denominatorColumn: 'Defects', xAxisColumn: 'date', reason: '' },
      ['Defects', 'Units', 'Date'],
    );

    expect(validated.yColumns).toEqual(['Defects']);
    expect(validated.denominatorColumn).toBeUndefined();
    expect(validated.xAxisColumn).toBe('Date');
    expect(resolveHeaderName('value', ['Value', 'VALUE'])).toBeNull();
  });
});
