import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { AppError } from '../../platform/errors.js';
import { askLuminaryService } from './ask-luminary.service.js';

void test('Ask Luminary fails closed when a practice has no workflow configuration', async () => {
  await assert.rejects(
    askLuminaryService.ask({ url: null, secret: null }, { question: 'How are we doing?', requestId: 'req-1' }),
    (error: unknown) => error instanceof AppError && error.code === 'agent_not_configured',
  );
});

void test('Ask Luminary signs the exact n8n payload and normalises its response', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => {
      const body = String(init?.body);
      const headers = init?.headers as Record<string, string>;
      const expected = createHmac('sha256', 'test-secret-1234')
        .update(`${headers['x-luminary-timestamp']}.${body}`)
        .digest('hex');
      assert.equal(headers['x-luminary-signature'], expected);
      assert.deepEqual(JSON.parse(body), {
        question: 'How are collections?', conversationId: null, requestId: 'req-2',
      });
      return new Response(JSON.stringify({
        answer: 'Collections increased.', sources: ['Revenue'], conversationId: 'conversation-1',
        reportingPeriod: { label: 'This month', from: '2026-09-01', to: '2026-09-21' },
        metrics: [{ label: 'Collected', value: 'USD 22,180', previous: 'USD 19,410', changePercent: 14.27, sentiment: 'positive' }],
        sections: [{ title: 'What changed', items: ['Card collections increased.'] }],
        followUps: ['Show the payment method breakdown'],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await askLuminaryService.ask(
      { url: 'https://n8n.example.test/webhook/insight', secret: 'test-secret-1234' },
      { question: 'How are collections?', requestId: 'req-2' },
    );
    assert.deepEqual(result, {
      answer: 'Collections increased.', sources: ['Revenue'], conversationId: 'conversation-1',
      reportingPeriod: { label: 'This month', from: '2026-09-01', to: '2026-09-21' },
      metrics: [{ label: 'Collected', value: 'USD 22,180', previous: 'USD 19,410', changePercent: 14.27, sentiment: 'positive' }],
      sections: [{ title: 'What changed', items: ['Card collections increased.'] }],
      followUps: ['Show the payment method breakdown'],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
