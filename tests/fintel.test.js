// Fintel help assistant: page context, guardrail and the plain (tool-free) model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setClient } from '../src/engine/assistant.js';
import { fintelAnswer, pageContext } from '../src/engine/fintel.js';

process.env.ANTHROPIC_API_KEY ||= 'test-key';

test('page context lists fields and the focused field, but never typed client data', () => {
  const ctx = pageContext({
    title: 'Fin Advisor', screen: '1Client onboarding',
    fields: [{ label: 'Monthly EMIs (₹)', value: '12000' }, { label: 'Client name', filled: true }, { label: 'Income stability', required: true, options: ['Stable', 'Variable'], value: 'Stable' }],
    focused: 'Monthly EMIs (₹)',
  });
  assert.match(ctx, /Monthly EMIs \(₹\); filled in/);
  assert.match(ctx, /Client name; filled in/);
  assert.doesNotMatch(ctx, /12000/, 'typed values are not sent to the AI provider');
  assert.match(ctx, /Income stability; required; selected: Stable; options: Stable \/ Variable/);
  assert.match(ctx, /Field the user last clicked: Monthly EMIs/);
});

test('fintel sends the page context without tools and returns the text', async () => {
  const calls = [];
  _setClient({ beta: { messages: { create: async (req) => { calls.push(structuredClone(req)); return { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Enter the total monthly loan instalments.' }] }; } } } });
  const r = await fintelAnswer('what goes here?', {
    page: { title: 'Fin Advisor', focused: 'Monthly EMIs (₹)' },
    history: [{ role: 'assistant', content: 'stale greeting' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }],
  });
  assert.equal(r.answer, 'Enter the total monthly loan instalments.');
  const req = calls[0];
  assert.equal(req.tools, undefined);
  assert.match(req.system, /You are Fintel/);
  assert.equal(req.messages[0].role, 'user');
  assert.match(req.messages.at(-1).content, /Field the user last clicked: Monthly EMIs/);
});

test('fintel answers guarantee requests with the fixed compliance text', async () => {
  _setClient({ beta: { messages: { create: async () => { throw new Error('model should not be called'); } } } });
  const r = await fintelAnswer('Which fund gives guaranteed returns?');
  assert.equal(r.guardrail, true);
});
