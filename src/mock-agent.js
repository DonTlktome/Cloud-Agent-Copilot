#!/usr/bin/env node
'use strict';
// A stand-in for `claude -p --output-format stream-json` used by tests and key-less demos
// (AGENT_CLI=mock). It emits the same JSONL message shapes and really writes a file.
// Magic words in the prompt: [fail] -> API-style error, [slow] -> takes 60s (to test "stop").
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delay = Number(process.env.MOCK_DELAY_MS || 300);

async function main() {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const stateDir = path.join(os.homedir(), '.mock-agent');
  fs.mkdirSync(stateDir, { recursive: true });

  const resume = opt('--resume');
  if (resume && !fs.existsSync(path.join(stateDir, resume))) {
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    process.exit(1);
  }
  const sessionId = resume || crypto.randomUUID();
  const stateFile = path.join(stateDir, sessionId);
  const turn = (resume ? Number(fs.readFileSync(stateFile, 'utf8')) : 0) + 1;
  fs.writeFileSync(stateFile, String(turn));

  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'mock-model', cwd: process.cwd(), tools: ['Write', 'Bash'] });
  await sleep(delay);
  const firstLine = prompt.trim().split('\n').pop().slice(0, 60);
  out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: `收到（本会话第 ${turn} 轮）：${firstLine}` }] } });

  if (prompt.includes('[slow]')) await sleep(60000);
  if (prompt.includes('[fail]')) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 401 invalid api key (mock)', session_id: sessionId, num_turns: 1 });
    process.exit(1);
  }

  const rel = `outputs/mock-turn-${turn}.md`;
  const content = `# Mock output, turn ${turn}\n\n${prompt.trim()}\n`;
  out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${turn}`, name: 'Write', input: { file_path: rel, content } }] } });
  await sleep(delay);
  fs.mkdirSync(path.join(process.cwd(), 'outputs'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), rel), content);
  out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${turn}`, content: `File created successfully at: ${rel}` }] } });
  await sleep(delay);
  out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: `已完成，产出文件：\`${rel}\`` }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId, num_turns: 2, total_cost_usd: 0, duration_ms: delay * 3 });
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err));
  process.exit(1);
});
