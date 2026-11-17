'use strict';
// File-based persistence. One directory per session:
//   sessions/<id>/session.json   metadata (title, status, Claude Code session id ...)
//   sessions/<id>/events.jsonl   append-only event log (source of truth for the timeline)
//   sessions/<id>/workspace/     the agent's working directory (uploads/, outputs/ ...)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class Store {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'sessions');
    fs.mkdirSync(this.root, { recursive: true });
    this.sessions = new Map();
    this.lastSeq = new Map();
    this.listeners = new Map();
    this._load();
  }

  _load() {
    for (const id of fs.readdirSync(this.root)) {
      const file = path.join(this.root, id, 'session.json');
      if (!fs.existsSync(file)) continue;
      try {
        this.sessions.set(id, JSON.parse(fs.readFileSync(file, 'utf8')));
        const events = this.readEvents(id);
        this.lastSeq.set(id, events.length ? events[events.length - 1].seq : 0);
      } catch (err) {
        console.error(`[store] skip broken session ${id}: ${err.message}`);
      }
    }
  }

  dir(id) {
    return path.join(this.root, id);
  }

  workspace(id) {
    return path.join(this.root, id, 'workspace');
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id) {
    return this.sessions.get(id);
  }

  require(id) {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, '会话不存在');
    return s;
  }

  create(title) {
    const id = crypto.randomBytes(6).toString('hex');
    const now = new Date().toISOString();
    const meta = {
      id,
      title: (title && String(title).trim().slice(0, 80)) || '新会话',
      status: 'idle', // idle | running | failed | cancelled | interrupted
      createdAt: now,
      updatedAt: now,
      agentSessionId: null,
      lastMessage: '',
      turns: 0,
    };
    fs.mkdirSync(path.join(this.workspace(id), 'uploads'), { recursive: true });
    fs.mkdirSync(path.join(this.workspace(id), 'outputs'), { recursive: true });
    this.sessions.set(id, meta);
    this.lastSeq.set(id, 0);
    this._save(id);
    return meta;
  }

  update(id, patch) {
    const meta = { ...this.require(id), ...patch, updatedAt: new Date().toISOString() };
    this.sessions.set(id, meta);
    this._save(id);
    return meta;
  }

  _save(id) {
    const file = path.join(this.dir(id), 'session.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.sessions.get(id), null, 2));
    fs.renameSync(tmp, file); // atomic replace, survives crashes mid-write
  }

  delete(id) {
    this.require(id);
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    this.sessions.delete(id);
    this.lastSeq.delete(id);
    this.listeners.delete(id);
  }

  append(id, event) {
    const seq = (this.lastSeq.get(id) || 0) + 1;
    this.lastSeq.set(id, seq);
    const e = { seq, ts: new Date().toISOString(), ...event };
    fs.appendFileSync(path.join(this.dir(id), 'events.jsonl'), `${JSON.stringify(e)}\n`);
    for (const fn of this.listeners.get(id) || []) {
      try {
        fn(e);
      } catch (err) {
        console.error('[store] listener error', err);
      }
    }
    return e;
  }

  readEvents(id, after = 0) {
    const file = path.join(this.dir(id), 'events.jsonl');
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.seq > after) out.push(e);
      } catch {
        // a torn last line after a crash is ignored
      }
    }
    return out;
  }

  subscribe(id, fn) {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(fn);
    return () => this.listeners.get(id)?.delete(fn);
  }
}

module.exports = { Store, HttpError };
