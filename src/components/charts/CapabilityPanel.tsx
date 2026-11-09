import React from 'react';
import { AlertTriangle, CheckCircle2, MinusCircle } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { useLanguage } from '../../context/LanguageContext';
import type { CapabilityReadiness } from '../../types/DataTypes';
import { calculateCapabilityIndices } from '../../utils/spcCalculations';

const READINESS_STYLES: Record<CapabilityReadiness, { tone: string; chip: string; Icon: typeof CheckCircle2 }> = {
  ready: { tone: 'border-emerald-200 bg-emerald-50 text-emerald-900', chip: 'bg-emerald-100 text-emerald-900', Icon: CheckCircle2 },
  preliminary: { tone: 'border-amber-200 bg-amber-50 text-amber-900', chip: 'bg-amber-100 text-amber-900', Icon: AlertTriangle },
  notApplicable: { tone: 'border-slate-200 bg-slate-50 text-slate-800', chip: 'bg-slate-200 text-slate-800', Icon: MinusCircle },
};

const isNumber = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

const CapabilityPanel: React.FC = () => {
  const { processedData, chartOptions } = useAppContext();
  const { t } = useLanguage();

  if (!processedData) return null;

  const { controlLimits, capabilityStatus: capability } = processedData;
  const readiness: CapabilityReadiness = capability?.readiness ?? 'notApplicable';
  const { tone, chip, Icon } = READINESS_STYLES[readiness];

  // Capability is about individual observations, so it uses the within-process σ, not the plotted statistic's σ.
  const withinSigma = controlLimits.processSigma ?? controlLimits.sigma;
  const fallback = capability
    ? null
    : calculateCapabilityIndices(controlLimits.centerLine, withinSigma, {
      lowerSpecLimit: chartOptions.lowerSpecLimit,
      upperSpecLimit: chartOptions.upperSpecLimit,
    });
  const indices = capability?.indices;

  const tiles: Array<{ label: string; help: string; value: number | null | undefined }> = [
    { label: 'Cp', help: t('capability.index.cp'), value: indices?.cp ?? fallback?.cp },
    { label: 'Cpl', help: t('capability.index.cpl'), value: indices?.cpl ?? fallback?.cpl },
    { label: 'Cpu', help: t('capability.index.cpu'), value: indices?.cpu ?? fallback?.cpu },
    { label: 'Cpk', help: t('capability.index.cpk'), value: indices?.cpk ?? fallback?.cpk },
    { label: 'Pp', help: t('capability.index.pp'), value: indices?.pp },
    { label: 'Ppl', help: t('capability.index.ppl'), value: indices?.ppl },
    { label: 'Ppu', help: t('capability.index.ppu'), value: indices?.ppu },
    { label: 'Ppk', help: t('capability.index.ppk'), value: indices?.ppk },
    { label: 'Cpm', help: t('capability.index.cpm'), value: indices?.cpm },
  ];

  const estimate = capability?.sigmaEstimate;
  const within = estimate?.within ?? withinSigma;
  const method = estimate?.method ?? controlLimits.sigmaMethod;
  const fmt = (value: number | null | undefined, decimals = 4) => (isNumber(value) ? value.toFixed(decimals) : t('capability.unavailable'));

  return (
    <div className={`mt-4 rounded-md border p-4 ${tone}`} data-testid="capability-panel" data-readiness={readiness}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{t('chartPanel.capabilityPerformance')}</p>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${chip}`}>
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {t(`capability.readiness.${readiness}`)}
        </span>
      </div>
      <p className="mt-1 text-xs">{t(`capability.meaning.${readiness}`)}</p>

      {capability?.reasons?.length ? (
        <div className="mt-3">
          <p className="text-xs font-semibold">{t('capability.reasons')}</p>
          <ul className="mt-1 list-disc ps-5 text-xs">
            {capability.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        {tiles.map(({ label, help, value }) => (
          <div key={label} className="rounded-sm bg-white/80 p-2" data-index={label}>
            <dt className="text-[11px] font-medium">{label}</dt>
            <dd
              className="text-sm font-semibold tabular-nums"
              {...(isNumber(value) ? {} : { 'aria-label': t('capability.unavailable') })}
            >
              {isNumber(value) ? value.toFixed(4) : '—'}
            </dd>
            <dd className="mt-0.5 text-[11px] leading-snug opacity-90">{help}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 text-xs" data-testid="capability-sigma">
        <p className="font-semibold">{t('capability.sigmaTitle')}</p>
        <p className="mt-0.5 tabular-nums">
          {t('capability.sigmaWithin')}: {fmt(within)}
          {method ? ` (${method})` : ''}
          {estimate ? ` · ${t('capability.sigmaOverall')}: ${fmt(estimate.overall)} · ${t('capability.observations')}: ${estimate.observationCount}` : ''}
        </p>
      </div>
    </div>
  );
};

export default CapabilityPanel;
