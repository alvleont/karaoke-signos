// Reglas del karaoke. Funciones puras sobre el estado: sin red ni almacenamiento,
// para poder probarlas con Vitest y ejecutarlas dentro del Durable Object.

export type SongStatus = 'pending' | 'singing' | 'done' | 'skipped' | 'rejected' | 'cancelled';

export interface Table { n: number; active: boolean }
export interface User { id: string; name: string; table: number; bonus: boolean; gone: boolean; byAdmin?: boolean; createdAt: number }
export interface Song {
  id: string; userId: string; table: number; artist: string; title: string; url: string | null;
  status: SongStatus; priority: boolean; createdAt: number; startedAt?: number; endedAt?: number; videoError?: boolean;
}
export interface Vote { v: number; userId: string | null }
export interface Alert { id: string; songId: string; userId: string }
export interface Settings { phase1: boolean; minVotes: number; minAvg: number; maxPendingPerUser: number; tableCount: number }
export interface Night { id: string; code: string; openedAt: number }

export interface State {
  v: 1;
  night: Night | null;
  tables: Table[];
  rotation: number[];
  users: User[];
  songs: Song[];
  votes: Record<string, Record<string, Vote>>;
  alerts: Alert[];
  alerted: string[];
  currentId: string | null;
  filler?: { vid: string; title: string } | null; // música de fondo cuando nadie canta
  lastTable: number | null;
  settings: Settings;
  seq: number;
}

export class UserError extends Error {}

export const LIMITS = { name: 24, title: 80, artist: 60, url: 200, maxTables: 40 };
const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';

export function newState(tableCount = 15): State {
  return {
    v: 1, night: null, tables: makeTables(tableCount), rotation: [], users: [], songs: [], votes: {},
    alerts: [], alerted: [], currentId: null, lastTable: null,
    settings: { phase1: true, minVotes: 3, minAvg: 4.5, maxPendingPerUser: 2, tableCount }, seq: 1,
  };
}
function makeTables(n: number): Table[] { return Array.from({ length: n }, (_, i) => ({ n: i + 1, active: false })); }

const nid = (s: State, p: string) => p + (s.seq++).toString(36);
export const T = (s: State, n: number) => s.tables.find(t => t.n === n);
export const U = (s: State, id: string) => s.users.find(u => u.id === id);
export const SG = (s: State, id: string) => s.songs.find(x => x.id === id);

export function genCode(rand: (n: number) => number): string {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return c;
}

export function norm(x: string): string {
  return String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
export function ytId(u: string | null | undefined): string | null {
  const m = String(u || '').match(/(?:youtu\.be\/|[?&]v=|shorts\/|embed\/|live\/)([\w-]{11})(?![\w-])/);
  return m ? m[1] : null;
}
function clean(x: unknown, max: number): string {
  return String(x ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------- Noche ----------
export function openNight(s: State, code: string, nightId: string, now: number) {
  if (s.night) throw new UserError('La noche ya está abierta.');
  wipe(s);
  s.night = { id: nightId, code, openedAt: now };
}
export function closeNight(s: State) { wipe(s); s.night = null; }
function wipe(s: State) {
  s.tables = makeTables(s.settings.tableCount);
  s.rotation = []; s.users = []; s.songs = []; s.votes = {}; s.alerts = []; s.alerted = [];
  s.currentId = null; s.lastTable = null; s.filler = null;
}
export function rotateCode(s: State, code: string) {
  if (!s.night) throw new UserError('Primero abre la noche.');
  s.night.code = code;
}
export function setTableCount(s: State, n: number) {
  const count = Math.max(1, Math.min(LIMITS.maxTables, Math.floor(n)));
  if (s.tables.some(t => t.active && t.n > count)) throw new UserError('Hay mesas activas por encima de ese número. Ciérralas primero.');
  s.settings.tableCount = count;
  s.tables = Array.from({ length: count }, (_, i) => T(s, i + 1) ?? { n: i + 1, active: false });
}

// ---------- Mesas y personas ----------
export function activateTable(s: State, n: number) {
  const t = T(s, n);
  if (!t) throw new UserError('Esa mesa no existe.');
  t.active = true;
  if (!s.rotation.includes(n)) s.rotation.push(n);
}
export function closeTable(s: State, n: number): string[] {
  const t = T(s, n);
  if (!t) throw new UserError('Esa mesa no existe.');
  t.active = false;
  s.rotation = s.rotation.filter(x => x !== n);
  s.songs.forEach(x => { if (x.table === n && x.status === 'pending') x.status = 'cancelled'; });
  const kicked: string[] = [];
  s.users.forEach(u => { if (u.table === n && !u.gone) { u.gone = true; kicked.push(u.id); } });
  return kicked;
}
export function join(s: State, p: { code: unknown; name: unknown; table: unknown }, now: number): User {
  if (!s.night) throw new UserError('El karaoke todavía no ha abierto.');
  if (String(p.code ?? '').trim().toUpperCase() !== s.night.code) throw new UserError('Código incorrecto. Míralo en la pantalla del bar.');
  const name = clean(p.name, LIMITS.name);
  if (!name) throw new UserError('Escribe tu nombre.');
  const table = Number(p.table);
  if (!T(s, table)) throw new UserError('Elige una mesa válida.');
  activateTable(s, table);
  const u: User = { id: nid(s, 'u'), name, table, bonus: false, gone: false, createdAt: now };
  s.users.push(u);
  return u;
}
function activeUser(s: State, userId: string): User {
  const u = U(s, userId);
  if (!u || u.gone) throw new UserError('Tu sesión terminó. Vuelve a entrar.');
  if (!T(s, u.table)?.active) throw new UserError('Tu mesa está cerrada.');
  return u;
}

// ---------- Canciones ----------
export function dupCheck(s: State, artist: string, title: string, url: string | null): { block?: Song; warn?: Song } {
  const live = s.songs.filter(x => x.status === 'pending' || x.status === 'singing' || x.status === 'done');
  const vid = ytId(url);
  if (vid) { const d = live.find(x => ytId(x.url) === vid); if (d) return { block: d }; }
  const tt = norm(title);
  if (!tt) return {};
  const same = live.find(x => norm(x.title) === tt && (!artist || !x.artist || norm(x.artist) === norm(artist)));
  if (same && artist) return { block: same };
  return same ? { warn: same } : {};
}
function makeSong(s: State, u: User, p: { artist?: unknown; title?: unknown; url?: unknown }, now: number): Song {
  const artist = clean(p.artist, LIMITS.artist);
  const title = clean(p.title, LIMITS.title);
  const rawUrl = clean(p.url, LIMITS.url);
  const vid = ytId(rawUrl);
  if (rawUrl && !vid) throw new UserError('Ese link no es de un video de YouTube.');
  if (!title && !vid) throw new UserError('Escribe el nombre de la canción.');
  const d = dupCheck(s, artist, title, vid ? rawUrl : null);
  if (d.block) throw new UserError(`"${d.block.title || 'Ese video'}" ya ${d.block.status === 'done' ? 'sonó esta noche' : 'está en la cola'}. Elige otra.`);
  const song: Song = {
    id: nid(s, 's'), userId: u.id, table: u.table, artist, title,
    url: vid ? `https://www.youtube.com/watch?v=${vid}` : null,
    status: 'pending', priority: false, createdAt: now,
  };
  if (u.bonus) { song.priority = true; u.bonus = false; }
  s.songs.push(song);
  return song;
}
export function requestSong(s: State, userId: string, p: { artist?: unknown; title?: unknown; url?: unknown }, now: number): Song {
  const u = activeUser(s, userId);
  const pending = s.songs.filter(x => x.userId === u.id && x.status === 'pending').length;
  if (pending >= s.settings.maxPendingPerUser) throw new UserError(`Puedes tener máximo ${s.settings.maxPendingPerUser} canciones en espera. Cuando cantes una, pides otra.`);
  return makeSong(s, u, p, now);
}
export function adminAddSong(s: State, p: { table: unknown; name: unknown; artist?: unknown; title?: unknown; url?: unknown }, now: number): Song {
  const table = Number(p.table);
  if (!T(s, table)) throw new UserError('Esa mesa no existe.');
  const name = clean(p.name, LIMITS.name);
  if (!name) throw new UserError('Escribe el nombre de quien canta.');
  activateTable(s, table);
  let u = s.users.find(x => x.table === table && !x.gone && norm(x.name) === norm(name));
  if (!u) { u = { id: nid(s, 'u'), name, table, bonus: false, gone: false, byAdmin: true, createdAt: now }; s.users.push(u); }
  return makeSong(s, u, p, now);
}
export function setVideo(s: State, songId: string, url: unknown) {
  const song = SG(s, songId);
  if (!song) throw new UserError('Esa canción ya no está.');
  const vid = ytId(clean(url, LIMITS.url));
  if (!vid) throw new UserError('Ese enlace no es de un video de YouTube.');
  song.url = `https://www.youtube.com/watch?v=${vid}`;
  song.videoError = false;
}
export function markVideoError(s: State, songId: string) { const x = SG(s, songId); if (x) x.videoError = true; }
export function prioritizeSong(s: State, songId: string) {
  const x = SG(s, songId);
  if (!x || x.status !== 'pending') throw new UserError('Esa canción ya no está en la cola.');
  x.priority = true;
}
export function rejectSong(s: State, songId: string) {
  const x = SG(s, songId);
  if (!x || x.status !== 'pending') throw new UserError('Esa canción ya no está en la cola.');
  x.status = 'rejected';
}

// ---------- Cola por rondas ----------
export interface QItem { song: Song; round: number }
export function queue(s: State): QItem[] {
  const pend = s.songs.filter(x => x.status === 'pending' && T(s, x.table)?.active).sort((a, b) => a.createdAt - b.createdAt);
  const out: QItem[] = pend.filter(x => x.priority).map(song => ({ song, round: 0 }));
  const groups = new Map<number, Song[]>();
  pend.filter(x => !x.priority).forEach(x => { if (!groups.has(x.table)) groups.set(x.table, []); groups.get(x.table)!.push(x); });
  const rot = s.rotation.filter(n => T(s, n)?.active);
  const i = s.lastTable == null ? -1 : rot.indexOf(s.lastTable);
  const order = i < 0 ? rot : rot.slice(i + 1).concat(rot.slice(0, i + 1));
  for (let round = 1, any = true; any; round++) {
    any = false;
    for (const n of order) { const g = groups.get(n); if (g && g.length) { out.push({ song: g.shift()!, round }); any = true; } }
  }
  return out;
}
export function finish(s: State, skip: boolean, now: number, songId?: string) {
  const cur = s.currentId ? SG(s, s.currentId) : undefined;
  if (!cur) return false;
  if (songId && cur.id !== songId) return false; // evento viejo de la TV
  cur.status = skip ? 'skipped' : 'done';
  cur.endedAt = now;
  s.currentId = null;
  return true;
}
export function start(s: State, now: number): Song {
  if (s.currentId) throw new UserError('Alguien está cantando. Primero marca que terminó.');
  const q = queue(s);
  if (!q.length) throw new UserError('La cola está vacía.');
  const n = q[0].song;
  n.status = 'singing'; n.startedAt = now;
  s.filler = null;
  s.currentId = n.id;
  if (!n.priority) s.lastTable = n.table;
  return n;
}

// La persona que sigue no está: su canción se marca como saltada y su mesa pierde el turno de esta ronda.
export function skipNext(s: State, now: number): Song {
  if (s.currentId) throw new UserError('Alguien está cantando. Usa "Saltar" sobre la canción actual.');
  const q = queue(s);
  if (!q.length) throw new UserError('La cola está vacía.');
  const n = q[0].song;
  n.status = 'skipped'; n.endedAt = now;
  if (!n.priority) s.lastTable = n.table;
  return n;
}

// Música de fondo: el admin pone un video mientras nadie canta; el QR y el código siguen en pantalla.
export function setFiller(s: State, url: unknown) {
  if (!s.night) throw new UserError('Primero abre la noche.');
  if (s.currentId) throw new UserError('Alguien está cantando. Espera a que termine.');
  const vid = ytId(clean(url, LIMITS.url));
  if (!vid) throw new UserError('Ese enlace no es de un video de YouTube.');
  s.filler = { vid, title: '' };
}
export function clearFiller(s: State, vid?: string) {
  if (!s.filler) return false;
  if (vid && s.filler.vid !== vid) return false;
  s.filler = null;
  return true;
}

// ---------- Votos ----------
export function stats(s: State, songId: string) {
  const v = Object.values(s.votes[songId] || {}).map(x => x.v);
  return { count: v.length, avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0 };
}
export function vote(s: State, userId: string, value: unknown): { alert?: Alert } {
  const u = activeUser(s, userId);
  const cur = s.currentId ? SG(s, s.currentId) : undefined;
  if (!cur) throw new UserError('Nadie está cantando ahora.');
  if (cur.table === u.table) throw new UserError('Tu mesa no puede votar por sí misma.');
  const v = Math.round(Number(value));
  if (!(v >= 1 && v <= 5)) throw new UserError('El voto va de 1 a 5 estrellas.');
  const box = (s.votes[cur.id] ||= {});
  if (box[u.table]) throw new UserError('Tu mesa ya votó por esta canción.');
  box[u.table] = { v, userId: u.id };
  const st = stats(s, cur.id);
  if (st.count >= s.settings.minVotes && st.avg >= s.settings.minAvg && !s.alerted.includes(cur.id)) {
    s.alerted.push(cur.id);
    const alert = { id: nid(s, 'a'), songId: cur.id, userId: cur.userId };
    s.alerts.push(alert);
    return { alert };
  }
  return {};
}
export function resolveAlert(s: State, alertId: string, accept: boolean): string | null {
  const a = s.alerts.find(x => x.id === alertId);
  if (!a) return null;
  s.alerts = s.alerts.filter(x => x !== a);
  if (!accept) return null;
  const nxt = s.songs.filter(x => x.userId === a.userId && x.status === 'pending').sort((x, y) => x.createdAt - y.createdAt)[0];
  if (nxt) { nxt.priority = true; return 'Su próxima canción pasa al frente.'; }
  const u = U(s, a.userId);
  if (u) u.bonus = true;
  return 'Su próximo pedido entrará primero.';
}

export function updateSettings(s: State, p: Partial<Settings>) {
  if (p.phase1 !== undefined) s.settings.phase1 = !!p.phase1;
  if (p.minVotes !== undefined) s.settings.minVotes = Math.max(1, Math.min(40, Math.floor(Number(p.minVotes)) || 3));
  if (p.minAvg !== undefined) s.settings.minAvg = Math.max(1, Math.min(5, Number(p.minAvg) || 4.5));
  if (p.maxPendingPerUser !== undefined) s.settings.maxPendingPerUser = Math.max(1, Math.min(10, Math.floor(Number(p.maxPendingPerUser)) || 2));
  if (p.tableCount !== undefined) setTableCount(s, Number(p.tableCount));
}

// ---------- Vistas (lo que recibe cada pantalla) ----------
function pub(s: State, x: Song, round?: number) {
  return { id: x.id, table: x.table, name: U(s, x.userId)?.name ?? '', title: x.title, artist: x.artist, hasVideo: !!x.url, priority: x.priority, round };
}
function base(s: State) {
  const q = queue(s);
  const cur = s.currentId ? SG(s, s.currentId) : undefined;
  return {
    open: !!s.night,
    tableCount: s.settings.tableCount,
    phase1: s.settings.phase1,
    current: cur ? pub(s, cur) : null,
    queue: (s.settings.phase1 ? q.slice(0, 1) : q).map(i => pub(s, i.song, i.round)),
    taken: s.songs.filter(x => x.status === 'pending' || x.status === 'singing' || x.status === 'done')
      .map(x => ({ title: x.title, artist: x.artist, vid: ytId(x.url), status: x.status })),
    done: s.songs.filter(x => x.status === 'done' && x.title).map(x => ({ title: x.title, artist: x.artist })),
  };
}
export function clientView(s: State, userId: string) {
  const b = base(s);
  const u = U(s, userId);
  if (!u || u.gone) return { ...b, me: null };
  const q = queue(s);
  const cur = s.currentId ? SG(s, s.currentId) : undefined;
  const tv = cur ? s.votes[cur.id]?.[u.table] : undefined;
  const mine = s.songs.filter(x => x.table === u.table && (x.status === 'pending' || x.status === 'singing'))
    .map(x => ({ ...pub(s, x), mine: x.userId === u.id, status: x.status, pos: q.findIndex(i => i.song.id === x.id) }))
    .sort((a, b2) => (a.status === 'singing' ? -1 : a.pos) - (b2.status === 'singing' ? -1 : b2.pos));
  return {
    ...b,
    me: { id: u.id, name: u.name, table: u.table, bonus: u.bonus },
    tableTurn: cur && cur.table === u.table ? -1 : q.findIndex(i => i.song.table === u.table),
    myTable: mine,
    vote: cur ? { canVote: cur.table !== u.table && !tv, voted: !!tv, byMe: tv?.userId === u.id, byName: tv?.userId ? U(s, tv.userId)?.name ?? '' : '' } : null,
    pendingCount: s.songs.filter(x => x.userId === u.id && x.status === 'pending').length,
    maxPending: s.settings.maxPendingPerUser,
  };
}
export function tvView(s: State) {
  const b = base(s);
  const q = queue(s);
  const cur = s.currentId ? SG(s, s.currentId) : undefined;
  return { ...b, next: q[0] ? pub(s, q[0].song) : null, code: s.night?.code ?? null, currentVideo: cur ? ytId(cur.url) : null, filler: !cur && s.filler ? s.filler : null };
}
export function adminView(s: State) {
  const q = queue(s);
  const cur = s.currentId ? SG(s, s.currentId) : undefined;
  const full = (x: Song, round?: number) => ({ ...pub(s, x, round), url: x.url, videoError: !!x.videoError, createdAt: x.createdAt, status: x.status, stats: stats(s, x.id) });
  return {
    open: !!s.night, code: s.night?.code ?? null, settings: s.settings, filler: s.filler ?? null,
    current: cur ? full(cur) : null,
    queue: q.map(i => full(i.song, i.round)),
    tables: s.tables.map(t => ({ n: t.n, active: t.active, people: s.users.filter(u => u.table === t.n && !u.gone).map(u => u.name), pos: s.rotation.filter(n => T(s, n)?.active).indexOf(t.n) })),
    history: s.songs.filter(x => x.status === 'done' || x.status === 'skipped').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).map(x => full(x)),
    alerts: s.alerts.map(a => { const x = SG(s, a.songId)!; const u = U(s, a.userId); return { id: a.id, name: u?.name ?? '', table: u?.table ?? 0, title: x?.title ?? '', stats: stats(s, a.songId) }; }),
    people: s.users.filter(u => !u.gone).length,
  };
}
