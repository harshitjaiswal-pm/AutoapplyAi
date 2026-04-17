import React from 'react';

interface ChannelData {
  channel: string;
  volume: number;
  submitRate: number;
  medianDurationMs: number;
  responseRate: number;
}

interface ChannelBreakdownWidgetProps {
  channels: ChannelData[];
}

const formatDuration = (ms: number): string => {
  if (!ms || ms === 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
};

const getChannelLabel = (channel: string): string => {
  const labels: Record<string, string> = {
    linkedin_easy_apply: 'LinkedIn Easy Apply',
    external_ats: 'External ATS',
    indeed: 'Indeed',
    greenhouse: 'Greenhouse',
    workday: 'Workday',
  };
  return labels[channel] || channel;
};

const isInsufficientData = (volume: number): boolean => volume < 3;

export default function ChannelBreakdownWidget({ channels }: ChannelBreakdownWidgetProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-6">Channel Performance</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {channels.map((channel) => {
          const insufficient = isInsufficientData(channel.volume);
          const bgColor = insufficient ? 'bg-gray-50' : channel.channel === 'linkedin_easy_apply' ? 'bg-blue-50' : 'bg-slate-50';

          return (
            <div
              key={channel.channel}
              className={`rounded-lg border border-gray-200 p-5 ${bgColor}`}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900">{getChannelLabel(channel.channel)}</h3>
                {insufficient && (
                  <span className="inline-block px-2 py-1 text-xs font-medium text-orange-700 bg-orange-100 rounded">
                    Insufficient data
                  </span>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-gray-600">Volume</span>
                  <span className="text-2xl font-bold text-gray-900">{channel.volume}</span>
                </div>

                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-gray-600">Submit Rate</span>
                  <span className="text-lg font-semibold text-gray-900">
                    {channel.submitRate.toFixed(1)}%
                  </span>
                </div>

                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-gray-600">Median Time</span>
                  <span className="text-lg font-semibold text-gray-900">
                    {formatDuration(channel.medianDurationMs)}
                  </span>
                </div>

                <div className="flex justify-between items-baseline pt-2 border-t border-gray-300">
                  <span className="text-sm text-gray-600">Response Rate</span>
                  <span className="text-lg font-semibold text-gray-900">
                    {channel.responseRate.toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {channels.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500">No channel data available yet.</p>
        </div>
      )}
    </div>
  );
}
