// Durable Object "Room": única fuente de verdad de la noche. Serializa todas las acciones,
// guarda el estado en su SQLite y reparte vistas por WebSocket (con hibernación).
import { DurableObject } from 'cloudflare:workers';
import * as L from './logic';
import { adminToken, clientToken, getCookie, readAdminToken, readClientToken, verifyPassword } from './auth';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  ADMIN_USER: string;
  ADMIN_PASS_HASH: string;
  SESSION_SECRET: string;
}
type Role = 'client' | 'admin' | 'tv';
interface Att { role: Role; userId?: string }

const ADMIN_TTL = 14 * 3600e3;
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60e3;

const rand = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export class Room extends DurableObject<Env> {
  s!: L.State;
  // Límite de mensajes por socket (se reinicia si el objeto hiberna; es una protección básica).
  rate = new WeakMap<WebSocket, { n: number; t: number }>();
  // Estado del reproductor que reporta la TV (solo en memoria; no hace falta guardarlo).
  player: { state: string; songId: string | null } = { state: 'idle', songId: null };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 'ping' -> 'pong' sin despertar al objeto (no consume cuota)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<L.State>('state')) ?? L.newState();
    });
  }

  async save() { await this.ctx.storage.put('state', this.s); }

  // ---------- HTTP ----------
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const now = Date.now();
    if (url.pathname === '/ws') return this.upgrade(req, url, now);
    if (url.pathname === '/api/login' && req.method === 'POST') return this.login(req, now);
    if (url.pathname === '/api/logout' && req.method === 'POST')
      return json({ ok: true }, 200, { 'set-cookie': 'adm=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
    if (url.pathname === '/api/session') return json({ admin: await this.isAdmin(req, now) });
    return json({ error: 'No encontrado' }, 404);
  }

  async isAdmin(req: Request, now: number) {
    return readAdminToken(this.env.SESSION_SECRET, getCookie(req, 'adm'), now);
  }

  async login(req: Request, now: number) {
    if (!sameOrigin(req)) return json({ error: 'Origen no permitido.' }, 403);
    const ip = req.headers.get('CF-Connecting-IP') || 'local';
    const key = `login:${ip}`;
    const rec = (await this.ctx.storage.get<{ fails: number; until: number }>(key)) ?? { fails: 0, until: 0 };
    if (rec.until > now) {
      const min = Math.ceil((rec.until - now) / 60e3);
      return json({ error: `Demasiados intentos. Espera ${min} min.` }, 429);
    }
    let body: { user?: string; pass?: string } = {};
    try { body = await req.json(); } catch { /* cuerpo inválido */ }
    const userOk = typeof body.user === 'string' && body.user.trim().toLowerCase() === (this.env.ADMIN_USER || '').toLowerCase();
    const passOk = typeof body.pass === 'string' && body.pass.length <= 200 && await verifyPassword(this.env.ADMIN_PASS_HASH, body.pass);
    if (!(userOk && passOk)) {
      rec.fails += 1;
      if (rec.fails >= MAX_FAILS) { rec.fails = 0; rec.until = now + LOCK_MS; }
      await this.ctx.storage.put(key, rec);
      return json({ error: 'Usuario o contraseña incorrectos.' }, 401);
    }
    await this.ctx.storage.delete(key);
    const tok = await adminToken(this.env.SESSION_SECRET, ADMIN_TTL, now);
    return json({ ok: true }, 200, { 'set-cookie': `adm=${tok}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_TTL / 1000}` });
  }

  async upgrade(req: Request, url: URL, now: number) {
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'Se esperaba WebSocket.' }, 426);
    if (!sameOrigin(req)) return json({ error: 'Origen no permitido.' }, 403);
    const role = url.searchParams.get('role') as Role;
    const att: Att = { role: 'client' };
    if (role === 'admin' || role === 'tv') {
      if (!(await this.isAdmin(req, now))) return json({ error: 'Inicia sesión como administrador.' }, 401);
      att.role = role;
    } else {
      const tok = await readClientToken(this.env.SESSION_SECRET, url.searchParams.get('s'));
      const u = tok && this.s.night && tok.nightId === this.s.night.id ? L.U(this.s, tok.userId) : undefined;
      if (u && !u.gone) att.userId = u.id;
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [att.role]);
    pair[1].serializeAttachment(att);
    pair[1].send(JSON.stringify({ t: 'hello', role: att.role, user: !!att.userId }));
    pair[1].send(this.viewFor(att));
    if (att.role === 'tv') this.sendAdmins({ t: 'tv', online: true });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---------- WebSocket ----------
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > 2000) return;
    const now = Date.now();
    const r = this.rate.get(ws) ?? { n: 0, t: now };
    if (now - r.t > 10e3) { r.n = 0; r.t = now; }
    r.n++; this.rate.set(ws, r);
    if (r.n > 30) { ws.send(JSON.stringify({ t: 'err', msg: 'Vas muy rápido. Espera unos segundos.' })); return; }

    let m: Record<string, any>;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ping') { ws.send('{"t":"pong"}'); return; }
    const att = ws.deserializeAttachment() as Att;
    const reply = (extra: object) => ws.send(JSON.stringify({ ref: m.ref, ...extra }));
    try {
      const out = await this.handle(ws, att, m, now);
      reply({ t: 'ok', ...(out || {}) });
    } catch (e) {
      if (e instanceof L.UserError) reply({ t: 'err', msg: e.message });
      else { console.error(e); reply({ t: 'err', msg: 'Algo falló. Intenta de nuevo.' }); }
    }
  }

  async handle(ws: WebSocket, att: Att, m: Record<string, any>, now: number): Promise<object | void> {
    const s = this.s;
    let changed = true;
    let result: object | void = undefined;
    let fetchTitleFor: string | null = null;

    if (att.role === 'client') {
      switch (m.t) {
        case 'join': {
          const u = L.join(s, { code: m.code, name: m.name, table: m.table }, now);
          att.userId = u.id; ws.serializeAttachment(att);
          result = { token: await clientToken(this.env.SESSION_SECRET, u.id, s.night!.id) };
          break;
        }
        case 'request': {
          if (!att.userId) throw new L.UserError('Primero entra con tu nombre y mesa.');
          const song = L.requestSong(s, att.userId, m, now);
          if (song.url && !song.title) fetchTitleFor = song.id;
          result = { priority: song.priority };
          break;
        }
        case 'vote':
          if (!att.userId) throw new L.UserError('Primero entra con tu nombre y mesa.');
          L.vote(s, att.userId, m.v);
          break;
        case 'leave':
          att.userId = undefined; ws.serializeAttachment(att); changed = false;
          ws.send(this.viewFor(att));
          return;
        default: throw new L.UserError('Acción no permitida.');
      }
    } else if (att.role === 'tv') {
      switch (m.t) {
        case 'ended': changed = L.finish(s, false, now, String(m.id)); break;
        case 'video_error': L.markVideoError(s, String(m.id)); break;
        case 'player_state': {
          const st = String(m.state);
          if (!['playing', 'paused', 'buffering', 'ended', 'idle'].includes(st)) throw new L.UserError('Estado inválido.');
          this.player = { state: st, songId: m.id ? String(m.id) : null };
          this.sendAdmins({ t: 'player', ...this.player });
          return;
        }
        default: throw new L.UserError('Acción no permitida.');
      }
    } else {
      switch (m.t) {
        case 'open_night': L.openNight(s, L.genCode(rand), crypto.randomUUID(), now); break;
        case 'close_night': L.closeNight(s); break;
        case 'rotate_code': L.rotateCode(s, L.genCode(rand)); break;
        case 'start': L.start(s, now); break;
        case 'finish': L.finish(s, false, now); break;
        case 'skip': L.finish(s, true, now); break;
        case 'skip_next': L.skipNext(s, now); break;
        case 'prio': L.prioritizeSong(s, String(m.id)); break;
        case 'reject': L.rejectSong(s, String(m.id)); break;
        case 'set_video': L.setVideo(s, String(m.id), m.url); fetchTitleFor = String(m.id); break;
        case 'add_song': { const song = L.adminAddSong(s, { table: m.table, name: m.name, artist: m.artist, title: m.title, url: m.url }, now); if (song.url && !song.title) fetchTitleFor = song.id; break; }
        case 'table_on': L.activateTable(s, Number(m.n)); break;
        case 'table_off': L.closeTable(s, Number(m.n)); break;
        case 'alert': result = { msg: L.resolveAlert(s, String(m.id), !!m.accept) }; break;
        case 'settings': L.updateSettings(s, m.settings || {}); break;
        case 'player': {
          const cmd = String(m.cmd);
          if (!['play', 'pause', 'restart'].includes(cmd)) throw new L.UserError('Orden inválida.');
          const tvs = this.ctx.getWebSockets('tv');
          if (!tvs.length) throw new L.UserError('La pantalla TV no está conectada. Ábrela desde el botón "Abrir pantalla TV".');
          for (const t of tvs) { try { t.send(JSON.stringify({ t: 'cmd', cmd })); } catch { /* cerrado */ } }
          return;
        }
        default: throw new L.UserError('Acción no permitida.');
      }
    }
    if (changed) { await this.save(); this.broadcast(); }
    if (fetchTitleFor) this.ctx.waitUntil(this.fillTitle(fetchTitleFor));
    return result;
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code, 'bye'); } catch { /* ya cerrado */ }
    const att = ws.deserializeAttachment() as Att;
    if (att?.role === 'tv') this.sendAdmins({ t: 'tv', online: this.ctx.getWebSockets('tv').some(w => w !== ws && w.readyState === 1) });
  }
  async webSocketError() { /* el cliente reconecta solo */ }

  // Título del video vía oEmbed público de YouTube (sin clave).
  async fillTitle(songId: string) {
    const song = L.SG(this.s, songId);
    const vid = L.ytId(song?.url);
    if (!song || !vid) return;
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) { if (r.status === 401 || r.status === 403 || r.status === 404) { song.videoError = true; await this.save(); this.broadcast(); } return; }
      const d = await r.json<{ title?: string; author_name?: string }>();
      const fresh = L.SG(this.s, songId);
      if (!fresh) return;
      if (!fresh.title && d.title) fresh.title = String(d.title).slice(0, L.LIMITS.title);
      // author_name es el canal de YouTube, no el artista: no se usa.
      await this.save(); this.broadcast();
    } catch { /* sin título: se queda como "Video de YouTube" */ }
  }

  viewFor(att: Att): string {
    if (att.role === 'admin') return JSON.stringify({ t: 'state', view: { ...L.adminView(this.s), tvOnline: this.ctx.getWebSockets('tv').length > 0, player: this.player } });
    if (att.role === 'tv') return JSON.stringify({ t: 'state', view: L.tvView(this.s) });
    return JSON.stringify({ t: 'state', view: att.userId ? L.clientView(this.s, att.userId) : L.clientView(this.s, '') });
  }

  sendAdmins(msg: object) {
    const txt = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets('admin')) { try { ws.send(txt); } catch { /* cerrado */ } }
  }

  broadcast() {
    let admin: string | null = null, tv: string | null = null, anon: string | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Att;
      try {
        if (att.role === 'admin') ws.send(admin ??= this.viewFor(att));
        else if (att.role === 'tv') ws.send(tv ??= this.viewFor(att));
        else if (!att.userId) ws.send(anon ??= this.viewFor(att));
        else {
          const u = L.U(this.s, att.userId);
          if (!u || u.gone) { att.userId = undefined; ws.serializeAttachment(att); ws.send('{"t":"kicked"}'); ws.send(anon ??= this.viewFor(att)); }
          else ws.send(this.viewFor(att));
        }
      } catch { /* socket cerrado */ }
    }
  }
}

function sameOrigin(req: Request) {
  const o = req.headers.get('Origin');
  if (!o) return true; // clientes sin navegador (pruebas); las cookies SameSite=Strict cubren el resto
  try { return new URL(o).host === new URL(req.url).host; } catch { return false; }
}
