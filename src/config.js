'use strict';
const path = require('path');

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

function loadConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir || env.DATA_DIR || path.join(__dirname, '..', 'data'));
  return {
    port: num(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    dataDir,
    agentHome: path.join(dataDir, 'agent-home'),
    // codex = OpenAI Codex CLI (Responses API), claude = Claude Code (via LiteLLM proxy),
    // mock = built-in fake CLI for tests / key-less demo
    agentCli: (env.AGENT_CLI || 'codex').toLowerCase(),
    codexBin: env.CODEX_BIN || 'codex',
    claudeBin: env.CLAUDE_BIN || 'claude',
    model: env.AGENT_MODEL || env.ANTHROPIC_MODEL || '',
    maxTurns: num(env.MAX_TURNS, 80),
    runTimeoutSec: num(env.RUN_TIMEOUT_SEC, 1200),
    maxConcurrentRuns: num(env.MAX_CONCURRENT_RUNS, 3),
    maxUploadMb: num(env.MAX_UPLOAD_MB, 50),
    ...overrides,
  };
}

module.exports = { loadConfig };
