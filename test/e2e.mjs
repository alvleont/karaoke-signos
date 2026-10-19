// Prueba de punta a punta contra `wrangler dev` (no corre en CI). Uso: node test/e2e.mjs [baseURL]
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const WSB = BASE.replace(/^http/, 'ws');
const assert = (c, m) => { if (!c) { console.error('✗', m); process.exit(1); } console.log('✓', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sock(role, { cookie, token } = {}) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WSB}/ws?role=${role}${token ? '&s=' + token : ''}`, { headers: cookie ? { Cookie: cookie } : {} });
    const c = { ws, last: null, kicked: false, n: 0, pend: new Map() };
    ws.onmessage = e => { if (e.data === 'pong') return; const m = JSON.parse(e.data); if (m.t === 'state') c.last = m.view; if (m.t === 'kicked') c.kicked = true; if (m.ref) c.pend.get(m.ref)?.(m); };
    c.send = (t, d = {}) => new Promise(r => { const ref = 'r' + (++c.n); c.pend.set(ref, r); ws.send(JSON.stringify({ t, ref, ...d })); });
    ws.onopen = () => res(c); ws.onerror = () => rej(new Error('ws error ' + role));
  });
}

// 1. login
let r = await fetch(BASE + '/api/login', { method: 'POST', body: JSON.stringify({ user: 'admin', pass: 'mala' }) });
assert(r.status === 401, 'contraseña incorrecta rechazada');
r = await fetch(BASE + '/api/login', { method: 'POST', body: JSON.stringify({ user: 'admin', pass: 'prueba-local-123' }) });
assert(r.ok, 'login admin correcto');
const cookie = r.headers.get('set-cookie').split(';')[0];
assert(/HttpOnly/i.test(r.headers.get('set-cookie')), 'cookie HttpOnly');

// 2. TV/admin sin cookie bloqueados
let blocked = false; try { await sock('tv'); } catch { blocked = true; }
assert(blocked, 'TV sin sesión de admin bloqueada');

const admin = await sock('admin', { cookie });
const tv = await sock('tv', { cookie });
await sleep(150);
if (admin.last.open) await admin.send('close_night');
let a = await admin.send('open_night'); assert(a.t === 'ok', 'noche abierta');
await sleep(100);
const code = admin.last.code;
assert(/^[A-Z0-9]{4}$/.test(code), 'código generado ' + code);
assert(tv.last.code === code, 'la TV recibe el código');

// 3. clientes
const c1 = await sock('client'); await sleep(100);
assert(c1.last.code === undefined && !JSON.stringify(c1.last).includes(code), 'el cliente anónimo no recibe el código');
let j = await c1.send('join', { code: 'XXXX', name: 'Ana', table: 4 }); assert(j.t === 'err', 'código incorrecto rechazado: ' + j.msg);
j = await c1.send('join', { code, name: 'Ana', table: 4 }); assert(j.t === 'ok' && j.token, 'Ana entra a la mesa 4');
const c2 = await sock('client'); j = await c2.send('join', { code: code.toLowerCase(), name: '<b>Beto</b>', table: 2 }); assert(j.t === 'ok', 'Beto entra a la mesa 2');
const c3 = await sock('client'); j = await c3.send('join', { code, name: 'Caro', table: 7 }); assert(j.t === 'ok', 'Caro entra a la mesa 7');

assert((await c1.send('request', { title: 'Amor eterno', artist: 'Rocío Dúrcal' })).t === 'ok', 'Ana pide canción');
assert((await c2.send('request', { title: 'amor ETERNO', artist: 'rocio durcal' })).t === 'err', 'duplicado bloqueado');
assert((await c2.send('request', { title: 'De música ligera', artist: 'Soda Stereo' })).t === 'ok', 'Beto pide canción');
assert((await c3.send('request', { url: 'https://youtu.be/dQw4w9WgXcQ' })).t === 'ok', 'Caro pide con link');
assert((await c1.send('request', { title: 'Ciega sordomuda', artist: 'Shakira' })).t === 'ok', 'Ana pide segunda');
assert((await c1.send('request', { title: 'Tercera', artist: 'X' })).t === 'err', 'límite de canciones en espera');
await sleep(150);
assert(admin.last.queue.map(s => s.name).join(',') === 'Ana,<b>Beto</b>,Caro,Ana', 'orden por rondas: ' + admin.last.queue.map(s => s.name).join(','));
assert(c1.last.myTable.length === 2 && c1.last.tableTurn === 0, 'Ana ve las canciones de su mesa y que sigue');

// 4. cantar y votar
assert((await admin.send('start')).t === 'ok', 'empieza Ana');
await sleep(100);
assert(tv.last.current?.name === 'Ana', 'la TV muestra a Ana');
assert((await c1.send('vote', { v: 5 })).t === 'err', 'la mesa que canta no vota');
assert((await c2.send('vote', { v: 5 })).t === 'ok', 'Beto vota');
const c2b = await sock('client'); await c2b.send('join', { code, name: 'Beto2', table: 2 });
assert((await c2b.send('vote', { v: 4 })).t === 'err', 'segunda persona de la misma mesa no vota');
await c3.send('vote', { v: 5 });
await sleep(100);
assert(!JSON.stringify(c2.last).match(/"avg"|stats/), 'el cliente no ve puntajes');
assert(admin.last.current.stats.count === 2, 'el admin ve 2 votos');

// 5. TV termina la canción
const curId = tv.last.current.id;
assert((await tv.send('ended', { id: 'viejo' })).t === 'ok', 'evento viejo ignorado'); await sleep(80);
assert(admin.last.current?.id === curId, 'sigue cantando tras evento viejo');
await tv.send('ended', { id: curId }); await sleep(100);
assert(admin.last.current === null && tv.last.next?.name === '<b>Beto</b>', 'pausa con QR; sigue Beto');

// 6. reconexión con token
const tok1 = j.token;
const back = await sock('client', { token: (await c1.send('join', { code, name: 'Ana', table: 4 })).token }); await sleep(100);
assert(back.last.me?.name === 'Ana', 'reconexión con sesión guardada');

// 7. cerrar mesa expulsa
await admin.send('table_off', { n: 7 }); await sleep(150);
assert(c3.kicked && c3.last.me === null, 'Caro sale al cerrar la mesa 7');
assert((await c3.send('request', { title: 'x', artist: 'y' })).t === 'err', 'Caro ya no puede pedir');

// 8. cliente no puede acciones de admin
assert((await c1.send('open_night')).t === 'err', 'cliente no puede abrir/cerrar la noche');
assert((await c1.send('start')).t === 'err', 'cliente no puede iniciar canciones');

// 9. cerrar noche
await admin.send('close_night'); await sleep(150);
assert(!admin.last.open && c1.last.me === null, 'noche cerrada y clientes fuera');
for (const s of [admin, tv, c1, c2, c3, c2b, back]) s.ws.close();
console.log('\nTodo OK');
process.exit(0);
