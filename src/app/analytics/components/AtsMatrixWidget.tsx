import React from 'react';

interface AtsRow {
  platform: string;
  started: number;
  submitted: number;
  submitRate: number;
  autoFillRate: number;
  medianManualFields: number;
  failedCount: number;
}

interface AtsMatrixWidgetProps {
  data: AtsRow[];
}

const formatPlatformName = (platform: string): string => {
  const labels: Record<string, string> = {
    linkedin_easy_apply: 'LinkedIn Easy Apply',
    greenhouse: 'Greenhouse',
    workday: 'Workday',
    indeed: 'Indeed',
    lever: 'Lever',
    ashby: 'Ashby',
    taleo: 'Oracle Taleo',
    applicant_tracking: 'ATS (Generic)',
  };
  return labels[platform] || platform;
};

const getCellHighlight = (key: string, value: number): string => {
  if (key === 'autoFillRate' && value < 50) return 'bg-orange-50';
  if (key === 'submitRate' && value < 60) return 'bg-red-50';
  return 'bg-white';
};

const getCellTextColor = (key: string, value: number): string => {
  if (key === 'autoFillRate' && value < 50) return 'text-orange-700 font-semibold';
  if (key === 'submitRate' && value < 60) return 'text-red-700 font-semibold';
  return 'text-gray-900';
};

export default function AtsMatrixWidget({ data }: AtsMatrixWidgetProps) {
  const sortedData = [...data].sort((a, b) => b.submitted - a.submitted);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-2">ATS Field-Fill Report</h2>
      <p className="text-sm text-gray-600 mb-6">
        This is your extension's field-fill reliability report
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-300 bg-gray-50">
              <th className="px-4 py-3 text-left font-semibold text-gray-900">Platform</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-900">Started</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-900">Submitted</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-900">Submit Rate</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-900">Auto-fill Rate</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-900">Manual Fields</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-900">Failures</th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((row) => (
              <tr key={row.platform} className="border-b border-gray-200 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{formatPlatformName(row.platform)}</td>
                <td className="px-4 py-3 text-right text-gray-700">{row.started}</td>
                <td className="px-4 py-3 text-right font-semibold text-gray-900">{row.submitted}</td>
                <td className={`px-4 py-3 text-right ${getCellTextColor('submitRate', row.submitRate)} ${getCellHighlight('submitRate', row.submitRate)}`}>
                  {row.submitRate.toFixed(1)}%
                </td>
                <td className={`px-4 py-3 text-right ${getCellTextColor('autoFillRate', row.autoFillRate)} ${getCellHighlight('autoFillRate', row.autoFillRate)}`}>
                  {row.autoFillRate.toFixed(1)}%
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{row.medianManualFields}</td>
                <td className="px-4 py-3 text-right text-gray-700">{row.failedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sortedData.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500">No ATS platform data available yet.</p>
        </div>
      )}
    </div>
  );
}
