// Utilidades compartidas: conexión en tiempo real con reconexión, escape de HTML y avisos.
export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const ytId = u => { const m = String(u || '').match(/(?:youtu\.be\/|[?&]v=|shorts\/|embed\/|live\/)([\w-]{11})(?![\w-])/); return m ? m[1] : null; };
export const songHTML = s => `<div class="song">${esc(s.title || 'Video de YouTube')}<small>${esc(s.artist || '')}</small></div>`;

let tt;
export function toast(m, bad = false) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = m; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), 3500);
}

export function qrSVG(text) {
  try { const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 1, scalable: true }); }
  catch { return ''; }
}

// Conexión WebSocket con reconexión automática. send() devuelve una promesa con la respuesta del servidor.
export function connect(role, { getToken, onState, onKicked, onOpen, onAuthFail, onOther }) {
  let ws, refN = 0, retry = 0, ping, closedByUs = false;
  const waiting = new Map();
  const net = () => { let n = $('net'); if (!n) { n = document.createElement('div'); n.id = 'net'; n.textContent = 'Sin conexión. Reconectando…'; document.body.append(n); } return n; };

  function open() {
    const tok = getToken ? getToken() : '';
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=${role}${tok ? '&s=' + encodeURIComponent(tok) : ''}`;
    ws = new WebSocket(url);
    let opened = false;
    ws.onopen = () => { opened = true; retry = 0; net().hidden = true; ping = setInterval(() => { try { ws.send('ping'); } catch {} }, 25000); onOpen && onOpen(); };
    ws.onmessage = e => {
      if (e.data === 'pong') return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'state') onState(m.view);
      else if (m.t === 'kicked') onKicked && onKicked();
      else if (m.ref && waiting.has(m.ref)) { const w = waiting.get(m.ref); waiting.delete(m.ref); m.t === 'ok' ? w.ok(m) : w.fail(new Error(m.msg)); }
      else if (m.t === 'err') toast(m.msg, true);
      else onOther && onOther(m);
    };
    ws.onclose = () => {
      clearInterval(ping);
      waiting.forEach(w => w.fail(new Error('Se perdió la conexión. Intenta de nuevo.'))); waiting.clear();
      if (closedByUs) return;
      if (!opened && (role === 'admin' || role === 'tv') && retry >= 1 && onAuthFail) { onAuthFail(); return; }
      net().hidden = false;
      setTimeout(open, Math.min(10000, 800 * 2 ** retry++));
    };
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ws && ws.readyState > 1) { retry = 0; open(); } });
  open();
  return {
    send(t, data = {}) {
      return new Promise((ok, fail) => {
        if (!ws || ws.readyState !== 1) return fail(new Error('Sin conexión. Espera un momento.'));
        const ref = 'r' + (++refN);
        waiting.set(ref, { ok, fail });
        ws.send(JSON.stringify({ t, ref, ...data }));
        setTimeout(() => { if (waiting.has(ref)) { waiting.delete(ref); fail(new Error('El servidor no respondió. Intenta de nuevo.')); } }, 10000);
      });
    },
    reconnect() { try { ws.close(); } catch {} },
    close() { closedByUs = true; try { ws.close(); } catch {} },
  };
}
