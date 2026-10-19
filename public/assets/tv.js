import { $, esc, qrSVG, connect } from './common.js';

let V = null, player = null, playerReady = false, loadedId = null, reportedEnd = null;
const joinURL = code => `${location.origin}/?n=${code}`;

const conn = connect('tv', {
  onState: v => { V = v; render(); },
  onAuthFail: () => { $('noauth').hidden = false; $('unlock').hidden = true; },
});

// El navegador solo permite sonido después de un clic: la pantalla arranca con este botón.
$('unlock').addEventListener('click', () => {
  $('unlock').hidden = true;
  document.documentElement.requestFullscreen?.().catch(() => {});
  loadYT();
});
let cursorT;
document.addEventListener('mousemove', () => { document.body.classList.add('cursor'); clearTimeout(cursorT); cursorT = setTimeout(() => document.body.classList.remove('cursor'), 2500); });

function loadYT() {
  if (window.YT && window.YT.Player) return makePlayer();
  window.onYouTubeIframeAPIReady = makePlayer;
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.append(s);
}
function makePlayer() {
  player = new YT.Player('player', {
    width: '100%', height: '100%',
    playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, fs: 0 },
    events: {
      onReady: () => { playerReady = true; render(); },
      onStateChange: e => {
        if (e.data === YT.PlayerState.ENDED && V?.current && reportedEnd !== V.current.id) {
          reportedEnd = V.current.id;
          conn.send('ended', { id: V.current.id }).catch(() => {});
        }
      },
      onError: () => {
        if (V?.current) conn.send('video_error', { id: V.current.id }).catch(() => {});
        showNoVideo('Este video no se puede reproducir aquí. El admin puede elegir otro.');
      },
    },
  });
}
function showNoVideo(msg) { $('novideo').hidden = false; $('nv-msg').textContent = msg; }

function render() {
  if (!V) return;
  const cur = V.current, nx = V.next, code = V.code;
  const qr = code ? qrSVG(joinURL(code)) : '';

  if (cur) {
    $('break').hidden = true;
    $('lower').hidden = false;
    $('lower').innerHTML = `<div class="who">${esc(cur.name)}</div><div class="what">${esc(cur.title || 'Video de YouTube')}<small>Mesa ${cur.table}${cur.artist ? ' · ' + esc(cur.artist) : ''}</small></div>`;
    $('mini').hidden = !code;
    $('mini').innerHTML = code ? `<span class="qrbox">${qr}</span>Código ${esc(code)}` : '';
    if (V.currentVideo) {
      $('novideo').hidden = true;
      if (playerReady && loadedId !== V.currentVideo) { loadedId = V.currentVideo; player.loadVideoById(V.currentVideo); }
    } else {
      stopVideo();
      showNoVideo('Sin video: el admin puede elegirlo desde el panel.');
    }
  } else {
    stopVideo();
    $('novideo').hidden = true; $('lower').hidden = true; $('mini').hidden = true;
    $('break').hidden = false;
    $('break').innerHTML = `${code ? `<span class="qrbox">${qr}</span>` : `<img class="logo" src="/assets/logo.jpg" alt="Signos" style="width:30vw;height:30vw">`}
      <div class="side"><div class="row" style="gap:1.6vw"><img class="logo" src="/assets/logo.jpg" alt="Signos Rock &amp; Band"><div class="t1">${V.open ? 'Pide tu canción' : 'Karaoke cerrado'}</div></div>
      ${code ? `<div class="t2">Escanea con la cámara del celular<br>Código de hoy <b class="num">${esc(code)}</b></div>` : ''}
      ${nx ? `<div class="nx"><span class="lbl">Sigue · Mesa ${nx.table}</span><div class="nm">${esc(nx.name)}</div><div class="sg">${esc(nx.title || 'Video de YouTube')}</div></div>`
        : V.open ? '<div class="nx"><div class="sg muted">La cola está vacía. ¡Sé el primero!</div></div>' : ''}</div>`;
  }
}
function stopVideo() {
  if (playerReady && loadedId) { try { player.stopVideo(); } catch {} loadedId = null; }
}
