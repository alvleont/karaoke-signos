import { $, esc, norm, ytId, songHTML, toast, connect } from './common.js';

const KEY = 'ks_token';
const store = {
  get() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} },
};

// Código desde el QR (?n=XXXX): se usa una vez y se quita de la URL.
const qs = new URLSearchParams(location.search);
if (qs.get('n')) { $('j-code').value = qs.get('n').slice(0, 4).toUpperCase(); history.replaceState(null, '', '/'); }

let V = null, pick = null, kicked = false;
const conn = connect('client', {
  getToken: () => store.get(),
  onState: v => { V = v; if (!v.me && store.get()) store.set(''); render(); },
  onKicked: () => { store.set(''); kicked = true; },
});

function render() {
  if (!V) return;
  const me = V.me;
  $('join').hidden = !!me; $('home').hidden = !me;
  if (!me) { $('sheet').hidden = true; renderJoin(); return; }
  kicked = false;
  $('head').innerHTML = `<div><div style="font-weight:800;font-size:18px">Hola, ${esc(me.name)}</div><span class="mesa">Mesa ${me.table}</span></div><button class="btn sm ghost" id="leave">Salir</button>`;

  const cur = V.current, nx = V.queue[0];
  const t = V.tableTurn;
  $('turn').innerHTML =
    t === -1 ? `<div class="turn"><b>🎤</b><span>¡Está cantando tu mesa!</span></div>`
    : t === 0 ? `<div class="turn"><b>¡Ya!</b><span>Tu mesa sigue. Prepárense.</span></div>`
    : t > 0 ? `<div class="turn"><b class="num">${t}</b><span>${t === 1 ? 'canción' : 'canciones'} antes de tu mesa</span></div>`
    : `<div class="turn quiet">Tu mesa no tiene canciones en la cola.</div>`;

  let h = '';
  if (cur) {
    const v = V.vote;
    const voteUI = cur.table === me.table ? '<span class="muted" style="font-size:14px">Es tu mesa. ¡A hacer barra! 👏</span>'
      : v && v.voted ? `<span class="pill y" style="align-self:flex-start">✓ ${v.byMe ? 'Gracias, tu mesa ya votó' : 'Tu mesa ya votó (' + esc(v.byName || 'otra persona') + ')'}</span>`
      : `<div class="stack" style="gap:6px;margin-top:4px"><span style="font-weight:700;font-size:14px">¿Qué tal canta? Tu mesa tiene un solo voto</span>
         <div class="stars">${[1, 2, 3, 4, 5].map(n => `<button class="star" data-vote="${n}" aria-label="${n} estrellas">★</button>`).join('')}</div>
         <span class="muted" style="font-size:12px">Los votos son secretos; nadie ve el puntaje.</span></div>`;
    h += `<div class="card now stack"><div class="row between"><span class="lbl">Cantando ahora</span><span class="mesa">Mesa ${cur.table}</span></div>
      <div class="big-name">${esc(cur.name)}</div>${songHTML(cur)}${voteUI}</div>`;
  } else if (nx) {
    h += `<div class="card now"><span class="lbl">Entre canciones</span><div style="font-weight:700;margin-top:4px">Se prepara ${esc(nx.name)} (Mesa ${nx.table})</div></div>`;
  }
  if (cur && nx) h += `<div class="card row"><div style="flex:1;min-width:0"><span class="lbl" style="color:var(--muted)">Sigue</span><div style="font-weight:800;font-size:18px">${esc(nx.name)}</div><div class="muted" style="font-size:14px">${esc(nx.title || 'Video de YouTube')}</div></div><span class="mesa off">Mesa ${nx.table}</span></div>`;
  $('now').innerHTML = h;

  $('mine').innerHTML = (me.bonus ? '<div class="turn"><b>⭐</b><span>El público te ganó prioridad: tu próximo pedido pasa al frente.</span></div>' : '') +
    `<div class="card"><span class="lbl" style="color:var(--muted)">Canciones de mi mesa</span>${V.myTable.length ? `<div class="list">${V.myTable.map(s => {
      const st = s.status === 'singing' ? '<span class="pill y">Cantando</span>' : s.pos === 0 ? '<span class="pill y">Sigue</span>' : s.pos > 0 ? `<span class="pill num">#${s.pos + 1}</span>` : '';
      return `<div class="li"><div class="grow"><b style="font-size:13px;color:var(--y)">${s.mine ? 'Tú' : esc(s.name)}</b>${songHTML(s)}</div>${st}</div>`;
    }).join('')}</div>` : '<p class="muted" style="margin:6px 0 0">Tu mesa aún no ha pedido. ¡Anímense!</p>'}</div>`;

  $('full').innerHTML = !V.phase1 && V.queue.length > 1
    ? `<div class="card"><span class="lbl" style="color:var(--muted)">Orden de la noche</span><div class="list">${V.queue.slice(cur ? 1 : 1).map((s, i) => `<div class="li"><span class="pos num">${i + 2}</span><div class="grow"><b>${esc(s.name)}</b> <span class="muted">· ${esc(s.title || 'Video')}</span></div><span class="mesa off">${s.table}</span></div>`).join('')}</div></div>`
    : '';

  const done = [...V.done].sort((a, b) => a.title.localeCompare(b.title, 'es'));
  $('hist').innerHTML = done.map(s => `<div class="li"><div class="grow">${songHTML(s)}</div></div>`).join('') || '<p class="muted">Todavía ninguna.</p>';
  if (!$('sheet').hidden) formState();
}

function renderJoin() {
  $('closed').hidden = V.open; $('kick').hidden = !kicked;
  $('j-tables').innerHTML = Array.from({ length: V.tableCount }, (_, i) => i + 1)
    .map(n => `<button type="button" class="tbtn num" data-table="${n}" aria-pressed="${pick === n}">${n}</button>`).join('');
}

// ---------- Formulario ----------
function dup(artist, title, url) {
  const vid = ytId(url);
  if (vid) { const d = V.taken.find(x => x.vid === vid); if (d) return { block: d }; }
  const tt = norm(title); if (!tt) return {};
  const same = V.taken.find(x => norm(x.title) === tt && (!artist || !x.artist || norm(x.artist) === norm(artist)));
  return same && artist ? { block: same } : same ? { warn: same } : {};
}
function formState() {
  const a = $('r-artist').value.trim(), t = $('r-title').value.trim(), u = $('r-url').value.trim();
  $('r-yt').href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent((t + ' ' + a).trim() + ' karaoke');
  let ok = !!t || !!ytId(u), msg = '';
  if (u && !ytId(u)) { ok = false; msg = '<div class="msg bad">Ese link no es de YouTube. Cópialo desde el botón Compartir del video.</div>'; }
  const d = dup(a, t, u);
  if (d.block) { ok = false; msg = `<div class="msg bad">"${esc(d.block.title || 'Ese video')}" ya ${d.block.status === 'done' ? 'sonó esta noche' : 'está en la cola'}. Elige otra.</div>`; }
  else if (d.warn) msg = `<div class="msg warn">"${esc(d.warn.title)}" de ${esc(d.warn.artist)} ya ${d.warn.status === 'done' ? 'sonó' : 'está en cola'}. Si es otra canción, escribe el artista.</div>`;
  if (V.pendingCount >= V.maxPending) { ok = false; msg = `<div class="msg warn">Ya tienes ${V.maxPending} canciones en espera. Cuando cantes una, pides otra.</div>`; }
  $('r-msg').innerHTML = msg; $('r-send').disabled = !ok;
  return ok;
}
['r-artist', 'r-title', 'r-url'].forEach(i => $(i).addEventListener('input', formState));
$('req').addEventListener('submit', async e => {
  e.preventDefault();
  if (!formState()) return;
  $('r-send').disabled = true;
  try {
    const r = await conn.send('request', { artist: $('r-artist').value, title: $('r-title').value, url: $('r-url').value });
    ['r-artist', 'r-title', 'r-url'].forEach(i => ($(i).value = ''));
    $('r-det').open = false; $('sheet').hidden = true;
    toast(r.priority ? '¡Enviada con prioridad! ⭐' : '¡Listo! Tu canción está en la cola');
  } catch (err) { toast(err.message, true); $('r-send').disabled = false; }
});

// ---------- Acciones ----------
document.addEventListener('click', async e => {
  const tb = e.target.closest('[data-table]');
  if (tb) { pick = +tb.dataset.table; renderJoin(); return; }
  const st = e.target.closest('[data-vote]');
  if (st) {
    st.parentElement.querySelectorAll('.star').forEach(b => (b.disabled = true));
    try { await conn.send('vote', { v: +st.dataset.vote }); toast('¡Voto enviado!'); }
    catch (err) { toast(err.message, true); render(); }
    return;
  }
  const id = e.target.closest('button')?.id;
  if (id === 'j-go') {
    const code = $('j-code').value.trim(), name = $('j-name').value.trim();
    if (!code) return toast('Escribe el código de la noche', true);
    if (!name) return toast('Escribe tu nombre', true);
    if (!pick) return toast('Elige tu mesa', true);
    try { const r = await conn.send('join', { code, name, table: pick }); store.set(r.token); pick = null; $('j-name').value = ''; }
    catch (err) { toast(err.message, true); }
  }
  if (id === 'leave') { store.set(''); await conn.send('leave').catch(() => {}); }
  if (id === 'open-sheet') { $('sheet').hidden = false; formState(); $('r-title').focus(); }
  if (id === 'close-sheet') $('sheet').hidden = true;
});
