let running = false;
let activated = false; // true cuando el buffer está lleno y se muestra el video retrasado
let buffer = [];
let canvas = null;
let loadingLabel = null;
let resizeObserver = null;
let delaySeconds = 5;
let panel = null;
let statusLabel = null;
let secondsInput = null;
let currentVideo = null;
let videoListeners = [];

const MAX_CAPTURE_WIDTH = 1280; // límite de resolución interna para no disparar la memoria
const FALLBACK_FPS = 60; // solo si el navegador no soporta requestVideoFrameCallback

// createMediaElementSource solo puede llamarse una vez por elemento,
// así que cacheamos el contexto y los nodos por cada <video>.
const audioGraphs = new WeakMap();

function findVideo() {
  return document.querySelector('video');
}

// Contenedor posicionado sobre el que superponer el canvas
function getVideoContainer(video) {
  const parent = video.parentElement || document.body;
  const style = getComputedStyle(parent);
  if (style.position === 'static') parent.style.position = 'relative';
  return parent;
}

function captureSize(video) {
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  if (w <= MAX_CAPTURE_WIDTH) return { w, h };
  const scale = MAX_CAPTURE_WIDTH / w;
  return { w: MAX_CAPTURE_WIDTH, h: Math.round(h * scale) };
}

function clearBuffer() {
  for (const f of buffer) f.bmp.close();
  buffer = [];
}

function getAudioGraph(video) {
  let graph = audioGraphs.get(video);
  if (!graph) {
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(video);
    const delayNode = ctx.createDelay(30);
    // El volumen del elemento se aplica ANTES de entrar al grafo, así que
    // llegaría con retraso. Se controla en su lugar con ganancias post-delay
    // y el volumen del elemento se fija a 1 mientras el delay está activo.
    const delayGain = ctx.createGain();
    const directGain = ctx.createGain();
    graph = {
      ctx, source, delayNode, delayGain, directGain,
      userVolume: video.volume, userMuted: video.muted,
      pendingResets: 0
    };
    audioGraphs.set(video, graph);
  }
  return graph;
}

function applyGains(g) {
  const v = g.userMuted ? 0 : g.userVolume;
  g.delayGain.gain.value = v;
  g.directGain.gain.value = v;
}

// Fija el volumen del elemento a 1/desmuteado para que el volumen real
// se aplique solo en las ganancias post-delay (efecto inmediato).
function pinElementVolume(video, g) {
  if (video.volume !== 1) { g.pendingResets++; video.volume = 1; }
  if (video.muted) { g.pendingResets++; video.muted = false; }
}

// Durante la carga: el audio en directo sigue sonando y, en paralelo,
// la línea de delay se va llenando para que el cambio sea sin cortes.
function routeAudioLoading(video, seconds) {
  const g = getAudioGraph(video);
  g.source.disconnect();
  g.delayNode.disconnect();
  g.delayGain.disconnect();
  g.directGain.disconnect();
  g.delayNode.delayTime.value = seconds;
  g.source.connect(g.delayNode);
  g.delayNode.connect(g.delayGain);
  g.delayGain.connect(g.ctx.destination);
  g.source.connect(g.directGain); // rama directa, se corta al activar
  g.directGain.connect(g.ctx.destination);
  g.userVolume = video.volume;
  g.userMuted = video.muted;
  applyGains(g);
  pinElementVolume(video, g);
  if (video.paused) g.ctx.suspend(); else g.ctx.resume();
}

// Al activarse el delay se corta la rama directa y queda solo la retrasada
function routeAudioDelayed(video) {
  const g = audioGraphs.get(video);
  if (!g) return;
  g.directGain.disconnect();
}

function routeAudioDirect(video) {
  const g = audioGraphs.get(video);
  if (!g) return;
  g.source.disconnect();
  g.delayNode.disconnect();
  g.delayGain.disconnect();
  g.directGain.disconnect();
  g.source.connect(g.ctx.destination);
  // Devuelve el control de volumen al elemento con los valores del usuario
  video.volume = g.userVolume;
  video.muted = g.userMuted;
  g.ctx.resume();
}

function addVideoListener(video, event, handler) {
  video.addEventListener(event, handler);
  videoListeners.push({ video, event, handler });
}

function removeVideoListeners() {
  for (const { video, event, handler } of videoListeners) {
    video.removeEventListener(event, handler);
  }
  videoListeners = [];
}

// Ajusta el retraso sobre la marcha, sin reiniciar ni recargar el buffer.
// Al bajarlo, el frame objetivo ya está en el buffer y el salto es inmediato.
// Al subirlo, la imagen se congela los segundos de diferencia hasta que el
// tiempo real la alcanza (no hay forma de mostrar frames aún no emitidos).
function setDelay(seconds) {
  delaySeconds = seconds;
  const g = currentVideo && audioGraphs.get(currentVideo);
  if (g) g.delayNode.delayTime.value = seconds;
  if (loadingLabel) {
    const span = buffer.length ? buffer[buffer.length - 1].t - buffer[0].t : 0;
    loadingLabel.textContent = 'Cargando delay… ' + Math.max(0, seconds - span).toFixed(1) + 's';
  }
  updatePanelState();
}

// Punto de entrada de los botones: si ya hay sesión sobre el mismo video,
// solo reajusta; si no, arranca de cero.
function startOrUpdateDelay(seconds) {
  if (running && currentVideo && currentVideo.isConnected) {
    setDelay(seconds);
  } else {
    startDelay(seconds);
  }
}

function startDelay(seconds) {
  stopDelay(); // limpia cualquier instancia previa
  delaySeconds = seconds;
  const video = findVideo();
  if (!video) { alert('No se encontró el reproductor de Twitch.'); return; }
  currentVideo = video;

  const container = getVideoContainer(video);
  const size = captureSize(video);

  // --- Canvas en la misma capa que el video (justo debajo en el DOM):
  // los controles y overlays de Twitch quedan por encima con normalidad.
  canvas = document.createElement('canvas');
  canvas.id = '__twitchDelayCanvas';
  canvas.width = size.w;
  canvas.height = size.h;
  Object.assign(canvas.style, {
    position: 'absolute', top: '0', left: '0',
    width: '100%', height: '100%',
    background: 'black',
    pointerEvents: 'none', objectFit: 'contain',
    visibility: 'hidden' // oculto hasta que el buffer esté lleno
  });
  container.insertBefore(canvas, video);
  const ctx2d = canvas.getContext('2d');

  // --- Mensaje de carga sobre el reproductor (el directo sigue visible) ---
  loadingLabel = document.createElement('div');
  Object.assign(loadingLabel.style, {
    position: 'absolute', top: '10px', left: '10px', zIndex: '10',
    background: 'rgba(24,24,27,0.85)', color: 'white',
    border: '1px solid #9147ff', borderRadius: '6px',
    padding: '4px 10px', fontFamily: 'sans-serif', fontSize: '13px',
    fontWeight: 'bold', pointerEvents: 'none'
  });
  loadingLabel.textContent = 'Cargando delay… ' + delaySeconds.toFixed(1) + 's';
  container.appendChild(loadingLabel);

  // Si cambia la resolución del stream, ajusta el tamaño interno del canvas
  resizeObserver = new ResizeObserver(() => {
    if (!running || !canvas) return;
    const s = captureSize(video);
    if (s.w !== canvas.width || s.h !== canvas.height) {
      canvas.width = s.w;
      canvas.height = s.h;
    }
  });
  resizeObserver.observe(video);

  buffer = [];
  running = true;
  activated = false;

  // Los frames se marcan con el tiempo de reproducción del video, no con el
  // reloj de pared: así la pausa y el seek de Twitch congelan/mueven el
  // video retrasado de forma natural.
  function grabFrame(t) {
    if (video.readyState < 2) return;
    if (buffer.length && t <= buffer[buffer.length - 1].t) return;
    // Redimensiona en la propia captura: guardar bitmaps a resolución
    // nativa (p. ej. 1080p a 60fps) multiplicaría la memoria del buffer.
    createImageBitmap(video, {
      resizeWidth: canvas.width, resizeHeight: canvas.height
    }).then((bmp) => {
      if (!running) { bmp.close(); return; }
      buffer.push({ t, bmp });
      while (buffer.length > 1 && buffer[buffer.length - 1].t - buffer[0].t > delaySeconds + 2) {
        buffer.shift().bmp.close();
      }
    }).catch(() => {});
  }

  if (typeof video.requestVideoFrameCallback === 'function') {
    // Se dispara una vez por cada frame presentado: captura a los fps
    // reales del stream (60 en streams de 60) sin duplicados.
    const onFrame = (now, metadata) => {
      if (!running) return;
      grabFrame(metadata.mediaTime);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  } else {
    let lastCapture = 0;
    const captureInterval = 1000 / FALLBACK_FPS - 2;
    const capture = () => {
      if (!running) return;
      const now = performance.now();
      if (now - lastCapture >= captureInterval) {
        lastCapture = now;
        grabFrame(video.currentTime);
      }
      requestAnimationFrame(capture);
    };
    capture();
  }

  function activate() {
    activated = true;
    if (canvas) canvas.style.visibility = 'visible';
    video.style.opacity = '0'; // el video sigue reproduciendo, solo se oculta
    if (loadingLabel) { loadingLabel.remove(); loadingLabel = null; }
    routeAudioDelayed(video);
    updatePanelState();
  }

  function render() {
    if (!running) return;
    const target = video.currentTime - delaySeconds;
    let frame = null;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].t <= target) { frame = buffer[i]; break; }
    }
    if (frame) {
      if (!activated) activate();
      ctx2d.drawImage(frame.bmp, 0, 0, canvas.width, canvas.height);
    } else if (!activated && loadingLabel) {
      const span = buffer.length ? buffer[buffer.length - 1].t - buffer[0].t : 0;
      const remaining = Math.max(0, delaySeconds - span);
      loadingLabel.textContent = 'Cargando delay… ' + remaining.toFixed(1) + 's';
    }
    requestAnimationFrame(render);
  }
  render();

  // --- Audio: directo durante la carga, la línea de delay se llena a la vez ---
  routeAudioLoading(video, seconds);

  // Pausa/reanudación de Twitch congela también el audio retrasado
  addVideoListener(video, 'pause', () => {
    const g = audioGraphs.get(video);
    if (g) g.ctx.suspend();
  });
  addVideoListener(video, 'playing', () => {
    const g = audioGraphs.get(video);
    if (g) g.ctx.resume();
  });
  // Tras un seek los frames del buffer ya no valen: se descartan
  addVideoListener(video, 'seeking', () => clearBuffer());

  // El slider/mute de Twitch cambian el volumen del elemento; se traslada
  // a las ganancias post-delay (efecto inmediato) y se vuelve a fijar a 1.
  addVideoListener(video, 'volumechange', () => {
    const g = audioGraphs.get(video);
    if (!g) return;
    // Ignora los eventos generados por nuestros propios reseteos a 1
    if (g.pendingResets > 0 && video.volume === 1 && !video.muted) {
      g.pendingResets--;
      return;
    }
    g.userVolume = video.volume;
    g.userMuted = video.muted;
    applyGains(g);
    pinElementVolume(video, g);
  });

  updatePanelState();
}

function stopDelay() {
  running = false;
  activated = false;
  removeVideoListeners();
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
  if (canvas) { canvas.remove(); canvas = null; }
  if (loadingLabel) { loadingLabel.remove(); loadingLabel = null; }
  clearBuffer();
  if (currentVideo) {
    currentVideo.style.opacity = '';
    routeAudioDirect(currentVideo);
    currentVideo = null;
  }
  updatePanelState();
}

// --- Panel de controles integrado en la interfaz de Twitch ---
function buildPanel() {
  panel = document.createElement('div');
  panel.id = '__twitchDelayPanel';

  statusLabel = document.createElement('span');
  statusLabel.style.fontWeight = 'bold';
  statusLabel.style.whiteSpace = 'nowrap';

  secondsInput = document.createElement('input');
  secondsInput.type = 'number';
  secondsInput.min = '0';
  secondsInput.max = '30';
  secondsInput.step = '1';
  secondsInput.value = String(delaySeconds);
  Object.assign(secondsInput.style, {
    width: '44px', padding: '2px 4px', borderRadius: '4px',
    border: '1px solid #9147ff', background: '#0e0e10', color: 'white',
    fontSize: '13px'
  });
  chrome.storage?.local.get('delaySeconds', (data) => {
    if (data && data.delaySeconds != null) secondsInput.value = String(data.delaySeconds);
  });

  const btnStyle = {
    padding: '3px 10px', borderRadius: '4px', border: 'none',
    cursor: 'pointer', fontWeight: 'bold', fontSize: '13px'
  };

  const startBtn = document.createElement('button');
  startBtn.textContent = 'Delay';
  Object.assign(startBtn.style, btnStyle, { background: '#9147ff', color: 'white' });
  startBtn.addEventListener('click', () => {
    const seconds = parseFloat(secondsInput.value) || 0;
    chrome.storage?.local.set({ delaySeconds: seconds });
    startOrUpdateDelay(seconds);
  });

  const stopBtn = document.createElement('button');
  stopBtn.textContent = 'Stop';
  Object.assign(stopBtn.style, btnStyle, { background: '#3a3a3d', color: 'white' });
  stopBtn.addEventListener('click', stopDelay);

  panel.append(statusLabel, secondsInput, startBtn, stopBtn);
  updatePanelState();
}

function stylePanelInline() {
  Object.assign(panel.style, {
    position: '', top: '', right: '', bottom: '', left: '', zIndex: '',
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    background: '#18181b', color: 'white', border: '1px solid #9147ff',
    borderRadius: '6px', padding: '3px 8px', marginRight: '10px',
    fontFamily: 'sans-serif', fontSize: '13px', userSelect: 'none',
    verticalAlign: 'middle', boxShadow: 'none'
  });
}

function stylePanelFixed() {
  Object.assign(panel.style, {
    position: 'fixed', bottom: '10px', left: '10px', top: '', right: '',
    zIndex: '999999', display: 'inline-flex', alignItems: 'center', gap: '6px',
    background: '#18181b', color: 'white', border: '1px solid #9147ff',
    borderRadius: '6px', padding: '3px 8px', marginRight: '0',
    fontFamily: 'sans-serif', fontSize: '13px', userSelect: 'none',
    boxShadow: '0 2px 8px rgba(0,0,0,0.5)', opacity: '0.9'
  });
}

// Intenta colocar el panel a la izquierda del botón Seguir/Siguiendo del
// canal; si no existe (portada, directorio…), cae a una esquina discreta.
function mountPanel() {
  if (!document.body) return;
  if (!panel) buildPanel();

  const followBtn = document.querySelector(
    '[data-a-target="follow-button"], [data-a-target="unfollow-button"]'
  );
  if (followBtn) {
    // Sube hasta el bloque hijo directo de la fila de acciones del canal
    let slot = followBtn;
    while (slot.parentElement && slot.parentElement.querySelector('[data-a-target="follow-button"], [data-a-target="unfollow-button"]') === followBtn && slot.parentElement.children.length === 1) {
      slot = slot.parentElement;
    }
    if (panel.nextElementSibling !== slot || panel.parentElement !== slot.parentElement) {
      stylePanelInline();
      slot.parentElement.insertBefore(panel, slot);
    }
  } else if (!panel.isConnected) {
    stylePanelFixed();
    document.body.appendChild(panel);
  }
}

// Twitch es una SPA: re-monta el panel cuando cambia el DOM
let mountScheduled = false;
const mountObserver = new MutationObserver(() => {
  if (mountScheduled) return;
  mountScheduled = true;
  requestAnimationFrame(() => {
    mountScheduled = false;
    mountPanel();
  });
});

function initPanel() {
  mountPanel();
  mountObserver.observe(document.body, { childList: true, subtree: true });
}

function updatePanelState() {
  if (!statusLabel) return;
  if (running && activated) {
    statusLabel.textContent = '▶ +' + delaySeconds + 's';
    statusLabel.style.color = '#9147ff';
  } else if (running) {
    statusLabel.textContent = '⏳ Cargando';
    statusLabel.style.color = '#bf94ff';
  } else {
    statusLabel.textContent = '⏸';
    statusLabel.style.color = '#adadb8';
  }
}

if (document.body) initPanel();
else document.addEventListener('DOMContentLoaded', initPanel);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'start') startOrUpdateDelay(msg.seconds);
  if (msg.action === 'stop') stopDelay();
  sendResponse({ ok: true });
});
