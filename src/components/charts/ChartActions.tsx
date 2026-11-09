import React from 'react';
import { Download, Printer } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { exportAsCSV } from '../../utils/fileUtils';

const ChartActions: React.FC = () => {
  const { processedData, selectedChartType } = useAppContext();
  
  const handleExportData = () => {
    if (!processedData) return;
    
    // Add control limits to the exported data
    const { data, controlLimits } = processedData;
    const exportData = data.map((row) => ({
      ...row,
      CenterLine: controlLimits.centerLine,
      UCL: controlLimits.ucl,
      LCL: controlLimits.lcl
    }));
    
    exportAsCSV(exportData, `spc_data_${selectedChartType}_${new Date().toISOString().slice(0, 10)}.csv`);
  };
  
  const handlePrintChart = () => {
    window.print();
  };
  
  return (
    <div className="flex items-center space-x-2">
      <button
        className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
        onClick={handleExportData}
        disabled={!processedData}
      >
        <Download size={16} className="mr-1" />
        Export
      </button>
      
      <button
        className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
        onClick={handlePrintChart}
        disabled={!processedData}
      >
        <Printer size={16} className="mr-1" />
        Print
      </button>
    </div>
  );
};

export default ChartActions;
