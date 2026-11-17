'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const archiver = require('archiver');
const { execFile } = require('child_process');
const { loadConfig } = require('./config');
const { Store, HttpError } = require('./store');
const { Runner } = require('./runner');
const files = require('./files');

const TEXT_EXT = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.js', '.ts', '.py', '.html', '.css', '.yml', '.yaml', '.toml', '.xml', '.sh', '.log', '.ini', '.sql', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.jsx', '.tsx', '.vue']);

function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const store = new Store(config.dataDir);
  const runner = new Runner(store, config);
  runner.recoverInterrupted();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const wrap = (fn) => (req, res, next) => {
    try {
      fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };
  const view = (s) => ({ ...s, running: runner.isRunning(s.id) });

  let cliVersion = null;
  if (config.agentCli === 'mock') cliVersion = 'mock';
  else {
    const bin = config.agentCli === 'codex' ? config.codexBin : config.claudeBin;
    execFile(bin, ['--version'], { timeout: 20000, env: { ...process.env, HOME: config.agentHome } }, (err, stdout) => {
      cliVersion = err ? `unavailable: ${err.message}` : stdout.trim();
    });
  }

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      agentCli: config.agentCli,
      cliVersion,
      model: config.model || null,
      credentialsConfigured: runner.credentialsConfigured(),
      activeRuns: runner.active.size,
    });
  });

  // ---- sessions ----
  app.get('/api/sessions', (req, res) => res.json(store.list().map(view)));
  app.post('/api/sessions', wrap((req, res) => res.status(201).json(view(store.create(req.body?.title)))));
  app.get('/api/sessions/:id', wrap((req, res) => res.json(view(store.require(req.params.id)))));
  app.patch(
    '/api/sessions/:id',
    wrap((req, res) => {
      store.require(req.params.id);
      const title = String(req.body?.title || '').trim().slice(0, 80);
      if (!title) throw new HttpError(400, '标题不能为空');
      res.json(view(store.update(req.params.id, { title })));
    }),
  );
  app.delete(
    '/api/sessions/:id',
    wrap((req, res) => {
      store.require(req.params.id);
      if (runner.isRunning(req.params.id)) throw new HttpError(409, '请先停止正在执行的任务');
      store.delete(req.params.id);
      res.json({ ok: true });
    }),
  );

  // ---- conversation ----
  app.get(
    '/api/sessions/:id/events',
    wrap((req, res) => {
      store.require(req.params.id);
      res.json(store.readEvents(req.params.id, Number(req.query.after || 0)));
    }),
  );

  // Server-Sent Events: replay everything after `after` (or Last-Event-ID on auto-reconnect), then live.
  app.get(
    '/api/sessions/:id/stream',
    wrap((req, res) => {
      const id = req.params.id;
      store.require(id);
      const after = Number(req.headers['last-event-id'] || req.query.after || 0);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const send = (e) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      for (const e of store.readEvents(id, after)) send(e); // sync replay: no event can slip in between
      const unsubscribe = store.subscribe(id, send);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
    }),
  );

  app.post(
    '/api/sessions/:id/messages',
    wrap((req, res) => {
      store.require(req.params.id);
      const text = String(req.body?.text || '').trim();
      if (!text) throw new HttpError(400, '消息不能为空');
      if (text.length > 30000) throw new HttpError(413, '消息过长（上限 30000 字符），请把长材料作为文件上传');
      const runId = runner.start(req.params.id, text);
      res.status(202).json({ ok: true, runId });
    }),
  );

  app.post(
    '/api/sessions/:id/cancel',
    wrap((req, res) => {
      store.require(req.params.id);
      runner.cancel(req.params.id);
      res.json({ ok: true });
    }),
  );

  // ---- files ----
  app.get(
    '/api/sessions/:id/files',
    wrap((req, res) => {
      store.require(req.params.id);
      res.json(files.walk(store.workspace(req.params.id)));
    }),
  );

  app.get(
    '/api/sessions/:id/file',
    wrap((req, res) => {
      store.require(req.params.id);
      const abs = files.safeJoin(store.workspace(req.params.id), req.query.path);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, '文件不存在');
      if (req.query.download) return res.download(abs, path.basename(abs), { dotfiles: 'allow' });
      // Agent-produced files (e.g. an HTML tool it built) are opened in a sandboxed origin so they
      // can run their own scripts but cannot call this workbench's API.
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-modals allow-downloads');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const ext = path.extname(abs).toLowerCase();
      if (TEXT_EXT.has(ext) && ext !== '.html') res.type('text/plain; charset=utf-8');
      res.sendFile(abs, { dotfiles: 'allow' });
    }),
  );

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(store.workspace(req.params.id), 'uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const original = Buffer.from(file.originalname, 'latin1').toString('utf8'); // multer decodes as latin1
        const dir = path.join(store.workspace(req.params.id), 'uploads');
        cb(null, path.basename(files.uniquePath(dir, files.sanitizeFilename(original))));
      },
    }),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20 },
  });

  app.post(
    '/api/sessions/:id/upload',
    wrap((req, res, next) => {
      store.require(req.params.id);
      next();
    }),
    upload.array('files', 20),
    wrap((req, res) => {
      const list = (req.files || []).map((f) => ({ path: `uploads/${f.filename}`, size: f.size }));
      if (!list.length) throw new HttpError(400, '没有收到文件');
      store.append(req.params.id, { type: 'files_uploaded', files: list });
      store.update(req.params.id, {});
      res.status(201).json(list);
    }),
  );

  app.get(
    '/api/sessions/:id/archive',
    wrap((req, res, next) => {
      const s = store.require(req.params.id);
      const name = `${s.title.replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || s.id}-workspace.zip`;
      res.attachment(name);
      const zip = archiver('zip', { zlib: { level: 6 } });
      zip.on('error', next);
      zip.pipe(res);
      zip.glob('**/*', { cwd: store.workspace(s.id), dot: true, ignore: [...files.SKIP_DIRS].map((d) => `**/${d}/**`) });
      zip.finalize();
    }),
  );

  // Markdown transcript: conversation, tool calls, outcomes, file list. Used as demo evidence.
  app.get(
    '/api/sessions/:id/export',
    wrap((req, res) => {
      const s = store.require(req.params.id);
      res.type('text/markdown; charset=utf-8');
      res.attachment(`session-${s.id}.md`);
      res.send(exportMarkdown(s, store.readEvents(s.id), files.walk(store.workspace(s.id))));
    }),
  );

  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    const message = err.code === 'LIMIT_FILE_SIZE' ? `文件超过上限 ${config.maxUploadMb}MB` : err.message;
    if (res.headersSent) return res.end();
    res.status(status).json({ error: message });
  });

  return { app, store, runner, config };
}

function exportMarkdown(s, events, fileList) {
  const lines = [`# 会话记录：${s.title}`, '', `- 会话 ID：${s.id}`, `- 创建时间：${s.createdAt}`, `- 导出时间：${new Date().toISOString()}`, ''];
  const tools = new Map();
  for (const e of events) {
    if (e.type === 'user_message') lines.push(`## 用户 · ${e.ts}`, '', e.text, '');
    else if (e.type === 'assistant_text') lines.push(`**助手：**`, '', e.text, '');
    else if (e.type === 'agent_init') lines.push(`> Agent 会话 ${e.sessionId}（模型 ${e.model}${e.resumed ? '，续接上一轮' : ''}）`, '');
    else if (e.type === 'tool_call') {
      tools.set(e.toolId, e);
      const brief = e.input?.command || e.input?.file_path || e.input?.path || e.input?.pattern || '';
      lines.push(`- 工具 \`${e.name}\` ${brief ? `\`${String(brief).slice(0, 160).replace(/`/g, "'")}\`` : ''}`);
    } else if (e.type === 'tool_result' && e.isError) lines.push(`  - ✖ 工具出错：${e.output.slice(0, 200).replace(/\n/g, ' ')}`);
    else if (e.type === 'files_uploaded') lines.push(`> 上传文件：${e.files.map((f) => f.path).join('，')}`, '');
    else if (e.type === 'files_changed') {
      lines.push('', `> 本轮文件变化 — 新增：${e.added.join('，') || '无'}；修改：${e.modified.join('，') || '无'}；删除：${e.deleted.join('，') || '无'}`, '');
    } else if (e.type === 'notice') lines.push(`> 提示：${e.text}`, '');
    else if (e.type === 'run_finished') {
      const secs = e.durationMs ? `，用时 ${(e.durationMs / 1000).toFixed(1)}s` : '';
      lines.push(`> 执行结果：**${e.status}**${secs}${e.numTurns ? `，${e.numTurns} 轮` : ''}${e.error ? `；${e.error}` : ''}`, '');
    }
  }
  lines.push('## 工作区文件', '');
  for (const f of fileList) lines.push(`- ${f.path}（${f.size} B）`);
  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  const { app, runner, config } = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`Agent workbench listening on http://${config.host}:${config.port} (agent=${config.agentCli}, data=${config.dataDir})`);
  });
  const stop = () => {
    runner.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createApp, exportMarkdown };
