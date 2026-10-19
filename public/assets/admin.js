import { $, esc, songHTML, toast, qrSVG, connect } from './common.js';

let V = null, conn = null, picking = null, panel = null, wipeAsk = false, closeAsk = false;
const ago = t => { const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`; };
const ytSearch = s => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(((s.title || '') + ' ' + (s.artist || '') + ' karaoke').trim());

async function boot() {
  const r = await fetch('/api/session', { credentials: 'same-origin' }).then(x => x.json()).catch(() => ({ admin: false }));
  if (!r.admin) { $('login').hidden = false; $('dash').hidden = true; return; }
  $('login').hidden = true; $('dash').hidden = false;
  conn = connect('admin', {
    onState: v => { V = v; render(); },
    onOther: m => { if (!V) return; if (m.t === 'player') { V.player = m; render(); } if (m.t === 'tv') { V.tvOnline = m.online; render(); } },
    onAuthFail: () => { conn?.close(); $('login').hidden = false; $('dash').hidden = true; },
  });
}
$('login').addEventListener('submit', async e => {
  e.preventDefault();
  $('l-err').innerHTML = '';
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ user: $('l-user').value, pass: $('l-pass').value }) }).catch(() => null);
  if (r && r.ok) { $('l-pass').value = ''; boot(); return; }
  const d = r ? await r.json().catch(() => ({})) : {};
  $('l-err').innerHTML = `<div class="msg bad">${esc(d.error || 'No se pudo conectar. Revisa el internet.')}</div>`;
});

async function act(t, data, okMsg) {
  try { const r = await conn.send(t, data); if (okMsg || r.msg) toast(r.msg || okMsg); return r; }
  catch (err) { toast(err.message, true); throw err; }
}

// ---------- Render ----------
function keepInputs(fn) {
  const saved = {}; let focus = null;
  document.querySelectorAll('#dash input[id]').forEach(i => { saved[i.id] = i.value; if (document.activeElement === i) focus = i.id; });
  fn();
  Object.entries(saved).forEach(([id, v]) => { const i = $(id); if (i && i.type !== 'checkbox') i.value = v; });
  if (focus && $(focus)) $(focus).focus();
}
function render() { if (V) keepInputs(renderAll); }

function picker(s) {
  return `<div class="stack" style="margin-top:8px;padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--bg)">
    <a class="link" href="${ytSearch(s)}" target="_blank" rel="noopener">1. Buscar en YouTube ↗</a>
    <span class="muted" style="font-size:13px">2. Copia el enlace del video (Compartir → Copiar) y pégalo:</span>
    <input class="in" id="v-url" inputmode="url" placeholder="https://youtu.be/…" autocomplete="off">
    <div class="row"><button class="btn y sm" data-a="save-v" data-id="${s.id}">Guardar video</button><button class="btn ghost sm" data-a="cancel-v">Cancelar</button></div></div>`;
}
const vid = s => s.hasVideo
  ? (s.videoError ? `<button class="btn sm danger" data-a="pick-v" data-id="${s.id}">⚠ Video bloqueado · cambiar</button>` : `<span class="pill good">🎬 Video listo</span>`)
  : `<button class="btn sm" data-a="pick-v" data-id="${s.id}">⚠ Sin video · elegir</button>`;

const PSTATE = { playing: '▶ Reproduciendo', paused: '⏸ En pausa', buffering: '… Cargando', ended: 'Terminó', idle: 'Esperando' };
function playerBar(cur) {
  if (!V.tvOnline) return `<div class="msg warn" style="margin-top:10px">La pantalla TV no está conectada. Ábrela con "📺 Abrir pantalla TV".</div>`;
  if (!cur.hasVideo || cur.videoError) return '';
  const st = V.player && V.player.songId === cur.id ? V.player.state : 'idle';
  return `<div class="row between wrapr" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
    <span class="muted" style="font-size:14px">TV: ${PSTATE[st] || st}</span>
    <div class="row">${st === 'playing' || st === 'buffering'
      ? '<button class="btn" data-a="pl-pause">⏸ Pausar</button>'
      : '<button class="btn y" data-a="pl-play">▶ Reproducir</button>'}<button class="btn" data-a="pl-restart">↺ Desde el inicio</button></div></div>`;
}
function renderAll() {
  const q = V.queue, cur = V.current, nx = q[0];

  $('night').innerHTML = V.open
    ? `<div class="row between wrapr" style="gap:14px"><div class="stack" style="gap:6px;min-width:0"><h2 style="font-size:20px">Código de la noche</h2><span class="code-big num">${esc(V.code)}</span>
        <span class="muted" style="font-size:13px">Va en el QR de la TV. Cámbialo si sospechas que circula fuera del bar.</span>
        <div class="row wrapr"><button class="btn sm" data-a="rotate">↻ Cambiar código</button><span class="muted" style="font-size:13px">${V.people} personas conectadas</span></div></div>
        <span class="qrbox" style="width:130px">${qrSVG(location.origin + '/?n=' + V.code)}</span></div>`
    : `<h2 style="font-size:20px;margin-bottom:6px">Karaoke cerrado</h2><p class="muted" style="margin:0 0 10px;font-size:14px">Al abrir la noche se genera un código y un QR nuevos.</p><button class="btn y xl" data-a="open">Abrir la noche</button>`;

  $('alerts').innerHTML = V.alerts.map(a => `<div class="alert"><div style="font-weight:800;font-size:17px">⭐ ${esc(a.name)} (Mesa ${a.table}) sacó ★${a.stats.avg.toFixed(1)} de ${a.stats.count} mesas</div>
    <div class="muted" style="font-size:14px">Cantó ${esc(a.title || 'un video')}. ¿Le das una canción extra con prioridad?</div>
    <div class="row"><button class="btn y" data-a="al-yes" data-id="${a.id}">Sí, priorizar</button><button class="btn" data-a="al-no" data-id="${a.id}">Ahora no</button></div></div>`).join('');

  if (cur) {
    const st = cur.stats;
    $('stage').innerHTML = `<div class="row between wrapr"><span class="lbl">Cantando ahora</span>${vid(cur)}</div>
      <div class="row wrapr" style="align-items:baseline"><div class="big-name">${esc(cur.name)}</div><span class="mesa">Mesa ${cur.table}</span></div>${songHTML(cur)}
      ${picking === cur.id ? picker(cur) : ''}
      <div class="muted num" style="font-size:14px;margin-top:4px">🔒 ★ ${st.count ? st.avg.toFixed(1) : '–'} · ${st.count} ${st.count === 1 ? 'mesa votó' : 'mesas votaron'} (solo lo ves tú)</div>
      <button class="btn y xl" style="margin-top:14px" data-a="finish">✓ Terminó · mostrar QR</button>
      <div class="row between wrapr" style="margin-top:10px"><span class="muted" style="font-size:14px">Sigue: ${nx ? `<b style="color:var(--fg)">${esc(nx.name)}</b> · Mesa ${nx.table}` : 'nadie'}</span>
      <button class="btn sm" data-a="skip">Saltar</button></div>
      ${playerBar(cur)}`;
  } else {
    $('stage').innerHTML = `<div class="row between wrapr"><span class="lbl">Entre canciones</span><span class="muted" style="font-size:13px">La TV muestra el QR grande</span></div>
      ${nx ? `<div style="margin-top:6px" class="muted">Sigue</div><div class="row wrapr" style="align-items:baseline"><div class="big-name">${esc(nx.name)}</div><span class="mesa">Mesa ${nx.table}</span></div>${songHTML(nx)}
        <div style="margin-top:8px">${vid(nx)}</div>${picking === nx.id ? picker(nx) : ''}
        <button class="btn y xl" style="margin-top:14px" data-a="start">▶ Que empiece ${esc(nx.name)}${nx.hasVideo && !nx.videoError ? '' : ' (sin video)'}</button>
        <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn sm" data-a="skip-next">⏭ No vino · saltar</button></div>`
      : `<p class="muted" style="margin:8px 0">${V.open ? 'La cola está vacía. Cuando alguien pida, aparece aquí.' : 'Abre la noche para empezar.'}</p>`}`;
  }

  let last = -1, rows = '';
  q.forEach((s, i) => {
    if (s.round !== last) { rows += `<div class="round-h">${s.round === 0 ? '⭐ Prioridad' : 'Ronda ' + s.round}</div>`; last = s.round; }
    const fresh = Date.now() - s.createdAt < 30e3;
    const showPicker = picking === s.id && (cur || i > 0);
    rows += `<div class="li ${fresh ? 'fresh' : ''}"><span class="pos num">${i + 1}</span><div class="grow"><div class="row wrapr" style="gap:6px"><span class="mesa off">Mesa ${s.table}</span><b>${esc(s.name)}</b>${fresh ? '<span class="pill y">Nuevo</span>' : ''}<span class="muted" style="font-size:12px">${ago(s.createdAt)}</span></div>${songHTML(s)}<div style="margin-top:6px">${vid(s)}</div>${showPicker ? picker(s) : ''}</div>
      ${i > 0 ? `<button class="btn icon" data-a="prio" data-id="${s.id}" aria-label="Subir al primer lugar">▲</button>` : ''}<button class="btn icon danger" data-a="reject" data-id="${s.id}" aria-label="Quitar">✕</button></div>`;
  });
  $('queue').innerHTML = rows || '<p class="muted">La cola está vacía.</p>';

  $('tables').innerHTML = V.tables.map(t => `<button class="tc ${t.active ? 'on' : ''} ${panel === t.n ? 'sel' : ''}" data-a="table" data-n="${t.n}"><b class="num">Mesa ${t.n}</b><span>${t.active ? t.people.length + ' pers.' : 'Libre'}</span></button>`).join('');
  const pt = panel ? V.tables.find(t => t.n === panel) : null;
  if (!pt || !pt.active) { if (panel && pt && !pt.active) panel = null; $('panel').innerHTML = ''; renderAll.lastPanel = null; }
  else if (renderAll.lastPanel !== panel + ':' + closeAsk) {
    renderAll.lastPanel = panel + ':' + closeAsk;
    $('panel').innerHTML = `<div class="alert" style="margin-top:10px"><div class="row between"><b style="font-size:17px">Mesa ${panel}</b><button class="btn sm ghost" data-a="panel-x">Cerrar panel</button></div>
      <span class="muted" style="font-size:13px">${pt.people.length ? 'En la mesa: ' + pt.people.map(esc).join(', ') : 'Nadie se ha conectado desde esta mesa.'}</span>
      <span style="font-weight:700;font-size:14px">Agregar canción por la mesa (para quien no tenga celular)</span>
      <input class="in" id="p-name" maxlength="24" placeholder="Nombre de quien canta" autocomplete="off">
      <input class="in" id="p-title" maxlength="80" placeholder="Canción" autocomplete="off">
      <input class="in" id="p-artist" maxlength="60" placeholder="Artista" autocomplete="off">
      <input class="in" id="p-url" maxlength="200" inputmode="url" placeholder="Link de YouTube (opcional)" autocomplete="off">
      <button class="btn y" data-a="p-add">Agregar a la cola</button>
      <div style="border-top:1px solid #5a4a14;padding-top:10px">${closeAsk
        ? `<b>¿La mesa ${panel} ya se levantó?</b><div class="muted" style="font-size:14px;margin:4px 0 8px">Se quitan sus canciones pendientes y su gente sale de la app.</div><div class="row"><button class="btn danger" data-a="t-off">Sí, cerrar mesa</button><button class="btn ghost" data-a="t-no">No</button></div>`
        : `<button class="btn danger" data-a="t-ask">La mesa se levantó…</button>`}</div></div>`;
  }

  $('hist').innerHTML = V.history.map(s => `<div class="li"><span class="mesa off">${s.table}</span><div class="grow"><b>${esc(s.name)}</b>${songHTML(s)}</div>${s.status === 'skipped' ? '<span class="pill">Saltada / no vino</span>' : s.stats.count ? `<span class="pill num">★ ${s.stats.avg.toFixed(1)}</span>` : ''}</div>`).join('') || '<p class="muted">Aún nada.</p>';

  if (!document.activeElement || !document.activeElement.closest('#settings')) {
    const st = V.settings;
    $('settings').innerHTML = `
      <div class="set"><div><b>Público ve solo actual y siguiente</b><div class="muted" style="font-size:13px">Fase 1</div></div><button class="switch" role="switch" aria-checked="${st.phase1}" data-a="phase" aria-label="Fase 1"></button></div>
      <div class="set"><div><b>Mesas que deben votar</b><div class="muted" style="font-size:13px">Para sugerir prioridad</div></div><input type="number" data-set="minVotes" min="1" max="40" value="${st.minVotes}"></div>
      <div class="set"><b>Promedio mínimo de estrellas</b><input type="number" data-set="minAvg" min="1" max="5" step="0.1" value="${st.minAvg}"></div>
      <div class="set"><b>Canciones en espera por persona</b><input type="number" data-set="maxPendingPerUser" min="1" max="10" value="${st.maxPendingPerUser}"></div>
      <div class="set"><b>Número de mesas del bar</b><input type="number" data-set="tableCount" min="1" max="40" value="${st.tableCount}"></div>`;
  }

  $('wipe').innerHTML = !V.open ? '' : wipeAsk
    ? `<div class="alert danger"><b>¿Cerrar la noche?</b><span class="muted" style="font-size:14px">Se cierran todas las mesas, se vacían cola, historial y votos, y el código de hoy deja de servir.</span><div class="row"><button class="btn danger" data-a="wipe-yes">Sí, limpiar todo</button><button class="btn ghost" data-a="wipe-no">Cancelar</button></div></div>`
    : `<button class="btn danger" data-a="wipe-ask" style="width:100%">🧹 Cerrar la noche y limpiar el bar</button>`;
}

// ---------- Acciones ----------
document.addEventListener('change', e => {
  const k = e.target.dataset?.set;
  if (k) act('settings', { settings: { [k]: Number(e.target.value) } }, 'Ajuste guardado').catch(() => {});
});
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-a]');
  if (b) await onAction(b.dataset.a, b).catch(() => {});
  if (e.target.id === 'logout') { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); location.reload(); }
});
async function onAction(a, b) {
  const id = b.dataset.id;
  switch (a) {
    case 'open': return act('open_night', {}, '¡Noche abierta!');
    case 'rotate': return act('rotate_code', {}, 'Código nuevo. Quienes ya entraron siguen dentro');
    case 'start': picking = null; return act('start');
    case 'finish': return act('finish');
    case 'pl-play': return act('player', { cmd: 'play' });
    case 'pl-pause': return act('player', { cmd: 'pause' });
    case 'pl-restart': return act('player', { cmd: 'restart' });
    case 'skip': return act('skip', {}, 'Canción saltada');
    case 'skip-next': return act('skip_next', {}, 'Saltada. Su mesa pierde el turno de esta ronda');
    case 'prio': return act('prio', { id }, 'Subida al primer lugar');
    case 'reject': return act('reject', { id }, 'Canción quitada');
    case 'al-yes': return act('alert', { id, accept: true });
    case 'al-no': return act('alert', { id, accept: false });
    case 'pick-v': picking = id; render(); $('v-url')?.focus(); return;
    case 'cancel-v': picking = null; return render();
    case 'save-v': await act('set_video', { id, url: $('v-url').value }, 'Video guardado'); picking = null; return render();
    case 'table': {
      const n = +b.dataset.n, t = V.tables.find(x => x.n === n);
      closeAsk = false; renderAll.lastPanel = null;
      if (!t.active) { await act('table_on', { n }, `Mesa ${n} abierta (entra de última en la ronda)`); }
      panel = n; return render();
    }
    case 'panel-x': panel = null; closeAsk = false; return render();
    case 't-ask': closeAsk = true; return render();
    case 't-no': closeAsk = false; return render();
    case 't-off': await act('table_off', { n: panel }, `Mesa ${panel} cerrada`); panel = null; closeAsk = false; return render();
    case 'p-add': {
      await act('add_song', { table: panel, name: $('p-name').value, title: $('p-title').value, artist: $('p-artist').value, url: $('p-url').value }, 'Canción agregada');
      ['p-name', 'p-title', 'p-artist', 'p-url'].forEach(i => ($(i).value = ''));
      return;
    }
    case 'phase': return act('settings', { settings: { phase1: !V.settings.phase1 } });
    case 'wipe-ask': wipeAsk = true; return render();
    case 'wipe-no': wipeAsk = false; return render();
    case 'wipe-yes': wipeAsk = false; panel = null; return act('close_night', {}, 'Bar limpio. Listo para la próxima noche');
  }
}
setInterval(render, 15000);
boot();
