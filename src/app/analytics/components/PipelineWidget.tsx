'use client';

import React, { useState } from 'react';

interface PipelineCard {
  jobId: string;
  stage: string;
  jobTitle?: string;
  company?: string;
  jobUrl?: string;
  submittedAt?: string;
}

interface PipelineWidgetProps {
  pipeline: PipelineCard[];
  onStageChange?: (jobId: string, fromStage: string, toStage: string) => void;
}

const STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Rejected'];

function stageToKey(stage: string): string {
  return stage.toLowerCase().replace(/\s+/g, '_');
}

function keyToStage(key: string): string {
  return STAGES.find((s) => stageToKey(s) === key) || key;
}

function formatDate(submittedAt?: string): string {
  if (!submittedAt) return '';
  const date = new Date(submittedAt);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function PipelineWidget({ pipeline, onStageChange }: PipelineWidgetProps) {
  // Group cards by stage
  const grouped: Record<string, PipelineCard[]> = {};
  STAGES.forEach((stage) => {
    grouped[stageToKey(stage)] = pipeline.filter((card) => stageToKey(card.stage) === stageToKey(stage));
  });

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-6">Application Pipeline</h3>

      <div className="grid grid-cols-5 gap-4">
        {STAGES.map((stage) => {
          const stageKey = stageToKey(stage);
          const cards = grouped[stageKey] || [];

          return (
            <div key={stageKey} className="flex flex-col">
              {/* Column header */}
              <h4 className="text-sm font-semibold text-gray-700 mb-3">{stage}</h4>

              {/* Cards or empty state */}
              <div className="space-y-2 flex-1">
                {cards.length === 0 ? (
                  <div className="border-2 border-dashed border-gray-200 rounded-lg p-3 text-center text-xs text-gray-400 min-h-32 flex items-center justify-center">
                    Empty
                  </div>
                ) : (
                  cards.map((card) => (
                    <div key={card.jobId} className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs space-y-2">
                      {/* Company & Title */}
                      <div>
                        <p className="font-bold text-gray-900 truncate">{card.company || '(No company)'}</p>
                        <p className="text-gray-600 text-xs truncate">{card.jobTitle || '(No title)'}</p>
                      </div>

                      {/* Date */}
                      {card.submittedAt && (
                        <p className="text-gray-500 text-xs">{formatDate(card.submittedAt)}</p>
                      )}

                      {/* Stage dropdown */}
                      <select
                        value={stageToKey(card.stage)}
                        onChange={(e) => {
                          if (onStageChange) {
                            onStageChange(card.jobId, card.stage, keyToStage(e.target.value));
                          }
                        }}
                        className="w-full text-xs border border-gray-300 rounded px-2 py-1 bg-white text-gray-700 cursor-pointer"
                      >
                        {STAGES.map((s) => (
                          <option key={stageToKey(s)} value={stageToKey(s)}>
                            {s}
                          </option>
                        ))}
                      </select>

                      {/* Optional job link */}
                      {card.jobUrl && (
                        <a
                          href={card.jobUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline text-xs inline-block"
                        >
                          View Job
                        </a>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
