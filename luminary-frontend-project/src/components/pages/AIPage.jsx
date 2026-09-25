import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowDownRight, ArrowUpRight, Bot, Check, Copy, Loader2, RotateCcw, Send } from 'lucide-react';
import { AI_TABS, aiAgentRoster, smartInsights } from '../../data/intelligence';
import { StatusPill } from '../shared/StatusPill';
import { OceanWaveDecoration } from '../ui';
import { useWorkspace } from '../../lib/workspace';
import { api } from '../../services/api';

function AnalystResponse({ message, copied, onCopy, onRetry, onFollowUp }) {
  const sources = Array.isArray(message.sources) ? message.sources : message.sources ? [message.sources] : [];
  const period = message.reportingPeriod;

  return (
    <div className="min-w-0">
      {period && (
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="font-semibold text-body">{period.label || 'Reporting period'}</span>
          {(period.from || period.to) && <span>{[period.from, period.to].filter(Boolean).join(' to ')}</span>}
          {period.comparisonLabel && <span className="text-faint">vs {period.comparisonLabel}</span>}
        </div>
      )}

      <p className="whitespace-pre-wrap text-base leading-6 text-ink">{message.text}</p>

      {message.metrics?.length > 0 && (
        <div className="mt-4 grid border-y border-line sm:grid-cols-2 xl:grid-cols-3">
          {message.metrics.map((metric, index) => {
            const positive = metric.sentiment === 'positive';
            const negative = metric.sentiment === 'negative';
            const TrendIcon = Number(metric.changePercent) >= 0 ? ArrowUpRight : ArrowDownRight;
            return (
              <div key={`${metric.label}-${index}`} className="min-w-0 px-3 py-3 first:pl-0 sm:[&:nth-child(2n+1)]:pl-0 xl:[&:nth-child(2n+1)]:pl-3 xl:[&:nth-child(3n+1)]:pl-0">
                <p className="truncate text-caption font-medium text-muted">{metric.label}</p>
                <p className="mt-1 break-words text-lg font-semibold text-ink">{metric.value}</p>
                <div className="mt-1 flex min-h-[18px] flex-wrap items-center gap-1.5 text-xs">
                  {metric.changePercent != null && (
                    <span className={`inline-flex items-center font-semibold ${positive ? 'text-success' : negative ? 'text-danger' : 'text-body'}`}>
                      <TrendIcon size={13} />
                      {metric.changePercent > 0 ? '+' : ''}{metric.changePercent}%
                    </span>
                  )}
                  {metric.previous != null && <span className="text-muted">from {metric.previous}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {message.sections?.length > 0 && (
        <div className="mt-4 space-y-4">
          {message.sections.map((section, index) => (
            <section key={`${section.title}-${index}`}>
              <h3 className="text-sm font-semibold text-ink">{section.title}</h3>
              {section.body && <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-body">{section.body}</p>}
              {section.items?.length > 0 && (
                <ul className="mt-2 space-y-1.5 text-sm leading-5 text-body">
                  {section.items.map((item, itemIndex) => (
                    <li key={itemIndex} className="flex gap-2"><span className="text-brand">-</span><span>{item}</span></li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}

      {sources.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="text-caption font-medium text-muted">Sources</span>
          {sources.map((source, index) => <span key={`${source}-${index}`} className="border-l border-line pl-1.5 text-xs text-body">{source}</span>)}
        </div>
      )}

      <div className="mt-3 flex items-center gap-1 border-t border-line pt-2">
        <button type="button" onClick={onCopy} title="Copy response" aria-label="Copy response" className="rounded p-1.5 text-muted transition hover:bg-white hover:text-ink">
          {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        </button>
        <button type="button" onClick={onRetry} title="Retry question" aria-label="Retry question" className="rounded p-1.5 text-muted transition hover:bg-white hover:text-ink">
          <RotateCcw size={14} />
        </button>
      </div>

      {message.followUps?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.followUps.map((question) => (
            <button key={question} type="button" onClick={() => onFollowUp(question)} className="rounded-lg border border-brand-edge bg-white px-3 py-1.5 text-left text-xs font-medium text-brand transition hover:border-brand hover:bg-brand-wash">
              {question}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AIPage() {
  // aiTab stays in the shell because the router drives it (#/ai/ask-luminary);
  // everything else here is page-local UI state and belongs in the page.
  const { access, aiTab, setAiTab } = useWorkspace();

  const [agentStates, setAgentStates] = useState(() =>
    Object.fromEntries(aiAgentRoster.map((agent) => [agent.id, true]))
  );
  const [chatInput, setChatInput] = useState('');
  const [chatPending, setChatPending] = useState(false);
  const [chatError, setChatError] = useState('');
  const [failedQuestion, setFailedQuestion] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [copiedMessage, setCopiedMessage] = useState(null);
  const chatEndRef = useRef(null);
  const [chatMessages, setChatMessages] = useState([
    { from: 'ai', text: 'Hi, I’m Luminary. I can look across patients, appointments, billing, claims, and communications. Ask me anything about the practice.', sources: null },
  ]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [chatMessages, chatPending]);

  const askLuminary = async (prompt) => {
    const question = (typeof prompt === 'string' ? prompt : chatInput).trim();
    if (!question || chatPending) return;
    setChatMessages((prev) => [...prev, { from: 'user', text: question, sources: null }]);
    setChatInput('');
    setChatError('');
    setFailedQuestion(null);
    setChatPending(true);
    try {
      const result = await api.ai.askLuminary({
        question,
        ...(conversationId ? { conversationId } : {}),
      });
      setConversationId(result.conversationId || conversationId);
      setChatMessages((prev) => [...prev, {
        from: 'ai',
        text: result.answer,
        sources: result.sources || [],
        reportingPeriod: result.reportingPeriod || null,
        metrics: result.metrics || [],
        sections: result.sections || [],
        followUps: result.followUps || [],
        question,
      }]);
    } catch (error) {
      setChatError(error.message || 'Luminary could not answer right now.');
      setFailedQuestion(question);
    } finally {
      setChatPending(false);
    }
  };

  const copyResponse = async (message, index) => {
    const detail = [
      message.text,
      ...(message.metrics || []).map((metric) => `${metric.label}: ${metric.value}`),
      ...(message.sections || []).flatMap((section) => [section.title, section.body, ...(section.items || [])].filter(Boolean)),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(detail);
      setCopiedMessage(index);
      window.setTimeout(() => setCopiedMessage(null), 1800);
    } catch {
      setChatError('The response could not be copied.');
    }
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
                <p className="text-caption font-medium text-muted">{item.label}</p>
                <p className="mt-3 text-xl font-semibold tracking-title text-ink">{item.value}</p>
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
                      <p className="mt-0.5 text-caption font-medium text-muted">{agent.role}</p>
                    </div>
                  </div>
                  <StatusPill label={agentStates[agent.id] ? 'Active' : 'Paused'} tone={agentStates[agent.id] ? 'success' : 'neutral'} />
                </div>

                <p className="mt-3 text-base leading-6 text-body">{agent.detail}</p>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  {agent.metrics.map((metric) => (
                    <div key={metric.label} className="lh-card-soft p-2.5">
                      <p className="text-caption font-medium text-muted">{metric.label}</p>
                      <p className="mt-1 text-md font-semibold tracking-heading text-ink">{metric.value}</p>
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
                <p className="text-md font-semibold tracking-heading text-ink">{insight.title}</p>
                <StatusPill label={insight.severity} tone={insight.tone} />
              </div>
              <p className="mt-3 text-base leading-6 text-body">{insight.detail}</p>
              <div className="mt-4 flex items-center justify-between">
                <span className="text-caption font-medium text-muted">{insight.source}</span>
                <button className="text-sm font-medium text-brand">Open workflow →</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {aiTab === 'Ask Luminary' && (
        <div className="lh-card-pad">
          <div className="flex items-center gap-2">
            <p className="text-caption font-medium text-muted">Ask Luminary, searches every module</p>
          </div>

          <div className="mt-4 max-h-[620px] space-y-3 overflow-y-auto pr-1">
            {chatMessages.map((message, index) => (
              <div key={index} className={`flex ${message.from === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`${message.from === 'user' ? 'max-w-[80%] lh-chat-user' : 'max-w-[94%] lg:max-w-[86%] lh-chat-ai'} rounded-lg p-3.5`}>
                  {message.from === 'ai' && message.question ? (
                    <AnalystResponse
                      message={message}
                      copied={copiedMessage === index}
                      onCopy={() => void copyResponse(message, index)}
                      onRetry={() => void askLuminary(message.question)}
                      onFollowUp={(question) => void askLuminary(question)}
                    />
                  ) : (
                    <p className="whitespace-pre-wrap text-base leading-6">{message.text}</p>
                  )}
                </div>
              </div>
            ))}
            {chatPending && (
              <div className="flex justify-start" aria-live="polite">
                <div className="lh-chat-ai flex items-center gap-2 rounded-lg p-3.5 text-body">
                  <Loader2 size={15} className="animate-spin" />
                  <span className="text-sm">Analysing practice data...</span>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {chatError && (
            <div className="mt-3 flex items-center gap-2 text-sm text-danger" role="alert">
              <AlertCircle size={15} />
              <span className="flex-1">{chatError}</span>
              {failedQuestion && (
                <button type="button" onClick={() => void askLuminary(failedQuestion)} className="inline-flex items-center gap-1 font-semibold text-danger hover:underline">
                  <RotateCcw size={13} /> Retry
                </button>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void askLuminary();
                }
              }}
              placeholder="Ask about appointments, claims, revenue, or operations..."
              disabled={chatPending}
              className="flex-1 rounded-lg border border-edge bg-surface px-4 py-2.5 text-md text-ink placeholder-faint outline-none transition focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand/15"
            />
            <button
              type="button"
              onClick={() => void askLuminary()}
              disabled={chatPending || !chatInput.trim()}
              className="lh-primary-button py-2.5"
            >
              {chatPending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Ask
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {["How are we doing this month?", "Any claim rejections?", "How are collections doing?", "What is today's appointment completion rate?"].map((suggestion) => (
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
