'use client';

import React from 'react';

interface FailureLog {
  jobId: string;
  jobTitle?: string;
  company?: string;
  atsPlatform?: string;
  stage?: string;
  errorCode?: string;
  errorMessage?: string;
  timestamp?: string;
  jobUrl?: string;
}

interface FailureLogWidgetProps {
  failureLog: FailureLog[];
}

function formatTime(timestamp?: string): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getStageColor(stage?: string): string {
  switch (stage) {
    case 'discover':
      return 'bg-blue-100 text-blue-800';
    case 'analyze':
      return 'bg-purple-100 text-purple-800';
    case 'open_ats':
      return 'bg-cyan-100 text-cyan-800';
    case 'fill':
      return 'bg-amber-100 text-amber-800';
    case 'submit':
      return 'bg-orange-100 text-orange-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

export default function FailureLogWidget({ failureLog }: FailureLogWidgetProps) {
  if (!failureLog || failureLog.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Failure Log</h3>
        <p className="text-sm text-gray-500 mb-4">Most recent failed applications</p>
        <div className="text-center py-8">
          <p className="text-gray-400 text-sm">No failures recorded — great news!</p>
        </div>
      </div>
    );
  }

  // Take most recent 20
  const recentFailures = failureLog.slice(0, 20);

  // Group by atsPlatform
  const grouped: Record<string, FailureLog[]> = {};
  recentFailures.forEach((failure) => {
    const platform = failure.atsPlatform || 'Unknown';
    if (!grouped[platform]) grouped[platform] = [];
    grouped[platform].push(failure);
  });

  const platformOrder = Object.keys(grouped).sort();

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-1">Failure Log</h3>
      <p className="text-sm text-gray-500 mb-4">Most recent failed applications</p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left px-3 py-2 font-semibold text-gray-700">Time</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-700">Company</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-700">Job Title</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-700">ATS</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-700">Stage</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-700">Error</th>
            </tr>
          </thead>
          <tbody>
            {platformOrder.map((platform) => [
              <tr key={`header-${platform}`}>
                <td colSpan={6} className="px-3 py-2 bg-gray-50 font-semibold text-xs text-gray-600 uppercase tracking-wide">
                  {platform}
                </td>
              </tr>,
              ...grouped[platform].map((failure, idx) => (
                <tr key={`${platform}-${idx}`} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-700">{formatTime(failure.timestamp)}</td>
                  <td className="px-3 py-2">
                    {failure.jobUrl ? (
                      <a href={failure.jobUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">
                        {failure.company || '—'}
                      </a>
                    ) : (
                      <span className="text-gray-700 font-medium">{failure.company || '—'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {failure.jobUrl ? (
                      <a href={failure.jobUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                        {failure.jobTitle || '—'}
                      </a>
                    ) : (
                      <span className="text-gray-700">{failure.jobTitle || '—'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{platform}</td>
                  <td className="px-3 py-2">
                    {failure.stage && (
                      <span className={`px-2 py-1 rounded text-xs font-semibold ${getStageColor(failure.stage)}`}>
                        {failure.stage.replace('_', ' ')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-600 text-xs">
                    {failure.errorCode && <div>{failure.errorCode}</div>}
                    {failure.errorMessage && <div className="text-gray-500">{failure.errorMessage}</div>}
                  </td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
    </div>
  );
}
