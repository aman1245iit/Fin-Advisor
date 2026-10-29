// AI research assistant: tool loop, citations and the number check, against a stand-in client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantAnswer, _setClient, _setFetch, freeConfig, retryDelayMs, _resetLimits, _clearCache } from '../src/engine/assistant.js';
import { officialPublisher, _setOfficialFetch } from '../src/engine/official.js';
import { runPipeline } from '../src/engine/pipeline.js';
import { patna } from './fixtures.js';

process.env.ANTHROPIC_API_KEY ||= 'test-key';

// Replays scripted responses; records each request so tests can inspect what was sent.
function scripted(responses) {
  const calls = [];
  return { calls, beta: { messages: { create: async (req) => { calls.push(structuredClone(req)); return responses[calls.length - 1](req); } } } };
}
const toolUse = (name, input) => ({ stop_reason: 'tool_use', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `tu_${name}`, name, input }] });
const final = (text) => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text }] });

test('assistant runs tools, cites sources and passes the number check', async () => {
  const c = scripted([
    () => toolUse('get_fund_facts', { fund: 'Parag Parikh Flexi Cap Fund' }),
    () => final('The direct plan of Parag Parikh Flexi Cap Fund has a total expense ratio of 0.53% [S1].'),
  ]);
  _setClient(c);
  const a = await assistantAnswer('What is the TER of Parag Parikh Flexi Cap Fund?');
  assert.equal(a.mode, 'ai-agent');
  assert.equal(a.sources[0].id, 'S1');
  assert.match(a.sources[0].url, /#page=2/);
  assert.equal(a.steps[0].tool, 'get_fund_facts');
  const result = c.calls[1].messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result');
  assert.match(result.content, /\[S1\].*0\.53%/);
});

test('assistant reads the client case and rejects invented figures', async () => {
  const draft = { ...runPipeline(patna), version: 1 };
  const c = scripted([
    () => toolUse('get_client_case', {}),
    () => final('The retirement goal needs 99,999 a month [S1].'),
    () => final('Still 99,999 [S1].'),
    () => final('Again 99,999 [S1].'),
  ]);
  _setClient(c);
  const a = await assistantAnswer('Is retirement on track?', { draft });
  assert.match(c.calls[1].messages.at(-1).content[0].content, /Retirement/);
  assert.match(c.calls[2].messages.at(-1).content, /99999/, 'asked to correct');
  assert.equal(c.calls.length, 4, 'two corrections, then withheld');
  assert.equal(a.type, 'not_found');
  assert.match(a.answer, /withheld/);
  assert.deepEqual(a.sources, []);
});

test('official sources: only SEBI-regulated domains are read and cited', async () => {
  assert.equal(officialPublisher('https://www.sebi.gov.in/legal/circulars/x.html'), 'SEBI');
  assert.equal(officialPublisher('https://mf.nipponindiaim.com/a.pdf'), 'Nippon India Mutual Fund');
  assert.equal(officialPublisher('https://sebi.gov.in.evil.com/x'), null);
  assert.equal(officialPublisher('https://moneycontrol.com/x'), null);
  const fetched = [];
  _setOfficialFetch(async (url) => {
    fetched.push(url);
    return { ok: true, status: 200, url, headers: new Headers({ 'content-type': 'text/html' }), arrayBuffer: async () => new TextEncoder().encode('<html><title>Circular</title><body><p>Riskometer to be reviewed every month, within 10 days of the month end.</p></body></html>').buffer };
  });
  try {
    const c = scripted([
      () => toolUse('read_official_source', { url: 'https://www.moneycontrol.com/news' }),
      () => toolUse('read_official_source', { url: 'https://www.sebi.gov.in/legal/circulars/riskometer.html' }),
      () => final('The riskometer is reviewed every month, within 10 days of the month end [S1].'),
    ]);
    _setClient(c);
    const a = await assistantAnswer('How often is the riskometer reviewed?');
    assert.deepEqual(fetched, ['https://www.sebi.gov.in/legal/circulars/riskometer.html'], 'non-official URL never fetched');
    assert.equal(a.steps[0].ok, false);
    assert.match(a.steps[0].summary, /not an official/);
    assert.equal(a.type, 'answer');
    assert.equal(a.sources[0].url, 'https://www.sebi.gov.in/legal/circulars/riskometer.html');
    assert.match(a.sources[0].label, /^SEBI/);
  } finally { _setOfficialFetch((...x) => fetch(...x)); }
});

// Free provider: OpenAI-compatible chat completions over a stand-in fetch.
function scriptedFetch(responses) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const body = responses[calls.length - 1](calls.at(-1).body);
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, f };
}
const oaTool = (name, args) => ({ model: 'openai/gpt-oss-120b', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const oaFinal = (text) => ({ model: 'openai/gpt-oss-120b', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] });

test('free provider is detected from the key and plans funds for a goal', async () => {
  process.env.FREE_AI_API_KEY = 'gsk_test';
  try {
    assert.equal(freeConfig().baseURL, 'https://api.groq.com/openai/v1');
    let plan = '';
    const { calls, f } = scriptedFetch([
      () => oaTool('plan_goal', { goal_name: 'Education', goal_type: 'education', current_cost: 2500000, years: 12, existing_savings: 200000 }),
      (body) => { plan = body.messages.at(-1).content; return oaFinal(`Recommended SIP ${plan.match(/recommended (₹[\d,]+)/)[1]} a month【S1】.`); },
    ]);
    _setFetch(f);
    const a = await assistantAnswer('Plan funds for ₹25 lakh of education in 12 years', { provider: 'free' });
    assert.equal(a.mode, 'ai-agent');
    assert.equal(a.provider, 'free');
    assert.equal(calls[0].headers.Authorization, 'Bearer gsk_test');
    assert.ok(calls[0].body.tools.some((t) => t.function.name === 'plan_goal'));
    assert.equal(calls[1].body.messages.at(-1).role, 'tool');
    assert.match(plan, /Future cost ₹/);
    assert.match(plan, /Risk level Moderate \(assumed/);
    assert.match(plan, /a month \(TER/);
    assert.equal(a.sources[0].id, 'S1');
    assert.match(a.answer, /a month\[S1\]/, '【S1】 normalised');
    assert.equal(a.note, null);
  } finally { delete process.env.FREE_AI_API_KEY; }
});

test('free provider waits out a rate limit and retries', async () => {
  process.env.FREE_AI_API_KEY = 'gsk_test';
  try {
    let n = 0;
    _setFetch(async () => {
      n++;
      if (n === 1) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), json: async () => ({ error: { message: 'rate limit' } }) };
      return { ok: true, status: 200, headers: new Headers(), json: async () => oaFinal('Hello.') };
    });
    const a = await assistantAnswer('Say hello', { provider: 'free' });
    assert.equal(n, 2);
    assert.equal(a.answer, 'Hello.');
    assert.equal(retryDelayMs(new Headers({ 'x-ratelimit-reset-tokens': '1m2.5s' })), 62500);
  } finally { delete process.env.FREE_AI_API_KEY; }
});

test('a rate-limited model hands over to the fallback at once, and repeats come from the cache', async () => {
  process.env.FREE_AI_API_KEY = 'gsk_test';
  _resetLimits(); _clearCache();
  try {
    const models = [];
    _setFetch(async (url, init) => {
      const { model } = JSON.parse(init.body);
      models.push(model);
      if (model === 'openai/gpt-oss-120b') return { ok: false, status: 429, headers: new Headers({ 'retry-after': '30' }), json: async () => ({}) };
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ...oaFinal('Fine.'), model }) };
    });
    const t = Date.now();
    const a = await assistantAnswer('Fallback please', { provider: 'free' });
    assert.ok(Date.now() - t < 2000, 'no waiting');
    assert.deepEqual(models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
    assert.equal(a.model, 'openai/gpt-oss-20b');
    await assistantAnswer('Another question', { provider: 'free' });
    assert.equal(models.at(-1), 'openai/gpt-oss-20b', 'limited model skipped on the next question');
    assert.equal(models.length, 3);
    const again = await assistantAnswer('  fallback PLEASE ', { provider: 'free' });
    assert.equal(again.answer, 'Fine.');
    assert.equal(models.length, 3, 'served from cache');
  } finally { delete process.env.FREE_AI_API_KEY; _resetLimits(); _clearCache(); }
});

test('plan_goal uses the open case\'s risk level', async () => {
  process.env.FREE_AI_API_KEY = 'gsk_test';
  try {
    const draft = { ...runPipeline(patna), version: 1 };
    let plan = '';
    const { f } = scriptedFetch([
      () => oaTool('plan_goal', { goal_type: 'wealth', current_cost: 1000000, years: 15 }),
      (body) => { plan = body.messages.at(-1).content; return oaFinal('Done [S1].'); },
    ]);
    _setFetch(f);
    await assistantAnswer('Plan a wealth goal', { draft, provider: 'free' });
    assert.match(plan, new RegExp(`Risk level ${draft.risk.final.level} \\(from the open client case\\)`));
  } finally { delete process.env.FREE_AI_API_KEY; }
});

test('plan_goal works from a monthly amount when there is no target', async () => {
  process.env.FREE_AI_API_KEY = 'gsk_test';
  try {
    let plan = '';
    const { f } = scriptedFetch([
      () => oaTool('plan_goal', { goal_type: 'retirement', monthly_sip: 10000, years: 25 }),
      (body) => { plan = body.messages.at(-1).content; return oaFinal('Done [S1].'); },
    ]);
    _setFetch(f);
    await assistantAnswer('Where should I invest 10000 a month for retirement in 25 years?', { provider: 'free' });
    assert.match(plan, /₹10,000 a month for 25 years/);
    assert.match(plan, /Total invested ₹30,00,000/);
    assert.match(plan, /median ₹[\d,]+/);
    const split = [...plan.matchAll(/, ₹([\d,]+) a month \(TER/g)].reduce((s, m) => s + +m[1].replace(/,/g, ''), 0);
    assert.ok(Math.abs(split - 10000) <= 5, `fund split adds up to the monthly amount (${split})`);
  } finally { delete process.env.FREE_AI_API_KEY; }
});

test('guarantee requests never reach the model', async () => {
  const c = scripted([]);
  _setClient(c);
  const a = await assistantAnswer('Can you guarantee 20% returns every year?');
  assert.equal(a.type, 'guardrail');
  assert.equal(c.calls.length, 0);
});

test('the free key is found under the names Vercel integrations use', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/API_KEY$/.test(k)) delete process.env[k];
    assert.equal(freeConfig(), null);
    process.env.GROQ_API_KEY = 'gsk_from_integration';
    assert.equal(freeConfig().label, 'Groq');
    assert.equal(freeConfig().keyName, 'GROQ_API_KEY');
    delete process.env.GROQ_API_KEY;
    process.env.FIN_GEMINI_API_KEY = 'AIza_prefixed';
    assert.equal(freeConfig().label, 'Google Gemini');
    process.env.FREE_AI_API_KEY = 'gsk_explicit';
    assert.equal(freeConfig().keyName, 'FREE_AI_API_KEY', 'FREE_AI_API_KEY wins');
  } finally { process.env = saved; }
});
