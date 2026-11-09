import React, { useMemo } from 'react';
import { Ban, Check, History, Minus, ShieldCheck } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import type {
  AgentConfigChange,
  AgentConfigChangeStatus,
  AgentConfigEvidence,
  AgentConfigField,
  AgentConfigRejectReason,
} from '../../types/AiTypes';
import { formatAgentConfigValue } from './agentConfigFormat';
import { agentConfigValue, evaluateEvidenceCurrentness, EVIDENCE_OUTCOME_KEYS, type AgentConfigState } from './agentConfig';

const FIELD_LABEL_KEYS: Record<AgentConfigField, string> = {
  chartType: 'controlPanel.chartType',
  yColumns: 'ai.field.yColumns',
  xAxisColumn: 'ai.field.xAxisColumn',
  denominatorColumn: 'ai.field.denominatorColumn',
  sampleSize: 'ai.field.sampleSize',
  chartLabel: 'controlPanel.chartTitle',
  zAxisLabel: 'controlPanel.xAxisLabel',
  yAxisLabel: 'controlPanel.yAxisLabel',
  showControlLimits: 'controlPanel.showControlLimits',
  showCenterLine: 'controlPanel.showCenterLine',
  showRuleViolations: 'controlPanel.highlightViolations',
  showSigma1: 'controlPanel.showSigma1',
  showSigma2: 'controlPanel.showSigma2',
  showSigma3: 'controlPanel.showSigma3',
  colorScheme: 'ai.field.colorScheme',
  ruleSet: 'ai.field.ruleSet',
};

const REJECT_REASON_KEYS: Record<AgentConfigRejectReason, string> = {
  unknownChartType: 'ai.evidence.reason.unknownChartType',
  unknownColumn: 'ai.evidence.reason.unknownColumn',
  noValidColumns: 'ai.evidence.reason.noValidColumns',
  unknownRuleSet: 'ai.evidence.reason.unknownRuleSet',
  invalidValue: 'ai.evidence.reason.invalidValue',
  staleDataset: 'ai.evidence.reason.staleDataset',
  editedDuringRequest: 'ai.evidence.reason.editedDuringRequest',
  dependsOnEditedSetting: 'ai.evidence.reason.dependsOnEditedSetting',
};

const STATUS_STYLES: Record<AgentConfigChangeStatus, { label: string; className: string; Icon: typeof Check }> = {
  applied: { label: 'ai.evidence.applied', className: 'bg-teal-100 text-teal-900', Icon: Check },
  unchanged: { label: 'ai.evidence.unchanged', className: 'bg-slate-100 text-slate-700', Icon: Minus },
  rejected: { label: 'ai.evidence.rejected', className: 'bg-red-100 text-red-900', Icon: Ban },
};

type Translate = (key: string) => string;

const StatusBadge: React.FC<{ status: AgentConfigChangeStatus }> = ({ status }) => {
  const { t } = useLanguage();
  const { label, className, Icon } = STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-medium ${className}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {t(label)}
    </span>
  );
};

const settingLabel = (field: string, t: Translate): string => (
  Object.prototype.hasOwnProperty.call(FIELD_LABEL_KEYS, field) ? t(FIELD_LABEL_KEYS[field as AgentConfigField]) : field
);

const rowNote = (change: AgentConfigChange, t: Translate): string[] => {
  const notes: string[] = [];
  if (change.status === 'rejected' && change.reason) {
    const asked = change.requested !== undefined ? formatAgentConfigValue(change.field, change.requested, t) : '';
    notes.push(`${t('ai.evidence.askedFor')} ${asked}`.trim());
    notes.push(t(REJECT_REASON_KEYS[change.reason]));
    if (change.reason === 'dependsOnEditedSetting' && change.detail?.length) {
      notes.push(`${t('ai.evidence.changedSettings')} ${change.detail.map((field) => settingLabel(field, t)).join(', ')}`);
    }
  }
  if (change.note === 'clamped') notes.push(`${t('ai.evidence.note.clamped')} (${t('ai.evidence.askedFor')} ${formatAgentConfigValue(change.field, change.requested ?? change.after, t)})`);
  if (change.note === 'lockedToYColumns') {
    notes.push(change.requested !== undefined
      ? `${t('ai.evidence.note.locked')} (${t('ai.evidence.askedFor')} ${formatAgentConfigValue(change.field, change.requested, t)})`
      : t('ai.evidence.note.locked'));
  }
  if (change.note === 'ignoredColumns' && change.detail?.length) {
    notes.push(`${t('ai.evidence.note.ignoredColumns')} ${change.detail.join(', ')}`);
  }
  return notes;
};

interface AgentConfigEvidenceViewProps {
  evidence: AgentConfigEvidence;
  /** Live settings, used to flag older replies whose applied values have since moved. */
  current: AgentConfigState;
  defaultOpen?: boolean;
}

export const AgentConfigEvidenceView: React.FC<AgentConfigEvidenceViewProps> = React.memo(({ evidence, current, defaultOpen = false }) => {
  const { t } = useLanguage();
  const superseded = useMemo(() => new Set(evaluateEvidenceCurrentness(evidence, current).supersededFields), [current, evidence]);
  const serverRejections = evidence.serverRejections ?? [];
  const { applied, unchanged, rejected } = evidence.counts;
  const counts = [
    applied > 0 ? `${t('ai.evidence.applied')} ${applied}` : null,
    unchanged > 0 ? `${t('ai.evidence.unchanged')} ${unchanged}` : null,
    rejected > 0 ? `${t('ai.evidence.rejected')} ${rejected}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <details
      open={defaultOpen}
      className="mt-3 border-t border-teal-200 pt-2 text-xs text-slate-700"
      data-testid="agent-config-evidence"
      data-outcome={evidence.outcome}
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 text-teal-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="font-semibold">{t('ai.evidence.title')}</span>
        <span>{t(EVIDENCE_OUTCOME_KEYS[evidence.outcome])}</span>
        {counts && <span className="text-slate-600">{counts}</span>}
        {superseded.size > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
            <History className="h-3 w-3" aria-hidden="true" />
            {t('ai.evidence.superseded')}
          </span>
        )}
      </summary>

      <p className="mt-1 text-[11px] text-slate-600">{t('ai.evidence.verified')}</p>

      {evidence.changes.length === 0 && serverRejections.length === 0 && (
        <p className="mt-2">{t('ai.evidence.noneRequested')}</p>
      )}

      {evidence.changes.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full table-fixed border-collapse text-start">
            <caption className="sr-only">{t('ai.evidence.title')}</caption>
            <thead>
              <tr className="text-[11px] text-slate-600">
                <th scope="col" className="pb-1 pe-2 text-start font-medium">{t('ai.evidence.setting')}</th>
                <th scope="col" className="pb-1 pe-2 text-start font-medium">{t('ai.evidence.before')}</th>
                <th scope="col" className="pb-1 pe-2 text-start font-medium">{t('ai.evidence.after')}</th>
                <th scope="col" className="pb-1 text-start font-medium">{t('ai.evidence.result')}</th>
              </tr>
            </thead>
            <tbody>
              {evidence.changes.map((change) => {
                const notes = rowNote(change, t);
                const moved = superseded.has(change.field);
                return (
                  <React.Fragment key={change.field}>
                    <tr
                      className="align-top"
                      data-field={change.field}
                      data-status={change.status}
                      data-before={JSON.stringify(change.before)}
                      data-after={JSON.stringify(change.after)}
                      {...(change.requested !== undefined ? { 'data-requested': JSON.stringify(change.requested) } : {})}
                    >
                      <th scope="row" className="py-1 pe-2 text-start font-medium text-slate-800">{t(FIELD_LABEL_KEYS[change.field])}</th>
                      <td className="break-words py-1 pe-2 text-slate-600">{formatAgentConfigValue(change.field, change.before, t)}</td>
                      <td className={`break-words py-1 pe-2 ${change.status === 'applied' ? 'font-semibold text-teal-900' : 'text-slate-600'}`}>
                        {formatAgentConfigValue(change.field, change.after, t)}
                      </td>
                      <td className="py-1"><StatusBadge status={change.status} /></td>
                    </tr>
                    {(notes.length > 0 || moved) && (
                      <tr>
                        <td colSpan={4} className="pb-1.5 text-[11px] text-slate-600">
                          {notes.map((note) => (
                            <span key={note} className={`block ${change.status === 'rejected' ? 'text-red-800' : ''}`}>{note}</span>
                          ))}
                          {moved && (
                            <span className="block text-amber-900">
                              {t('ai.evidence.now')} {formatAgentConfigValue(change.field, agentConfigValue(current, change.field), t)}
                            </span>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {serverRejections.length > 0 && (
        <div className="mt-2" data-testid="agent-config-service-rejections">
          <p className="text-[11px] font-medium text-slate-700">{t('ai.evidence.serverRejections')}</p>
          <ul className="mt-1 space-y-1.5">
            {serverRejections.map((entry, index) => (
              <li
                key={`${entry.field ?? entry.name}-${index}`}
                className="text-[11px] text-slate-600"
                data-source="service"
                data-status="rejected"
                {...(entry.field ? { 'data-field': entry.field } : {})}
                {...(entry.requested !== undefined ? { 'data-requested': JSON.stringify(entry.requested) } : {})}
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <StatusBadge status="rejected" />
                  <span className="break-words text-xs font-medium text-slate-800">
                    {entry.field ? settingLabel(entry.field, t) : entry.name || t('ai.evidence.unknownSetting')}
                  </span>
                </span>
                {entry.requested !== undefined && (
                  <span className="block break-words text-red-800">
                    {t('ai.evidence.askedFor')} {formatAgentConfigValue(entry.field, entry.requested, t)}
                  </span>
                )}
                <span className="block break-words text-red-800">{entry.message ?? t('ai.evidence.reason.serverRefused')}</span>
                {entry.field && (
                  <span className="block break-words">
                    {t('ai.evidence.now')} {formatAgentConfigValue(entry.field, agentConfigValue(current, entry.field), t)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {evidence.agentReason && (
        <p className="mt-2 text-[11px] text-slate-600">
          <span className="font-medium">{t('ai.evidence.agentReason')}</span> {evidence.agentReason}
        </p>
      )}
    </details>
  );
});
AgentConfigEvidenceView.displayName = 'AgentConfigEvidenceView';
