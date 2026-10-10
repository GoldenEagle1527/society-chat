/**
 * Shared observe / society-live HTTP server (Node http only).
 * - observe mode: read-only GET /
 * - live mode: POST /api/say (localhost only) + compose UI
 * Never serves .env or API keys.
 */
import http from 'node:http'
import type { RoomMessage } from './types.ts'
import { HUMAN_SPEAKER_ID, speakerLabel } from './types.ts'
import { isForbiddenObservePath, readObserveState } from './observe-state.ts'

export type ObserveMode = 'observe' | 'live'

export interface SayRequest {
  roomId?: string
  roomName?: string
  text: string
  as?: 'human'
}

export interface SayResult {
  ok: true
  message: RoomMessage
  roomId: string
  roomName: string
}

export interface ObserveServerOptions {
  mode: ObserveMode
  host?: string
  port?: number
  /** Live only: post human message into society. */
  onSay?: (req: SayRequest) => SayResult | Promise<SayResult>
  /** Optional live status line for /api/state note override. */
  liveNote?: () => string
}

export interface ObserveServer {
  server: http.Server
  host: string
  port: number
  close: () => Promise<void>
}

function escHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

function buildHtml(mode: ObserveMode): string {
  const live = mode === 'live'
  const title = live ? '社会直播 · society-chat' : '社会旁观 · society-chat'
  const heading = live ? '社会直播（可插话）' : '社会旁观'
  const footer = live
    ? '互动模式：本进程同时跑心跳调度。发消息后 Agent 会在后续 tick 回复。不暴露密钥。'
    : '只读旁观。自主运行请用 <code>npm run society-live</code>（推荐）或另开 <code>npm run society-run</code>。不暴露密钥。'

  const compose = live
    ? `
    <section style="grid-column:1/-1" class="compose">
      <h2>你来说一句</h2>
      <div class="row">
        <label>房间
          <select id="roomSelect"></select>
        </label>
        <textarea id="sayText" rows="2" maxlength="2000" placeholder="对广场说点什么…（代理会在心跳里回复）"></textarea>
        <button type="button" id="sayBtn">发送</button>
      </div>
      <div class="meta" id="sayStatus"></div>
    </section>`
    : ''

  const composeScript = live
    ? `
    function fillRooms(rooms) {
      const sel = document.getElementById('roomSelect');
      const prev = sel.value;
      sel.innerHTML = '';
      (rooms || []).forEach((r) => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.name + ' (' + (r.members || []).join(',') + ')';
        sel.appendChild(opt);
      });
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
      else {
        const plaza = (rooms || []).find((r) => r.name === 'plaza');
        if (plaza) sel.value = plaza.id;
      }
    }
    async function sendSay() {
      const text = (document.getElementById('sayText').value || '').trim();
      const roomId = document.getElementById('roomSelect').value;
      const status = document.getElementById('sayStatus');
      if (!text) { status.textContent = '请先输入内容'; return; }
      if (!roomId) { status.textContent = '没有可选房间（先跑 society-live）'; return; }
      status.textContent = '发送中…';
      try {
        const res = await fetch('/api/say', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId, text, as: 'human' }),
        });
        const data = await res.json();
        if (!res.ok) {
          status.textContent = '失败：' + (data.error || res.status);
          return;
        }
        document.getElementById('sayText').value = '';
        status.textContent = '已发送到「' + (data.roomName || '') + '」，等待 Agent 心跳回复…';
        tick();
      } catch (e) {
        status.textContent = '失败：' + e;
      }
    }
    document.getElementById('sayBtn').addEventListener('click', sendSay);
    document.getElementById('sayText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendSay();
    });
`
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escHtml(title)}</title>
  <style>
    :root { color-scheme: dark light; --bg:#0f1419; --card:#1a2332; --fg:#e7ecf3; --muted:#8b9bb4; --accent:#6cb6ff; --ok:#3dd68c; --btn:#2b6cb0; }
    * { box-sizing: border-box; }
    body { margin:0; font:14px/1.45 system-ui,sans-serif; background:var(--bg); color:var(--fg); }
    header { padding:16px 20px; border-bottom:1px solid #243044; display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
    h1 { margin:0; font-size:18px; }
    .note { color:var(--muted); font-size:12px; max-width:720px; }
    main { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:14px; padding:16px; }
    section { background:var(--card); border-radius:10px; padding:12px 14px; min-height:120px; }
    h2 { margin:0 0 10px; font-size:14px; color:var(--accent); }
    .agent { border:1px solid #2a3a52; border-radius:8px; padding:8px 10px; margin-bottom:8px; }
    .agent strong { font-size:15px; }
    .meta { color:var(--muted); font-size:12px; }
    .bars { display:grid; gap:4px; margin-top:6px; font-size:11px; }
    .bar { display:grid; grid-template-columns:52px 1fr 36px; gap:6px; align-items:center; }
    .bar i { display:block; height:6px; background:#2a3a52; border-radius:3px; overflow:hidden; }
    .bar i b { display:block; height:100%; background:var(--ok); }
    .msg, .log { font-size:12px; padding:6px 0; border-bottom:1px solid #243044; }
    .msg:last-child, .log:last-child { border-bottom:none; }
    .from { color:var(--accent); font-weight:600; }
    .from.human { color:#f6c177; }
    code { background:#0c1018; padding:1px 5px; border-radius:4px; font-size:12px; }
    .pill { display:inline-block; background:#243044; color:var(--muted); padding:2px 8px; border-radius:999px; font-size:11px; margin-right:6px; }
    footer { padding:8px 20px 20px; color:var(--muted); font-size:12px; }
    .compose .row { display:grid; grid-template-columns:180px 1fr auto; gap:10px; align-items:start; }
    @media (max-width:720px) { .compose .row { grid-template-columns:1fr; } }
    label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
    select, textarea, button { font:inherit; border-radius:8px; border:1px solid #2a3a52; background:#0c1018; color:var(--fg); padding:8px 10px; }
    button { background:var(--btn); border-color:#3b82c4; cursor:pointer; white-space:nowrap; }
    button:hover { filter:brightness(1.08); }
    textarea { resize:vertical; min-height:56px; width:100%; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escHtml(heading)}</h1>
      <div class="note" id="note">加载中…</div>
    </div>
    <div>
      <span class="pill" id="modePill">${live ? '直播' : '只读'}</span>
      <span class="pill" id="stamp">—</span>
      <span class="pill">LLM 今日合计 <b id="llmTotal">0</b></span>
    </div>
  </header>
  <main>
    ${compose}
    <section>
      <h2>Agent 列表</h2>
      <div id="agents"></div>
    </section>
    <section>
      <h2>房间</h2>
      <div id="rooms"></div>
    </section>
    <section style="grid-column:1/-1">
      <h2>最近消息</h2>
      <div id="messages"></div>
    </section>
    <section style="grid-column:1/-1">
      <h2>灵魂变更日志</h2>
      <div id="soulLog"></div>
    </section>
  </main>
  <footer>${footer}</footer>
  <script>
    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function speakerName(id) {
      if (id === 'human') return '你';
      if (id === 'system') return '系统';
      return id;
    }
    function bar(label, v) {
      const pct = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100);
      return '<div class="bar"><span>' + esc(label) + '</span><i><b style="width:' + pct + '%"></b></i><span>' + pct + '%</span></div>';
    }
    ${composeScript}
    async function tick() {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        const data = await res.json();
        document.getElementById('note').textContent = data.note || '';
        document.getElementById('stamp').textContent = '更新 ' + (data.generatedAt || '');
        document.getElementById('llmTotal').textContent = String(data.llmTotals?.today ?? 0);
        ${live ? 'fillRooms(data.rooms);' : ''}

        const agents = data.agents || [];
        document.getElementById('agents').innerHTML = agents.length ? agents.map((a) =>
          '<div class="agent"><strong>' + esc(a.displayName) + '</strong> <span class="meta">(' + esc(a.id) + ')</span>' +
          '<div class="meta">心情：' + esc(a.mood) + ' · LLM 今日：' + esc(a.llmCallsToday) +
          (a.interests?.length ? ' · 兴趣：' + esc(a.interests.join('、')) : '') + '</div>' +
          '<div class="bars">' + bar('开放', a.openness) + bar('信任', a.trust) + bar('精力', a.energy) + '</div>' +
          '<div class="meta">' + esc((a.persona || '').slice(0, 120)) + '</div></div>'
        ).join('') : '<div class="meta">暂无 Agent（先跑 smoke / society-live）</div>';

        const rooms = data.rooms || [];
        document.getElementById('rooms').innerHTML = rooms.length ? rooms.map((r) =>
          '<div class="msg"><span class="from">' + esc(r.name) + '</span> <code>' + esc(r.id.slice(0, 8)) + '…</code>' +
          '<div class="meta">成员：' + esc((r.members || []).join(', ')) + '</div></div>'
        ).join('') : '<div class="meta">尚无持久化房间</div>';

        const msgs = data.recentMessages || [];
        document.getElementById('messages').innerHTML = msgs.length ? msgs.slice().reverse().map((m) =>
          '<div class="msg"><span class="from' + (m.from === 'human' ? ' human' : '') + '">' + esc(speakerName(m.from)) + '</span> @ ' +
          esc(m.roomName || m.roomId.slice(0, 8)) +
          ' <span class="meta">' + esc(m.createdAt) + '</span><div>' + esc(m.body) + '</div></div>'
        ).join('') : '<div class="meta">暂无消息</div>';

        const logs = data.recentSoulLog || [];
        document.getElementById('soulLog').innerHTML = logs.length ? logs.slice().reverse().map((l) =>
          '<div class="log"><span class="from">' + esc(l.agentId) + '</span> ' + esc(l.reason) +
          (l.mood ? ' · 心情 ' + esc(l.mood) : '') +
          ' <span class="meta">' + esc(l.ts) + '</span></div>'
        ).join('') : '<div class="meta">暂无 soul-log</div>';
      } catch (e) {
        document.getElementById('note').textContent = '拉取失败：' + e;
      }
    }
    tick();
    setInterval(tick, 1500);
  </script>
</body>
</html>`
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

function isLocalhost(req: http.IncomingMessage): boolean {
  const ra = req.socket.remoteAddress || ''
  return (
    ra === '127.0.0.1' ||
    ra === '::1' ||
    ra === '::ffff:127.0.0.1' ||
    ra.endsWith('127.0.0.1')
  )
}

/** When SOCIETY_OBSERVE_ALLOW_REMOTE_SAY=1 (Docker published ports), allow /api/say from non-loopback. */
function allowSay(req: http.IncomingMessage): boolean {
  const flag = (process.env.SOCIETY_OBSERVE_ALLOW_REMOTE_SAY || '').trim()
  if (flag === '1' || /^true$/i.test(flag) || /^yes$/i.test(flag)) return true
  return isLocalhost(req)
}

function readBody(req: http.IncomingMessage, limit = 16_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createObserveServer(opts: ObserveServerOptions): ObserveServer {
  const host = opts.host || process.env.SOCIETY_OBSERVE_HOST?.trim() || '127.0.0.1'
  const port = opts.port ?? (Number(process.env.SOCIETY_OBSERVE_PORT?.trim() || '8787') || 8787)
  const html = buildHtml(opts.mode)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`)
    const pathname = url.pathname

    if (isForbiddenObservePath(pathname) || pathname.includes('..')) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(html)
      return
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      try {
        const state = readObserveState()
        if (opts.mode === 'live' && opts.liveNote) {
          state.note = opts.liveNote()
        } else if (opts.mode === 'live') {
          state.note =
            '直播模式：同一进程跑心跳。在下方发言后，Agent 会在后续 tick 回复。本接口不暴露 .env / API 密钥。'
        }
        sendJson(res, 200, state)
      } catch (err) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, mode: opts.mode })
      return
    }

    if (req.method === 'POST' && pathname === '/api/say') {
      if (opts.mode !== 'live' || !opts.onSay) {
        sendJson(res, 404, { error: 'say only available in society-live' })
        return
      }
      if (!allowSay(req)) {
        sendJson(res, 403, { error: 'localhost only (set SOCIETY_OBSERVE_ALLOW_REMOTE_SAY=1 in Docker)' })
        return
      }
      try {
        const raw = await readBody(req)
        let parsed: SayRequest
        try {
          parsed = JSON.parse(raw || '{}') as SayRequest
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const text = String(parsed.text || '').trim()
        if (!text) {
          sendJson(res, 400, { error: 'text required' })
          return
        }
        const as = parsed.as || 'human'
        if (as !== 'human' && as !== HUMAN_SPEAKER_ID) {
          sendJson(res, 400, { error: 'as must be human' })
          return
        }
        const result = await opts.onSay({
          roomId: parsed.roomId,
          roomName: parsed.roomName,
          text,
          as: 'human',
        })
        sendJson(res, 200, {
          ok: true,
          roomId: result.roomId,
          roomName: result.roomName,
          message: {
            id: result.message.id,
            roomId: result.message.roomId,
            from: speakerLabel(result.message.from),
            fromId: result.message.from,
            body: result.message.body,
            createdAt: result.message.createdAt,
          },
        })
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    sendJson(res, 404, { error: 'not found' })
  })

  return {
    server,
    host,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

export function listenObserveServer(srv: ObserveServer): Promise<void> {
  return new Promise((resolve, reject) => {
    srv.server.once('error', reject)
    srv.server.listen(srv.port, srv.host, () => resolve())
  })
}
