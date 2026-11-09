import React from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { useLanguage } from '../../context/LanguageContext';
import { getRuleDescriptions } from '../../utils/westernElectricRules';
import {
  activeRuleSet,
  groupRuleViolations,
  sigmaRange,
  sigmaZones,
  type RuleGroup,
} from './ruleSummary';

const MAX_POINTS_SHOWN = 24;
const MAX_WINDOWS_SHOWN = 6;

const fmt = (value: number | null | undefined, decimals = 3): string => (
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(decimals) : '—'
);

const RuleSignals: React.FC<{ group: RuleGroup; description: string }> = ({ group, description }) => {
  const { t } = useLanguage();
  const shownPoints = group.points.slice(0, MAX_POINTS_SHOWN);
  const shownWindows = group.windows.slice(0, MAX_WINDOWS_SHOWN);
  const count = group.points.length;
  const hiddenWindows = Math.max(0, group.signalTotal - shownWindows.length);
  return (
    <details className="rounded-md bg-gray-50 p-3" data-testid={`rule-group-${group.ruleNumber}`}>
      <summary className="cursor-pointer text-sm text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600">
        <span className="font-medium">{t('ruleViolations.rule')} {group.ruleNumber}: {description}</span>
        <span className="ms-2 text-gray-600">
          {group.signalTotal} {group.signalTotal === 1 ? t('ruleViolations.signalOne') : t('ruleViolations.signalMany')}
          {' · '}
          {count} {count === 1 ? t('ruleViolations.pointFlagged') : t('ruleViolations.pointsFlagged')}
        </span>
      </summary>
      <div className="mt-2 space-y-1 text-xs text-gray-700">
        <p>
          <span className="font-medium">{t('ruleViolations.points')}:</span>{' '}
          {shownPoints.join(', ')}
          {group.points.length > shownPoints.length && ` +${group.points.length - shownPoints.length} ${t('ruleViolations.moreItems')}`}
        </p>
        {shownWindows.length > 0 && (
          <p>
            <span className="font-medium">{t('ruleViolations.windowRange')}:</span>{' '}
            {shownWindows
              .map((window) => (window.start === window.end
                ? `${window.signalAt}`
                : `${window.start}–${window.end} (${t('ruleViolations.signalAt')} ${window.signalAt})`))
              .join('; ')}
            {hiddenWindows > 0 && ` +${hiddenWindows} ${t('ruleViolations.moreItems')}`}
          </p>
        )}
      </div>
    </details>
  );
};

const RuleViolationsPanel: React.FC = () => {
  const { processedData, chartOptions } = useAppContext();
  const { t } = useLanguage();

  if (!processedData) {
    return (
      <div>
        <h3 className="text-lg font-medium text-gray-800 mb-3">{t('ruleViolations.title')}</h3>
        <p className="text-gray-500">{t('ruleViolations.uploadData')}</p>
      </div>
    );
  }

  const {
    ruleViolations,
    variationRuleViolations = [],
    controlLimits,
    diagnostics = [],
    chartRecommendations = [],
  } = processedData;

  const ruleSet = activeRuleSet(ruleViolations, chartOptions.ruleSet);
  const rules = getRuleDescriptions(ruleSet);
  const descriptionFor = (ruleNumber: number) => rules.find((rule) => rule.ruleNumber === ruleNumber)?.description ?? '';
  const mainGroups = groupRuleViolations(ruleViolations);
  const variationGroups = groupRuleViolations(variationRuleViolations);
  const hitsByRule = new Map(mainGroups.map((group) => [group.ruleNumber, group]));

  const totalSignals = [...mainGroups, ...variationGroups].reduce((sum, group) => sum + group.signalTotal, 0);
  const isProcessInControl = ruleViolations.length + variationRuleViolations.length === 0;
  const ruleTypeCount = mainGroups.length + variationGroups.length;
  const sigma = sigmaRange(controlLimits);
  const zones = sigmaZones(controlLimits.centerLine, controlLimits.sigma);
  const processSigma = controlLimits.processSigma;
  const showProcessSigma = typeof processSigma === 'number' && Number.isFinite(processSigma)
    && Math.abs(processSigma - controlLimits.sigma) > 1e-12;
  const setLabel = ruleSet === 'westernElectric' ? t('rules.set.westernElectric') : t('rules.set.nelson');
  const setNote = ruleSet === 'westernElectric' ? t('rules.set.westernElectricNote') : t('rules.set.nelsonNote');

  return (
    <div>
      <h3 className="text-lg font-medium text-gray-800 mb-3">{t('ruleViolations.title')}</h3>

      {/* Process Status */}
      <div
        className={`p-3 rounded-md mb-4 ${isProcessInControl ? 'bg-green-50' : 'bg-red-50'}`}
        role="status"
        data-testid="process-status"
        data-in-control={isProcessInControl}
      >
        <div className="flex items-center">
          {isProcessInControl ? (
            <div className="flex items-center text-green-800">
              <CheckCircle2 size={20} className="me-2" aria-hidden="true" />
              <p className="font-medium">{t('ruleViolations.inControl')}</p>
            </div>
          ) : (
            <div className="flex items-center text-red-800">
              <AlertTriangle size={20} className="me-2" aria-hidden="true" />
              <p className="font-medium">{t('ruleViolations.outOfControl')}</p>
            </div>
          )}
        </div>
        <p className={`text-sm mt-1 ${isProcessInControl ? 'text-green-800' : 'text-red-800'}`}>
          {isProcessInControl
            ? t('ruleViolations.noViolations')
            : `${totalSignals} ${t('ruleViolations.violationsDetected')} ${ruleTypeCount} ${t('ruleViolations.ruleTypes')}`}
        </p>
        <p className="mt-1 text-xs text-gray-700">
          {t('ruleViolations.checkedWith')}: <span className="font-medium">{setLabel}</span>
        </p>
      </div>

      {diagnostics.length > 0 && (
        <div className="mb-4">
          <h4 className="font-medium text-gray-700 mb-2">{t('ruleViolations.diagnostics')}</h4>
          <div className="space-y-2">
            {diagnostics.slice(0, 5).map((diagnostic) => (
              <div
                key={`${diagnostic.code}-${diagnostic.message}`}
                className={`rounded-md p-3 text-sm ${
                  diagnostic.severity === 'blocker'
                    ? 'bg-red-50 text-red-800'
                    : diagnostic.severity === 'warning'
                      ? 'bg-amber-50 text-amber-900'
                      : 'bg-blue-50 text-blue-800'
                }`}
              >
                <span className="font-medium uppercase text-[11px]">{diagnostic.severity}</span>
                <p>{diagnostic.message}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {chartRecommendations.length > 0 && (
        <div className="mb-4">
          <h4 className="font-medium text-gray-700 mb-2">{t('ruleViolations.recommendations')}</h4>
          <div className="space-y-2">
            {chartRecommendations.slice(0, 3).map((item) => (
              <div key={`${item.chartType}-${item.reason}`} className="rounded-md bg-gray-50 p-3 text-sm">
                <p className="font-medium text-gray-800">{item.chartType} · {item.status}</p>
                <p className="text-gray-600">{item.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Signals */}
      {!isProcessInControl && (
        <div className="mb-4">
          <h4 className="font-medium text-gray-700 mb-2">{t('ruleViolations.summary')}</h4>
          <p className="mb-2 text-xs text-gray-600">{t('ruleViolations.pointNote')}</p>
          <div className="space-y-2">
            {mainGroups.length > 0 && variationGroups.length > 0 && (
              <p className="text-xs font-medium text-gray-700">{t('ruleViolations.processChart')}</p>
            )}
            {mainGroups.map((group) => (
              <RuleSignals key={`main-${group.ruleNumber}`} group={group} description={descriptionFor(group.ruleNumber)} />
            ))}
            {variationGroups.length > 0 && (
              <p className="pt-1 text-xs font-medium text-gray-700">{t('ruleViolations.variationChart')}</p>
            )}
            {variationGroups.map((group) => (
              <RuleSignals key={`variation-${group.ruleNumber}`} group={group} description={descriptionFor(group.ruleNumber)} />
            ))}
          </div>
        </div>
      )}

      {/* Control limits and σ */}
      <div className="mb-4">
        <h4 className="font-medium text-gray-700 mb-2">{t('ruleViolations.controlLimits')}</h4>
        <div className="bg-gray-50 p-3 rounded-md">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <p className="text-gray-600">{t('ruleViolations.centerLine')}</p>
              <p className="font-medium tabular-nums">{fmt(controlLimits.centerLine)}</p>
            </div>
            <div>
              <p className="text-gray-600">{t('ruleViolations.sigmaPlotted')}:</p>
              <p className="font-medium tabular-nums">{sigma.varies ? `${fmt(sigma.min)} – ${fmt(sigma.max)}` : fmt(controlLimits.sigma)}</p>
            </div>
            <div>
              <p className="text-gray-600">{t('ruleViolations.ucl')}</p>
              <p className="font-medium tabular-nums">{fmt(controlLimits.ucl)}</p>
            </div>
            <div>
              <p className="text-gray-600">{t('ruleViolations.lcl')}</p>
              <p className="font-medium tabular-nums">{fmt(controlLimits.lcl)}</p>
            </div>
          </div>
          <details className="mt-3 text-sm" data-testid="sigma-explanation">
            <summary className="cursor-pointer font-medium text-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600">
              {t('ruleViolations.sigmaTitle')}
            </summary>
            <div className="mt-2 space-y-2 text-xs text-gray-700">
              <p>{t('ruleViolations.sigmaExplain')}</p>
              <p>{t('chartPanel.sigmaPlottedHint')}</p>
              {sigma.varies && <p>{t('ruleViolations.sigmaVaries')}</p>}
              {showProcessSigma && (
                <p>
                  <span className="font-medium">{t('ruleViolations.sigmaProcess')}:</span> {fmt(processSigma)}
                  {controlLimits.sigmaMethod ? ` · ${t('ruleViolations.sigmaMethod')} ${controlLimits.sigmaMethod}` : ''}
                </p>
              )}
              <table className="w-full border-collapse text-start tabular-nums">
                <tbody>
                  {zones.map((zone) => (
                    <tr key={zone.key} className="border-t border-gray-200">
                      <th scope="row" className="py-1 pe-2 text-start font-medium">{t(`ruleViolations.${zone.key}`)}</th>
                      <td className="py-1">
                        {fmt(zone.lower[0])} … {fmt(zone.lower[1])} · {fmt(zone.upper[0])} … {fmt(zone.upper[1])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </div>

      {/* Rules checked */}
      <div>
        <h4 className="font-medium text-gray-700 mb-1">{t('ruleViolations.rulesChecked')}</h4>
        <p className="mb-2 text-xs text-gray-600">
          <span className="font-medium">{setLabel}.</span> {setNote}
        </p>
        <div className="bg-gray-50 p-3 rounded-md text-sm">
          <ul className="space-y-1" data-testid="rules-checked">
            {rules.map((rule) => {
              const hit = hitsByRule.get(rule.ruleNumber);
              const hits = hit?.signalTotal ?? 0;
              return (
                <li key={rule.ruleNumber} className="flex items-start justify-between gap-3 text-gray-700">
                  <span><span className="font-medium tabular-nums">{rule.ruleNumber}.</span> {rule.description}</span>
                  <span className={`shrink-0 text-xs ${hit ? 'font-medium text-red-800' : 'text-gray-600'}`}>
                    {hit ? `${hits} ${hits === 1 ? t('ruleViolations.signalOne') : t('ruleViolations.signalMany')} · ${hit.points.length} ${hit.points.length === 1 ? t('ruleViolations.pointFlagged') : t('ruleViolations.pointsFlagged')}` : t('ruleViolations.noSignals')}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default RuleViolationsPanel;
