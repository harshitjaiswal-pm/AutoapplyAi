import React, { useState } from 'react';

interface FunnelStage {
  name: string;
  count: number;
  conversionPct: number;
}

interface FunnelWidgetProps {
  stages: FunnelStage[];
  note?: string;
  onStageClick?: (stageName: string) => void;
  dateRange?: '7d' | '30d' | 'all';
  onDateRangeChange?: (range: '7d' | '30d' | 'all') => void;
}

const getConversionColor = (pct: number): string => {
  if (pct > 20) return 'text-green-600';
  if (pct > 5) return 'text-yellow-600';
  return 'text-red-600';
};

const getConversionBg = (pct: number): string => {
  if (pct > 20) return 'bg-green-50';
  if (pct > 5) return 'bg-yellow-50';
  return 'bg-red-50';
};

export default function FunnelWidget({
  stages,
  note,
  onStageClick,
  dateRange = '30d',
  onDateRangeChange,
}: FunnelWidgetProps) {
  const [selectedRange, setSelectedRange] = useState<'7d' | '30d' | 'all'>(dateRange);

  const handleRangeChange = (range: '7d' | '30d' | 'all') => {
    setSelectedRange(range);
    onDateRangeChange?.(range);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Application Funnel</h2>
        <div className="flex gap-2">
          {(['7d', '30d', 'all'] as const).map((range) => (
            <button
              key={range}
              onClick={() => handleRangeChange(range)}
              className={`px-3 py-1 rounded text-sm font-medium transition ${
                selectedRange === range
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {range === '7d' ? '7d' : range === '30d' ? '30d' : 'All'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-4">
        {stages.map((stage, idx) => (
          <React.Fragment key={stage.name}>
            <button
              onClick={() => onStageClick?.(stage.name)}
              className="flex flex-col items-center gap-1 p-3 rounded border border-gray-300 hover:border-blue-500 hover:bg-blue-50 transition cursor-pointer whitespace-nowrap"
            >
              <div className="text-sm font-medium text-gray-900">{stage.name}</div>
              <div className="text-lg font-bold text-gray-900">{stage.count}</div>
            </button>

            {idx < stages.length - 1 && (
              <div className="flex flex-col items-center gap-1">
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <div className={`text-xs font-semibold ${getConversionColor(stages[idx + 1]?.conversionPct || 0)}`}>
                  {stages[idx + 1]?.conversionPct?.toFixed(1) || '0'}%
                </div>
              </div>
            )}
          </React.Fragment>
        ))}
      </div>

      {note && (
        <div className="mt-4 p-3 bg-gray-50 border border-gray-200 rounded text-xs text-gray-600">
          {note}
        </div>
      )}
    </div>
  );
}
