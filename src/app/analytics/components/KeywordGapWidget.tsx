'use client';

import React from 'react';

interface KeywordGap {
  keyword: string;
  count: number;
}

interface KeywordGapWidgetProps {
  keywordGaps: KeywordGap[];
}

export default function KeywordGapWidget({ keywordGaps }: KeywordGapWidgetProps) {
  if (!keywordGaps || keywordGaps.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Keyword Gap Report</h3>
        <p className="text-sm text-gray-500 mb-4">Keywords appearing most in job descriptions you didn't match</p>
        <div className="text-center py-8">
          <p className="text-gray-400 text-sm">No keyword data yet — apply to 5+ jobs to see gaps</p>
        </div>
      </div>
    );
  }

  // Sort by count descending and take top 20
  const topKeywords = [...keywordGaps]
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const maxCount = topKeywords[0]?.count || 1;
  const maxBarWidth = 300;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-1">Keyword Gap Report</h3>
      <p className="text-sm text-gray-500 mb-6">Keywords appearing most in job descriptions you didn't match</p>

      <div className="space-y-4">
        {topKeywords.map((item, idx) => {
          const barWidth = (item.count / maxCount) * maxBarWidth;
          return (
            <div key={idx} className="flex items-center gap-3">
              <div className="flex-1 flex items-center">
                <div
                  className="bg-blue-500 h-6 rounded transition-all"
                  style={{ width: `${barWidth}px` }}
                />
              </div>
              <div className="flex items-center gap-2 min-w-fit">
                <span className="text-sm text-gray-700 font-medium">{item.keyword}</span>
                <span className="text-sm text-gray-500">({item.count})</span>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-gray-400 mt-4">Add these to your base resume to improve match rates</p>
    </div>
  );
}
