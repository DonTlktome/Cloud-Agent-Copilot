'use strict';
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./store');

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.cache', '.pytest_cache']);
const MAX_ENTRIES = 3000;

// Resolve a user-supplied relative path and refuse anything that escapes the workspace.
function safeJoin(root, rel) {
  const base = path.resolve(root);
  const p = path.resolve(base, String(rel || '.').replace(/^[/\\]+/, ''));
  if (p !== base && !p.startsWith(base + path.sep)) throw new HttpError(400, '非法路径');
  return p;
}

function walk(root) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < MAX_ENTRIES) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) stack.push(r);
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(path.join(root, r));
          out.push({ path: r, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        } catch {
          /* file vanished */
        }
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function snapshot(root) {
  const map = new Map();
  for (const f of walk(root)) map.set(f.path, `${f.size}:${f.mtimeMs}`);
  return map;
}

function diffSnapshots(before, after) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [p, sig] of after) {
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== sig) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  return { added, modified, deleted };
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file')).replace(/[\x00-\x1f<>:"|?*\\/]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 180) : 'file';
}

function uniquePath(dir, name) {
  let candidate = path.join(dir, name);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

module.exports = { safeJoin, walk, snapshot, diffSnapshots, sanitizeFilename, uniquePath, SKIP_DIRS };
