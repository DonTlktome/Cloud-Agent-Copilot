#!/usr/bin/env node
'use strict';
// End-to-end check through the public HTTP API, used for CI and as demo evidence.
//   node scripts/smoke.js --base http://localhost:8080 [--out evidence/run1] [--timeout 600]
//                         [--cancel-check] [--verify-persisted]
// Runs a code task and a daily-work task in two sessions, each with a follow-up message, then
// exports both transcripts (Markdown) and a summary into --out.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const BASE = String(opt('base', 'http://localhost:8080')).replace(/\/$/, '');
const OUT = opt('out', null);
const TIMEOUT = Number(opt('timeout', 600)) * 1000;
const STATE = path.join(__dirname, '..', '.smoke-state.json');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {} });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p} -> ${res.status} ${text.slice(0, 300)}`);
  return data;
}

function check(cond, msg) {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
  log(`PASS  ${msg}`);
}

async function waitRun(id, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT) {
    const s = await api(`/api/sessions/${id}`);
    if (!s.running) {
      const events = await api(`/api/sessions/${id}/events`);
      const fin = [...events].reverse().find((e) => e.type === 'run_finished');
      log(`${label}: ${fin?.status} in ${Math.round((Date.now() - t0) / 1000)}s ${fin?.error ? `(${fin.error})` : ''}`);
      return { fin, events };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label}: timed out`);
}

async function turn(id, text, label) {
  await api(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
  return waitRun(id, label);
}

async function main() {
  const health = await api('/api/health');
  log('health', JSON.stringify(health));
  check(health.ok, 'server is healthy');

  if (opt('verify-persisted')) {
    const prev = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const list = await api('/api/sessions');
    for (const id of prev.sessions) check(list.some((s) => s.id === id), `session ${id} still listed after restart`);
    const ev = await api(`/api/sessions/${prev.sessions[0]}/events`);
    check(ev.length >= prev.minEvents, `events of ${prev.sessions[0]} persisted (${ev.length})`);
    const files = await api(`/api/sessions/${prev.sessions[0]}/files`);
    check(files.some((f) => f.path.startsWith('outputs/')), 'workspace outputs persisted');
    return;
  }

  // ---- session A: code task + follow-up ----
  const a = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: '演示：开发命令行小工具' }) });
  let r = await turn(
    a.id,
    '请用 Python 开发一个命令行小工具 outputs/textstats/textstats.py：读取一个文本文件，输出字符数、词数、行数。附带 unittest 单元测试，并实际运行测试，告诉我结果和用法。',
    'A1 code task',
  );
  check(r.fin?.status === 'succeeded', 'code task succeeded');
  let files = await api(`/api/sessions/${a.id}/files`);
  check(files.some((f) => f.path.startsWith('outputs/')), `code task produced outputs (${files.filter((f) => f.path.startsWith('outputs/')).map((f) => f.path).join(', ')})`);
  r = await turn(a.id, '修改意见：增加 --top N 参数，输出出现次数最多的 N 个词；更新测试并重新运行。', 'A2 follow-up');
  check(r.fin?.status === 'succeeded', 'code follow-up succeeded');
  check(r.events.some((e) => e.type === 'agent_init' && e.resumed), 'follow-up resumed the same agent session');

  // ---- session B: daily work with uploaded material + follow-up ----
  const b = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: '演示：销售数据与会议纪要整理' }) });
  const fd = new FormData();
  for (const f of ['sales.csv', 'meeting-notes.md']) {
    fd.append('files', new Blob([fs.readFileSync(path.join(__dirname, '..', 'samples', f))]), f);
  }
  const up = await api(`/api/sessions/${b.id}/upload`, { method: 'POST', body: fd });
  check(up.length === 2, 'uploaded 2 work files');
  r = await turn(
    b.id,
    '请分析 uploads/sales.csv（一周销售明细）和 uploads/meeting-notes.md（周例会纪要），整理成一份周报 outputs/weekly-report.md：包含核心数据（销售额、销量、退货率）、按产品的表现、问题与风险、下周行动项（负责人+截止时间）。',
    'B1 daily task',
  );
  check(r.fin?.status === 'succeeded', 'daily task succeeded');
  files = await api(`/api/sessions/${b.id}/files`);
  check(files.some((f) => f.path.startsWith('outputs/')), 'daily task produced a report in outputs/');
  r = await turn(b.id, '请在周报里补充一个按地区汇总的销售额表格，并把结论精简为 5 条要点。', 'B2 follow-up');
  check(r.fin?.status === 'succeeded', 'daily follow-up succeeded');

  // ---- multi-session ----
  const list = await api('/api/sessions');
  check(list.some((s) => s.id === a.id) && list.some((s) => s.id === b.id), 'both sessions listed independently');

  if (opt('cancel-check')) {
    const c = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: '演示：停止任务' }) });
    await api(`/api/sessions/${c.id}/messages`, { method: 'POST', body: JSON.stringify({ text: '这是一个很慢的任务 [slow]' }) });
    await new Promise((res) => setTimeout(res, 1500));
    let conflict = false;
    try {
      await api(`/api/sessions/${c.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'second' }) });
    } catch (err) {
      conflict = /409/.test(err.message);
    }
    check(conflict, 'second message while running is rejected with 409');
    await api(`/api/sessions/${c.id}/cancel`, { method: 'POST' });
    const rc = await waitRun(c.id, 'C cancel');
    check(rc.fin?.status === 'cancelled', 'running task can be stopped');
  }

  const aEvents = await api(`/api/sessions/${a.id}/events`);
  fs.writeFileSync(STATE, JSON.stringify({ sessions: [a.id, b.id], minEvents: aEvents.length }));
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    for (const s of [a, b]) {
      fs.writeFileSync(path.join(OUT, `session-${s.id}.md`), await api(`/api/sessions/${s.id}/export`));
    }
    fs.writeFileSync(path.join(OUT, 'health.json'), JSON.stringify(health, null, 2));
    log(`evidence written to ${OUT}`);
  }
  log('ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
