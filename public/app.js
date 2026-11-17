'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { sessions: [], current: null, es: null, lastSeq: 0, tools: new Map(), pending: [], fresh: new Set(), lastTool: '', runStart: null };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const fmtTime = (iso) => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const STATUS = { idle: '空闲', running: '执行中', failed: '失败', cancelled: '已停止', interrupted: '已中断' };

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}, ...opts });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
    return data;
  }
  function toast(msg, kind = 'err') {
    const el = document.createElement('div');
    el.className = `sys ${kind}`;
    el.textContent = msg;
    $('timeline').appendChild(el);
    scrollDown(true);
  }

  // Minimal, safe markdown: escape first, then add formatting.
  function md(src) {
    const blocks = [];
    let s = String(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    s = esc(s);
    const lines = s.split('\n');
    const out = [];
    let list = null;
    let table = null;
    const inline = (t) => t
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const flush = () => {
      if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
      if (table) { out.push(`<table>${table.join('')}</table>`); table = null; }
    };
    for (const line of lines) {
      const t = line.trim();
      if (/^\u0000\d+\u0000$/.test(t)) { flush(); out.push(t); continue; }
      if (/^\|.*\|$/.test(t)) {
        if (/^\|[\s:|-]+\|$/.test(t)) continue;
        table = table || [];
        table.push(`<tr>${t.slice(1, -1).split('|').map((c) => `<td>${inline(c.trim())}</td>`).join('')}</tr>`);
        continue;
      }
      const h = t.match(/^(#{1,4})\s+(.*)$/);
      const li = t.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
      if (h) { flush(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); }
      else if (li) { if (table) flush(); list = list || []; list.push(`<li>${inline(li[1])}</li>`); }
      else if (!t) flush();
      else { flush(); out.push(`<p>${inline(line)}</p>`); }
    }
    flush();
    return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }

  function scrollDown(force) {
    const tl = $('timeline');
    if (force || tl.scrollHeight - tl.scrollTop - tl.clientHeight < 200) tl.scrollTop = tl.scrollHeight;
  }

  // ---------- sessions ----------
  async function loadSessions() {
    state.sessions = await api('/api/sessions');
    renderSessions();
    if (state.current) {
      const s = state.sessions.find((x) => x.id === state.current);
      if (s) renderHeader(s);
    }
  }

  function renderSessions() {
    const ul = $('sessionList');
    ul.innerHTML = '';
    if (!state.sessions.length) ul.innerHTML = '<li class="muted">还没有会话</li>';
    for (const s of state.sessions) {
      const li = document.createElement('li');
      const st = s.running ? 'running' : s.status;
      li.className = s.id === state.current ? 'active' : '';
      li.innerHTML = `<div class="s-title"><span class="dot ${st}"></span>${esc(s.title)}</div><div class="s-meta">${STATUS[st] || st} · ${fmtTime(s.updatedAt)}${s.lastMessage ? ` · ${esc(s.lastMessage)}` : ''}</div>`;
      li.onclick = () => openSession(s.id);
      ul.appendChild(li);
    }
  }

  function renderHeader(s) {
    const st = s.running ? 'running' : s.status;
    $('sessionTitle').textContent = s.title;
    const b = $('statusBadge');
    b.className = `badge ${st}`;
    b.textContent = STATUS[st] || st;
    for (const id of ['renameBtn', 'deleteBtn', 'refreshFiles', 'sendBtn']) $(id).disabled = false;
    $('input').disabled = false;
    $('exportBtn').classList.remove('disabled');
    $('zipBtn').classList.remove('disabled');
    $('exportBtn').href = `/api/sessions/${s.id}/export`;
    $('zipBtn').href = `/api/sessions/${s.id}/archive`;
    setRunning(!!s.running);
  }

  function setRunning(running) {
    $('stopBtn').classList.toggle('hidden', !running);
    $('sendBtn').disabled = running || !state.current;
    $('sendBtn').textContent = running ? '执行中…' : '发送';
    if (!running) { state.runStart = null; $('progress').textContent = ''; }
  }

  async function openSession(id) {
    if (state.es) state.es.close();
    state.current = id;
    state.lastSeq = 0;
    state.tools.clear();
    state.fresh.clear();
    state.pending = [];
    renderAttachments();
    location.hash = `s=${id}`;
    $('timeline').innerHTML = '';
    $('preview').classList.add('hidden');
    renderSessions();
    try {
      renderHeader(await api(`/api/sessions/${id}`));
    } catch (err) {
      toast(err.message);
      return;
    }
    loadFiles();
    connect();
  }

  // SSE with resume: the browser re-sends Last-Event-ID on reconnect; on a manual reconnect we pass ?after.
  function connect() {
    const id = state.current;
    const es = new EventSource(`/api/sessions/${id}/stream?after=${state.lastSeq}`);
    state.es = es;
    es.onmessage = (m) => {
      if (state.current !== id) return;
      const e = JSON.parse(m.data);
      if (e.seq <= state.lastSeq) return;
      state.lastSeq = e.seq;
      renderEvent(e);
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && state.current === id) setTimeout(() => state.current === id && connect(), 2000);
    };
  }

  // ---------- timeline ----------
  function toolBrief(name, input) {
    if (!input) return '';
    if (input.command) return Array.isArray(input.command) ? input.command.join(' ') : input.command;
    if (input.file_path || input.path) return input.file_path || input.path;
    if (input.pattern) return input.pattern;
    if (input.changes) return input.changes.map((c) => `${c.kind || ''} ${c.path}`).join(', ');
    if (input.url) return input.url;
    if (input.query) return input.query;
    if (input.todos || input.items) return `${(input.todos || input.items).length} 项计划`;
    return JSON.stringify(input).slice(0, 120);
  }

  function renderEvent(e) {
    const tl = $('timeline');
    const add = (el) => { tl.appendChild(el); scrollDown(); };
    const div = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; };
    switch (e.type) {
      case 'user_message': add(div('msg user', esc(e.text))); break;
      case 'assistant_text': add(div('msg assistant', md(e.text))); break;
      case 'run_started':
        state.runStart = new Date(e.ts);
        state.lastTool = '';
        add(div('sys', `▶ 开始执行 · ${fmtTime(e.ts)}`));
        setRunning(true);
        break;
      case 'agent_init': add(div('sys', `Agent 已就绪 · 模型 ${esc(e.model || '-')}${e.resumed ? ' · 续接上一轮上下文' : ' · 新上下文'}`)); break;
      case 'tool_call': {
        const d = document.createElement('details');
        d.className = 'tool';
        const brief = toolBrief(e.name, e.input);
        d.innerHTML = `<summary><span class="t-name">${esc(e.name)}</span><span class="t-brief">${esc(brief)}</span><span class="t-state">运行中…</span></summary><div class="t-label">输入</div><pre>${esc(JSON.stringify(e.input, null, 2))}</pre>`;
        state.tools.set(e.toolId, d);
        state.lastTool = `${e.name} ${brief}`.slice(0, 80);
        add(d);
        break;
      }
      case 'tool_result': {
        const d = state.tools.get(e.toolId);
        if (!d) break;
        const s = d.querySelector('.t-state');
        s.textContent = e.isError ? '出错' : '完成';
        s.className = `t-state ${e.isError ? 'err' : 'ok'}`;
        d.insertAdjacentHTML('beforeend', `<div class="t-label">输出</div><pre>${esc(e.output || '（无输出）')}</pre>`);
        break;
      }
      case 'files_uploaded': add(div('sys', `已上传：${e.files.map((f) => esc(f.path)).join('，')}`)); loadFiles(); break;
      case 'files_changed': {
        const d = div('changes', '');
        const group = (label, list, clickable) => {
          if (!list.length) return;
          d.insertAdjacentHTML('beforeend', `<div><span class="label">${label}</span></div>`);
          const row = d.lastChild;
          for (const p of list) {
            state.fresh.add(p);
            const a = document.createElement(clickable ? 'a' : 'span');
            a.textContent = p;
            if (clickable) a.onclick = () => preview(p);
            else a.className = 'muted';
            row.appendChild(a);
            row.appendChild(document.createTextNode(' '));
          }
        };
        d.innerHTML = '<strong>本轮成果</strong>';
        group('新增', e.added, true);
        group('修改', e.modified, true);
        group('删除', e.deleted, false);
        add(d);
        loadFiles();
        break;
      }
      case 'notice': add(div('sys warn', esc(e.text))); break;
      case 'run_finished': {
        const secs = e.durationMs ? ` · 用时 ${Math.round(e.durationMs / 1000)}s` : '';
        const turns = e.numTurns ? ` · ${e.numTurns} 轮` : '';
        const tokens = e.usage && (e.usage.output_tokens || e.usage.input_tokens) ? ` · tokens ${e.usage.input_tokens || 0}/${e.usage.output_tokens || 0}` : '';
        const map = { succeeded: ['ok', '✔ 完成'], failed: ['err', '✖ 失败'], cancelled: ['warn', '■ 已停止'], interrupted: ['err', '⚠ 已中断'] };
        const [cls, label] = map[e.status] || ['', e.status];
        const d = div(`sys ${cls}`, `${label}${secs}${turns}${tokens}${e.error ? `<br>${esc(e.error)}` : ''}${e.stderr ? `<pre>${esc(e.stderr)}</pre>` : ''}`);
        for (const t of state.tools.values()) {
          const s = t.querySelector('.t-state');
          if (s.textContent === '运行中…') s.textContent = '未完成';
        }
        add(d);
        setRunning(false);
        loadSessions();
        loadFiles();
        break;
      }
      default: break;
    }
  }

  setInterval(() => {
    if (state.runStart) {
      const s = Math.round((Date.now() - state.runStart) / 1000);
      $('progress').textContent = `已运行 ${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s${state.lastTool ? ` · 最近操作：${state.lastTool}` : ''}`;
    }
  }, 1000);
  setInterval(() => loadSessions().catch(() => {}), 4000);

  // ---------- composer ----------
  async function send() {
    const text = $('input').value.trim();
    if (!state.current || (!text && !state.pending.length)) return;
    let full = text || '请查看我上传的文件并处理。';
    if (state.pending.length) full += `\n\n[已上传文件] ${state.pending.map((f) => f.path).join('，')}`;
    $('sendBtn').disabled = true;
    try {
      await api(`/api/sessions/${state.current}/messages`, { method: 'POST', body: JSON.stringify({ text: full }) });
      $('input').value = '';
      state.pending = [];
      renderAttachments();
      loadSessions();
    } catch (err) {
      toast(err.message);
      $('sendBtn').disabled = false;
    }
  }

  function renderAttachments() {
    const box = $('attachments');
    box.innerHTML = '';
    state.pending.forEach((f, i) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = `${esc(f.path)} <button title="不在消息中引用">×</button>`;
      c.querySelector('button').onclick = () => { state.pending.splice(i, 1); renderAttachments(); };
      box.appendChild(c);
    });
  }

  async function uploadFiles(list) {
    if (!state.current || !list.length) return;
    const fd = new FormData();
    for (const f of list) fd.append('files', f);
    try {
      const saved = await api(`/api/sessions/${state.current}/upload`, { method: 'POST', body: fd });
      state.pending.push(...saved);
      renderAttachments();
    } catch (err) {
      toast(`上传失败：${err.message}`);
    }
  }

  // ---------- files ----------
  async function loadFiles() {
    if (!state.current) return;
    const id = state.current;
    let list;
    try {
      list = await api(`/api/sessions/${id}/files`);
    } catch {
      return;
    }
    if (id !== state.current) return;
    const box = $('fileList');
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="muted">暂无文件。上传材料或让助手产出成果后会出现在这里。</div>'; return; }
    const groups = { outputs: [], uploads: [], other: [] };
    for (const f of list) (f.path.startsWith('outputs/') ? groups.outputs : f.path.startsWith('uploads/') ? groups.uploads : groups.other).push(f);
    const names = { outputs: '成果 outputs/', uploads: '上传 uploads/', other: '其他' };
    for (const k of Object.keys(groups)) {
      if (!groups[k].length) continue;
      box.insertAdjacentHTML('beforeend', `<div class="file-group">${names[k]}</div>`);
      for (const f of groups[k]) {
        const row = document.createElement('div');
        row.className = `file${state.fresh.has(f.path) ? ' fresh' : ''}`;
        row.title = f.path;
        row.innerHTML = `<span class="f-path">${esc(f.path)}</span><span class="f-size">${fmtSize(f.size)}</span>`;
        row.onclick = () => preview(f.path);
        box.appendChild(row);
      }
    }
  }

  async function preview(p) {
    const url = `/api/sessions/${state.current}/file?path=${encodeURIComponent(p)}`;
    $('preview').classList.remove('hidden');
    $('previewName').textContent = p;
    $('previewOpen').href = url;
    $('previewDownload').href = `${url}&download=1`;
    const body = $('previewBody');
    const ext = p.split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) { body.innerHTML = `<img src="${url}" alt="">`; return; }
    if (['html', 'htm', 'pdf'].includes(ext)) { body.innerHTML = `<iframe sandbox="allow-scripts allow-forms" src="${url}"></iframe>`; return; }
    body.innerHTML = '<div class="muted">加载中…</div>';
    try {
      const res = await fetch(url);
      const size = Number(res.headers.get('content-length') || 0);
      const type = res.headers.get('content-type') || '';
      if (!type.startsWith('text/') && !/json|javascript|xml/.test(type)) { body.innerHTML = '<div class="muted">该类型不支持预览，请下载查看。</div>'; return; }
      if (size > 2 * 1024 * 1024) { body.innerHTML = '<div class="muted">文件较大，请下载查看。</div>'; return; }
      const text = await res.text();
      body.innerHTML = ext === 'md' ? `<div class="msg assistant" style="border:none;padding:0">${md(text)}</div>` : `<pre class="plain">${esc(text)}</pre>`;
    } catch (err) {
      body.innerHTML = `<div class="sys err">${esc(err.message)}</div>`;
    }
  }

  // ---------- wiring ----------
  $('newSession').onclick = async () => {
    try {
      const s = await api('/api/sessions', { method: 'POST', body: JSON.stringify({}) });
      await loadSessions();
      openSession(s.id);
      $('input').focus();
    } catch (err) { toast(err.message); }
  };
  $('sendBtn').onclick = send;
  $('input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); send(); } });
  $('stopBtn').onclick = async () => { try { await api(`/api/sessions/${state.current}/cancel`, { method: 'POST' }); } catch (err) { toast(err.message); } };
  $('fileInput').onchange = (ev) => { uploadFiles([...ev.target.files]); ev.target.value = ''; };
  $('refreshFiles').onclick = loadFiles;
  $('previewClose').onclick = () => $('preview').classList.add('hidden');
  $('renameBtn').onclick = async () => {
    const s = state.sessions.find((x) => x.id === state.current);
    const title = prompt('会话名称', s?.title || '');
    if (!title) return;
    try { await api(`/api/sessions/${state.current}`, { method: 'PATCH', body: JSON.stringify({ title }) }); loadSessions(); } catch (err) { toast(err.message); }
  };
  $('deleteBtn').onclick = async () => {
    if (!confirm('删除后会话记录和工作区文件将无法恢复，确定删除？')) return;
    try {
      await api(`/api/sessions/${state.current}`, { method: 'DELETE' });
      if (state.es) state.es.close();
      state.current = null;
      location.hash = '';
      location.reload();
    } catch (err) { toast(err.message); }
  };
  const tl = $('timeline');
  tl.addEventListener('dragover', (ev) => ev.preventDefault());
  tl.addEventListener('drop', (ev) => { ev.preventDefault(); uploadFiles([...ev.dataTransfer.files]); });

  (async () => {
    try {
      const h = await api('/api/health');
      $('health').innerHTML = `Agent：${esc(h.agentCli)} ${esc(h.cliVersion || '')}<br>模型：${esc(h.model || '默认')}`;
      if (!h.credentialsConfigured) {
        $('banner').textContent = '未检测到模型凭据，请在 .env 中配置 MODEL_API_KEY 等变量后重启（详见 README）。';
        $('banner').classList.remove('hidden');
      }
    } catch { /* ignore */ }
    await loadSessions();
    const m = location.hash.match(/s=([\w-]+)/);
    if (m && state.sessions.some((s) => s.id === m[1])) openSession(m[1]);
    else if (state.sessions.length) openSession(state.sessions[0].id);
  })();
})();
