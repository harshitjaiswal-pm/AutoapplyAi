'use client';

import React from 'react';

interface EffortOutcome {
  totalMinutesInvested: number;
  totalSubmitted: number;
  totalResponded: number;
  totalInterviews: number;
  totalOffers: number;
  minutesPerSubmit: number | null;
  minutesPerResponse: number | null;
  minutesPerInterview: number | null;
  minutesPerOffer: number | null;
  note?: string;
}

interface EffortOutcomeWidgetProps {
  effortOutcome: EffortOutcome;
}

function formatMinutes(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }
  return `${Math.round(minutes)}m`;
}

export default function EffortOutcomeWidget({ effortOutcome }: EffortOutcomeWidgetProps) {
  const metrics = [
    {
      title: 'Minutes per Submit',
      value: effortOutcome.minutesPerSubmit,
    },
    {
      title: 'Minutes per Response',
      value: effortOutcome.minutesPerResponse,
    },
    {
      title: 'Minutes per Interview',
      value: effortOutcome.minutesPerInterview,
    },
    {
      title: 'Minutes per Offer',
      value: effortOutcome.minutesPerOffer,
    },
  ];

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-6">Effort & Outcome</h3>

      {/* 2x2 Grid of metric cards */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        {metrics.map((metric, idx) => (
          <div
            key={idx}
            className="bg-gray-50 rounded-lg border border-gray-100 p-4 flex flex-col items-center justify-center"
          >
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{metric.title}</p>
            <p className="text-2xl font-bold text-gray-900">{formatMinutes(metric.value)}</p>
          </div>
        ))}
      </div>

      {/* Total stats row */}
      <div className="border-t border-gray-200 pt-4 mb-3">
        <p className="text-sm text-gray-700">
          <span className="font-semibold">{effortOutcome.totalMinutesInvested}</span> minutes total invested |{' '}
          <span className="font-semibold">{effortOutcome.totalSubmitted}</span> applications submitted |{' '}
          <span className="font-semibold">{effortOutcome.totalResponded}</span> responses |{' '}
          <span className="font-semibold">{effortOutcome.totalInterviews}</span> interviews |{' '}
          <span className="font-semibold">{effortOutcome.totalOffers}</span> offers
        </p>
      </div>

      {/* Optional note */}
      {effortOutcome.note && (
        <p className="text-xs italic text-gray-500">{effortOutcome.note}</p>
      )}
    </div>
  );
}
