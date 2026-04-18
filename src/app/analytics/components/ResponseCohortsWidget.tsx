import React from 'react';

interface ResponseCohort {
  week: string;
  applied: number;
  responded: number;
  responsePct: number;
  medianDaysToResponse: number;
}

interface ResponseCohortsWidgetProps {
  cohorts: ResponseCohort[];
}

const getResponseColor = (pct: number): string => {
  if (pct > 20) return 'bg-green-50 text-green-700';
  if (pct > 10) return 'bg-yellow-50 text-yellow-700';
  return 'bg-red-50 text-red-700';
};

const getResponseTextColor = (pct: number): string => {
  if (pct > 20) return 'text-green-700 font-semibold';
  if (pct > 10) return 'text-yellow-700 font-semibold';
  return 'text-red-700 font-semibold';
};

export default function ResponseCohortsWidget({ cohorts }: ResponseCohortsWidgetProps) {
  const sortedCohorts = [...cohorts].sort((a, b) => {
    const dateA = new Date(a.week);
    const dateB = new Date(b.week);
    return dateB.getTime() - dateA.getTime();
  });

  const hasInsufficientData = sortedCohorts.length < 2;

  if (hasInsufficientData) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-6">Response Cohorts</h2>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="text-gray-400 mb-3">
            <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h3 className="font-semibold text-gray-900 mb-1">Awaiting data...</h3>
          <p className="text-sm text-gray-600 max-w-md">
            Move applications to Interview/Offer in the pipeline to populate response data
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-6">Response Cohorts</h2>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-300 bg-gray-50">
              <th className="px-4 py-3 text-left font-semibold text-gray-900">Week</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-900">Applied</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-900">Responded</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-900">Response %</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-900">Median Days to Response</th>
            </tr>
          </thead>
          <tbody>
            {sortedCohorts.map((cohort) => {
              const weekDate = new Date(cohort.week);
              const weekLabel = weekDate.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: '2-digit',
              });

              return (
                <tr key={cohort.week} className="border-b border-gray-200 hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{weekLabel}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{cohort.applied}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{cohort.responded}</td>
                  <td className={`px-4 py-3 text-right rounded ${getResponseColor(cohort.responsePct)} ${getResponseTextColor(cohort.responsePct)}`}>
                    {cohort.responsePct.toFixed(1)}%
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {cohort.medianDaysToResponse} days
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded text-xs text-blue-700">
        Move applications to Interview/Offer in the pipeline to populate response data
      </div>
    </div>
  );
}
