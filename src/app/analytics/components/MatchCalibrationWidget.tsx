import React, { useState } from 'react';

interface MatchDataPoint {
  jobId: string;
  jobTitle: string;
  company: string;
  matchScore: number;
  outcome: 'submitted' | 'recruiter_reply' | 'interview_invite' | 'offer' | 'rejection';
}

interface MatchCalibrationWidgetProps {
  data: MatchDataPoint[];
}

const outcomeToY = (outcome: string): number => {
  const map: Record<string, number> = {
    rejection: -1,
    submitted: 0,
    recruiter_reply: 1,
    interview_invite: 2,
    offer: 3,
  };
  return map[outcome] || 0;
};

const outcomeLabel = (outcome: string): string => {
  const labels: Record<string, string> = {
    rejection: 'Rejection',
    submitted: 'Submitted',
    recruiter_reply: 'Recruiter Reply',
    interview_invite: 'Interview Invite',
    offer: 'Offer',
  };
  return labels[outcome] || outcome;
};

const outcomeColor = (outcome: string): string => {
  const colors: Record<string, string> = {
    rejection: '#EF4444',
    submitted: '#9CA3AF',
    recruiter_reply: '#3B82F6',
    interview_invite: '#10B981',
    offer: '#F59E0B',
  };
  return colors[outcome] || '#999';
};

export default function MatchCalibrationWidget({ data }: MatchCalibrationWidgetProps) {
  const [hoveredPoint, setHoveredPoint] = useState<MatchDataPoint | null>(null);

  if (data.length < 5) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-6">Match Score Calibration</h2>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="text-gray-400 mb-3">
            <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 12a5 5 0 1110 0A5 5 0 017 12z" />
            </svg>
          </div>
          <h3 className="font-semibold text-gray-900 mb-1">Not enough data yet</h3>
          <p className="text-sm text-gray-600">
            Need 5+ applications with match scores to display calibration
          </p>
        </div>
      </div>
    );
  }

  const svgWidth = 600;
  const svgHeight = 400;
  const padding = { top: 40, right: 40, bottom: 80, left: 60 };
  const plotWidth = svgWidth - padding.left - padding.right;
  const plotHeight = svgHeight - padding.top - padding.bottom;

  // Scale functions
  const xScale = (score: number): number => {
    return padding.left + (score / 100) * plotWidth;
  };

  const yScale = (outcome: number): number => {
    // Outcomes range from -1 to 3 (5 possible values)
    const scaledY = ((outcome + 1) / 4) * plotHeight;
    return padding.top + plotHeight - scaledY;
  };

  const outcomes = ['rejection', 'submitted', 'recruiter_reply', 'interview_invite', 'offer'];

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-6">Match Score Calibration</h2>

      <div className="flex flex-col lg:flex-row gap-8">
        <div className="flex-1 overflow-x-auto">
          <svg width={svgWidth} height={svgHeight} className="border border-gray-200 bg-white rounded">
            {/* Grid lines */}
            {[0, 20, 40, 60, 80, 100].map((tick) => (
              <line
                key={`grid-x-${tick}`}
                x1={xScale(tick)}
                y1={padding.top}
                x2={xScale(tick)}
                y2={svgHeight - padding.bottom}
                stroke="#E5E7EB"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            ))}

            {/* Axes */}
            <line
              x1={padding.left}
              y1={padding.top}
              x2={padding.left}
              y2={svgHeight - padding.bottom}
              stroke="#333"
              strokeWidth={2}
            />
            <line
              x1={padding.left}
              y1={svgHeight - padding.bottom}
              x2={svgWidth - padding.right}
              y2={svgHeight - padding.bottom}
              stroke="#333"
              strokeWidth={2}
            />

            {/* X-axis labels */}
            {[0, 20, 40, 60, 80, 100].map((tick) => (
              <g key={`x-label-${tick}`}>
                <text
                  x={xScale(tick)}
                  y={svgHeight - padding.bottom + 20}
                  textAnchor="middle"
                  className="text-xs fill-gray-600"
                >
                  {tick}
                </text>
              </g>
            ))}

            {/* Y-axis labels */}
            {outcomes.map((outcome, idx) => {
              const yVal = outcomeToY(outcome);
              return (
                <g key={`y-label-${outcome}`}>
                  <text
                    x={padding.left - 10}
                    y={yScale(yVal) + 4}
                    textAnchor="end"
                    className="text-xs fill-gray-600"
                  >
                    {outcomeLabel(outcome)}
                  </text>
                </g>
              );
            })}

            {/* Axis labels */}
            <text
              x={svgWidth / 2}
              y={svgHeight - 10}
              textAnchor="middle"
              className="text-sm font-semibold fill-gray-900"
            >
              Match Score (0–100)
            </text>

            <text
              x={20}
              y={svgHeight / 2}
              textAnchor="middle"
              className="text-sm font-semibold fill-gray-900"
              transform={`rotate(-90 20 ${svgHeight / 2})`}
            >
              Outcome
            </text>

            {/* Data points */}
            {data.map((point) => {
              const x = xScale(point.matchScore);
              const y = yScale(outcomeToY(point.outcome));
              const isHovered = hoveredPoint?.jobId === point.jobId;

              return (
                <g
                  key={point.jobId}
                  onMouseEnter={() => setHoveredPoint(point)}
                  onMouseLeave={() => setHoveredPoint(null)}
                  className="cursor-pointer"
                >
                  <circle
                    cx={x}
                    cy={y}
                    r={isHovered ? 7 : 5}
                    fill={outcomeColor(point.outcome)}
                    opacity={isHovered ? 1 : 0.8}
                    className="transition"
                  />
                </g>
              );
            })}
          </svg>
        </div>

        {/* Legend */}
        <div className="flex flex-col gap-4">
          <div className="font-semibold text-gray-900">Outcomes</div>
          {outcomes.map((outcome) => (
            <div key={outcome} className="flex items-center gap-3">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: outcomeColor(outcome) }}
              />
              <span className="text-sm text-gray-700">{outcomeLabel(outcome)}</span>
            </div>
          ))}

          {hoveredPoint && (
            <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded text-sm">
              <div className="font-semibold text-blue-900 mb-2">{hoveredPoint.jobTitle}</div>
              <div className="text-blue-800 text-xs space-y-1">
                <div>
                  <span className="font-medium">Company:</span> {hoveredPoint.company}
                </div>
                <div>
                  <span className="font-medium">Match Score:</span> {hoveredPoint.matchScore}
                </div>
                <div>
                  <span className="font-medium">Outcome:</span> {outcomeLabel(hoveredPoint.outcome)}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
