import React, { useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import { chartMeta } from '../../types/chartMeta';

const SectionTitle: React.FC<{children: React.ReactNode}> = ({ children }) => (
  <h4 className="text-sm font-semibold text-gray-700 mt-3 mb-1">{children}</h4>
);

const BulletList: React.FC<{items: string[]; className?: string}> = ({ items, className }) => (
  <ul className={`list-disc ml-5 space-y-0.5 text-sm text-gray-700 ${className || ''}`}>
    {items.map((x, i) => <li key={i}>{x}</li>)}
  </ul>
);

const ChartTypeInfo: React.FC = () => {
  const { selectedChartType } = useAppContext();
  const meta = chartMeta[selectedChartType];
  const [showUseCases, setShowUseCases] = useState(false);

  if (!meta) return null;

  return (
    <div className="mt-4 border-t border-gray-200 pt-4">
      <div>
        <p className="text-sm text-gray-800"><span className="font-semibold">{meta.name}: </span>{meta.description}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
        <div>
          <SectionTitle>Strengths</SectionTitle>
          <BulletList items={meta.strengths} />
        </div>
        <div>
          <SectionTitle>Weaknesses</SectionTitle>
          <BulletList items={meta.weaknesses} />
        </div>
      </div>

      <div className="mt-3">
        <SectionTitle>Data Expectations</SectionTitle>
        <BulletList items={meta.dataExpectations} />
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={() => setShowUseCases(s => !s)}
          className="text-sm text-blue-600 hover:text-blue-800 focus:outline-hidden focus:underline"
        >
          {showUseCases ? 'Hide Example Use Cases' : 'Show Example Use Cases'}
        </button>
        {showUseCases && (
          <div className="mt-2 space-y-3">
            {meta.exampleUseCases.map((uc, idx) => (
              <div key={idx} className="rounded-md border border-gray-200 bg-gray-50 p-3">
                <p className="text-sm font-semibold text-gray-800">{uc.title}</p>
                <p className="text-xs text-gray-600 mt-1"><span className="font-medium">Scenario:</span> {uc.scenario}</p>
                <p className="text-xs text-gray-600 mt-1"><span className="font-medium">Why Useful:</span> {uc.whyUseful}</p>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="mt-3 text-[11px] text-gray-400 leading-snug">Note: Guidance tailored for semiconductor manufacturing contexts (fabs, metrology, process modules).</p>
    </div>
  );
};

export default ChartTypeInfo;
