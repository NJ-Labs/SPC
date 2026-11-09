import type { AgentConfigField, AgentConfigValue } from '../../types/AiTypes';
import { chartMeta } from '../../types/chartMeta';
import type { ChartType } from '../../types/DataTypes';

export type Translate = (key: string) => string;

/**
 * Every falsy value (`false`, `0`, `''`, `null`, `[]`) gets explicit text; nothing renders blank.
 * `field` is absent for a setting the app does not know (a gateway refusal of an unrecognised name).
 */
export const formatAgentConfigValue = (field: AgentConfigField | undefined, value: AgentConfigValue, t: Translate): string => {
  if (typeof value === 'boolean') return value ? t('ai.value.on') : t('ai.value.off');
  if (Array.isArray(value)) return value.length ? value.join(', ') : t('ai.value.noColumns');
  if (value === null) {
    if (field === 'xAxisColumn') return t('ai.value.rowIndex');
    if (field === 'denominatorColumn') return t('ai.value.fixedSample');
    return t('ai.value.none');
  }
  if (typeof value === 'string') {
    if (value === '') return t('ai.value.empty');
    if (field === 'chartType') return chartMeta[value as ChartType]?.name ?? value;
    if (field === 'ruleSet') return value === 'westernElectric' ? t('rules.set.westernElectric') : t('rules.set.nelson');
    return value;
  }
  return String(value);
};
