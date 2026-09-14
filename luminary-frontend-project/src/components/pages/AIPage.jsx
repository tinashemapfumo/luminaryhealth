import React, { useState } from 'react';
import { Bot, Send } from 'lucide-react';
import { AI_TABS, aiAgentRoster, askLuminaryFallback, askLuminaryKnowledge, smartInsights } from '../../data/intelligence';
import { StatusPill } from '../shared/StatusPill';
import { OceanWaveDecoration } from '../ui';
import { useWorkspace } from '../../lib/workspace';

export default function AIPage() {
  // aiTab stays in the shell because the router drives it (#/ai/ask-luminary);
  // everything else here is page-local UI state and belongs in the page.
  const { access, aiTab, setAiTab } = useWorkspace();

  const [agentStates, setAgentStates] = useState(() =>
    Object.fromEntries(aiAgentRoster.map((agent) => [agent.id, true]))
  );
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState([
    { from: 'ai', text: 'Hi, I’m Luminary. I can look across patients, appointments, billing, claims, and communications. Ask me anything about the practice.', sources: null },
  ]);

  const askLuminary = () => {
    const question = chatInput.trim();
    if (!question) return;
    const query = question.toLowerCase();
    const match =
      askLuminaryKnowledge.find((entry) => entry.keywords.some((k) => query.includes(k))) || askLuminaryFallback;
    setChatMessages((prev) => [
      ...prev,
      { from: 'user', text: question, sources: null },
      { from: 'ai', text: match.answer, sources: match.sources },
    ]);
    setChatInput('');
  };

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-lg border border-brand-edge bg-white/90 p-4 shadow-[0_18px_44px_-34px_rgba(8,114,222,0.34)]">
        <OceanWaveDecoration className="absolute bottom-0 right-0 h-44 w-[420px] opacity-60" />
        <div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="max-w-xl">
          <p className="lh-page-kicker">Intelligence</p>
          <h1 className="lh-page-title">AI Insights</h1>
          <p className="lh-page-subtitle">Intelligent insights to help you run a better practice.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {AI_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setAiTab(tab)}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${aiTab === tab ? 'bg-brand text-white shadow-[0_12px_28px_-20px_rgba(8,114,222,0.55)]' : 'border border-line bg-white/80 text-body hover:border-brand-edge hover:bg-white'}`}
            >
              {tab}
            </button>
          ))}
        </div>
        </div>
      </div>

      {aiTab === 'Agents' && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              { label: 'Agents running', value: `${Object.values(agentStates).filter(Boolean).length} / ${aiAgentRoster.length}`, detail: 'All within normal operating range' },
              { label: 'Actions this week', value: '312', detail: 'Bookings, claims, recalls, collections' },
              { label: 'Escalated to humans', value: '9', detail: 'Items needing staff judgement' },
            ].map((item) => (
              <div key={item.label} className="lh-metric">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">{item.label}</p>
                <p className="mt-3 text-xl font-semibold tracking-[-0.02em] text-ink">{item.value}</p>
                <p className="mt-2 text-sm text-body">{item.detail}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {aiAgentRoster.map((agent) => (
              <div key={agent.id} className="lh-card-pad flex flex-col">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="lh-metric-icon">
                      <Bot size={16} />
                    </div>
                    <div>
                      <p className="text-md font-semibold text-ink">{agent.name}</p>
                      <p className="mt-0.5 text-xs uppercase tracking-[0.1em] text-muted">{agent.role}</p>
                    </div>
                  </div>
                  <StatusPill label={agentStates[agent.id] ? 'Active' : 'Paused'} tone={agentStates[agent.id] ? 'success' : 'neutral'} />
                </div>

                <p className="mt-3 text-base leading-6 text-body">{agent.detail}</p>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  {agent.metrics.map((metric) => (
                    <div key={metric.label} className="lh-card-soft p-2.5">
                      <p className="text-2xs uppercase tracking-[0.1em] text-muted">{metric.label}</p>
                      <p className="mt-1 text-md font-semibold tracking-[-0.01em] text-ink">{metric.value}</p>
                    </div>
                  ))}
                </div>

                <p className="mt-3 text-xs text-muted">{agent.lastAction}</p>

                {access.can.manageAgents && (
                  <button
                    type="button"
                    onClick={() => setAgentStates((prev) => ({ ...prev, [agent.id]: !prev[agent.id] }))}
                    className={`mt-4 rounded-lg px-3.5 py-2 text-xs font-semibold transition ${agentStates[agent.id] ? 'border border-danger-line bg-white text-danger hover:border-danger-line' : 'bg-brand text-white hover:bg-brand-deep'}`}
                  >
                    {agentStates[agent.id] ? 'Pause agent' : 'Resume agent'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {aiTab === 'Smart analytics' && (
        <div className="grid gap-4 xl:grid-cols-2">
          {smartInsights.map((insight) => (
            <div key={insight.title} className="lh-card-pad">
              <div className="flex items-start justify-between gap-3">
                <p className="text-md font-semibold tracking-[-0.01em] text-ink">{insight.title}</p>
                <StatusPill label={insight.severity} tone={insight.tone} />
              </div>
              <p className="mt-3 text-base leading-6 text-body">{insight.detail}</p>
              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs uppercase tracking-[0.1em] text-muted">{insight.source}</span>
                <button className="text-sm font-medium text-brand">Open workflow →</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {aiTab === 'Ask Luminary' && (
        <div className="lh-card-pad">
          <div className="flex items-center gap-2">
            <p className="text-xs uppercase tracking-[0.16em] text-muted">Ask Luminary, searches every module</p>
          </div>

          <div className="mt-4 max-h-[420px] space-y-3 overflow-y-auto pr-1">
            {chatMessages.map((message, index) => (
              <div key={index} className={`flex ${message.from === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-lg p-3.5 ${message.from === 'user' ? 'lh-chat-user' : 'lh-chat-ai'}`}>
                  <p className="text-base leading-6">{message.text}</p>
                  {message.sources && (
                    <p className="mt-2 text-2xs uppercase tracking-[0.1em] text-muted">Sources: {message.sources}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex gap-2">
            <input
              type="text"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') askLuminary(); }}
              placeholder="Ask about a patient, today’s schedule, claims, revenue…"
              className="flex-1 rounded-lg border border-edge bg-surface px-4 py-2.5 text-md text-ink placeholder-faint outline-none transition focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand/15"
            />
            <button
              type="button"
              onClick={askLuminary}
              className="lh-primary-button py-2.5"
            >
              <Send size={14} />
              Ask
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {['What’s today’s schedule?', 'Any claim rejections?', 'How are collections doing?', 'Tell me about Ruvimbo Moyo'].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setChatInput(suggestion)}
                className="rounded-lg border border-edge bg-white/90 px-3 py-1.5 text-sm text-body transition hover:border-brand-bright hover:bg-white"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
