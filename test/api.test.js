'use strict';
// API tests with the built-in mock agent (no network, no key). Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.MOCK_DELAY_MS = '50';
const { createApp } = require('../src/server');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
let server;
let base;
let runner;

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, { ...opts, headers: opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {} });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const send = (id, text) => api(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
async function waitIdle(id) {
  for (let i = 0; i < 200; i++) {
    const s = await api(`/api/sessions/${id}`);
    if (!s.body.running) return (await api(`/api/sessions/${id}/events`)).body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
}
const lastFinish = (events) => [...events].reverse().find((e) => e.type === 'run_finished');

before(async () => {
  const created = createApp({ dataDir, agentCli: 'mock' });
  runner = created.runner;
  await new Promise((r) => { server = created.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a turn streams normalized events and produces files; follow-up resumes the agent session', async () => {
  const { body: s } = await api('/api/sessions', { method: 'POST', body: '{}' });
  assert.strictEqual((await send(s.id, '写一个小工具')).status, 202);
  let events = await waitIdle(s.id);
  const types = events.map((e) => e.type);
  for (const t of ['user_message', 'run_started', 'agent_init', 'assistant_text', 'tool_call', 'tool_result', 'files_changed', 'run_finished']) assert.ok(types.includes(t), t);
  assert.strictEqual(lastFinish(events).status, 'succeeded');
  const meta = (await api(`/api/sessions/${s.id}`)).body;
  assert.ok(meta.agentSessionId);
  assert.strictEqual(meta.title, '写一个小工具');

  await send(s.id, '再改一下');
  events = await waitIdle(s.id);
  const init = events.filter((e) => e.type === 'agent_init').pop();
  assert.strictEqual(init.resumed, true);
  assert.strictEqual(init.sessionId, meta.agentSessionId);
  const files = (await api(`/api/sessions/${s.id}/files`)).body.map((f) => f.path);
  assert.deepStrictEqual(files.filter((f) => f.startsWith('outputs/')), ['outputs/mock-turn-1.md', 'outputs/mock-turn-2.md']);
});

test('agent/API errors are surfaced as a failed run', async () => {
  const { body: s } = await api('/api/sessions', { method: 'POST', body: '{}' });
  await send(s.id, 'please [fail]');
  const fin = lastFinish(await waitIdle(s.id));
  assert.strictEqual(fin.status, 'failed');
  assert.match(fin.error, /401/);
});

test('one run per session (409) and a running task can be cancelled', async () => {
  const { body: s } = await api('/api/sessions', { method: 'POST', body: '{}' });
  await send(s.id, 'long job [slow]');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual((await send(s.id, 'another')).status, 409);
  assert.strictEqual((await api(`/api/sessions/${s.id}/cancel`, { method: 'POST' })).status, 200);
  assert.strictEqual(lastFinish(await waitIdle(s.id)).status, 'cancelled');
});

test('lost CLI history falls back to a fresh session with a recap', async () => {
  const { body: s } = await api('/api/sessions', { method: 'POST', body: '{}' });
  await send(s.id, 'first');
  await waitIdle(s.id);
  fs.rmSync(path.join(dataDir, 'agent-home', '.mock-agent'), { recursive: true, force: true });
  await send(s.id, 'second');
  const events = await waitIdle(s.id);
  assert.ok(events.some((e) => e.type === 'notice'));
  assert.strictEqual(lastFinish(events).status, 'succeeded');
});

test('uploads land in uploads/, path traversal is rejected, export works', async () => {
  const { body: s } = await api('/api/sessions', { method: 'POST', body: '{}' });
  const fd = new FormData();
  fd.append('files', new Blob(['a,b\n1,2\n']), '数据.csv');
  const up = await api(`/api/sessions/${s.id}/upload`, { method: 'POST', body: fd });
  assert.strictEqual(up.status, 201);
  assert.strictEqual(up.body[0].path, 'uploads/数据.csv');
  const bad = await api(`/api/sessions/${s.id}/file?path=${encodeURIComponent('../../session.json')}`);
  assert.strictEqual(bad.status, 400);
  const ok = await api(`/api/sessions/${s.id}/file?path=${encodeURIComponent('uploads/数据.csv')}`);
  assert.strictEqual(ok.body, 'a,b\n1,2\n');
  const md = await api(`/api/sessions/${s.id}/export`);
  assert.match(md.body, /上传文件/);
});

test('sessions marked running at start-up are recovered as interrupted', async () => {
  const { Store } = require('../src/store');
  const { Runner } = require('../src/runner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rec-'));
  const store = new Store(dir);
  const s = store.create('x');
  store.update(s.id, { status: 'running' });
  const r = new Runner(new Store(dir), { agentHome: path.join(dir, 'home'), agentCli: 'mock' });
  r.recoverInterrupted();
  const again = new Store(dir);
  assert.strictEqual(again.get(s.id).status, 'interrupted');
  assert.strictEqual(lastFinish(again.readEvents(s.id)).status, 'interrupted');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(runner);
});
