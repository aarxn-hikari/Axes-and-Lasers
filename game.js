/*
 * AXES & LASERS — Resaca Cósmica
 * game.js (Versión 2.0 - Diseño "Interlocking Loops")
 * * Motor de juego refactorizado basado en el análisis de diseño
 * (Hades, Souls, Megabonk).
 *
 * - Sistema de Estamina (Souls-like)
 * - Meta-Progresión (Hades-like "Mirror")
 * - Stats con DR y sinergias (Megabonk-like)
 * - Pools de Perks/Items expandidos
 */

'use strict';

// ============================================================================
// 1) UTILIDADES Y CONSTANTES
// ============================================================================

const GameConfig = {
  TILE_SIZE: 32,
  MAP_WIDTH: 120,  // ✅ Aumentado de 60 a 120 para mapas más grandes
  MAP_HEIGHT: 80,  // ✅ Aumentado de 60 a 80 (proporción ~16:10)
  STAMINA_REGEN: 45, // (Souls-like) Tasa de regeneración base
  DASH_COST: 25,
  SHOOT_COST: 2,
  HEAVY_COST: 30
  ,
  // ✅ Added constants for player and gameplay tuning
  MAX_STAMINA: 100,
  PLAYER_BASE_SPEED: 180,
  PLAYER_BASE_HP: 100,
  PLAYER_RADIUS: 12,
  DASH_SPEED: 600,
  DASH_DURATION: 0.25,
  DASH_BASE_COOLDOWN: 0.8,
  BASE_XP_NEXT: 100
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Disjoint-Set Union para generación de MST
class DSU {
  constructor(n) {
    this.p = Array.from({length: n}, (_, i) => i);
  }
  find(i) {
    return this.p[i] === i ? i : (this.p[i] = this.find(this.p[i]));
  }
  union(i, j) {
    const a = this.find(i), b = this.find(j);
    if (a !== b) { this.p[a] = b; return true; }
    return false;
  }
}

// ============================================================================
// 2) AUDIO MANAGER (Sin cambios)
// ============================================================================

const AudioManager = {
  ctx: null,
  src: null,
  analyser: null,
  gain: null,
  buf: null,
  data: null,
  playing: false,
  snapshot: { low: 0, mid: 0, high: 0, rms: 0, bpmHint: 120 },
  // ✅ NEW: Interval ID for monitoring AudioContext state
  _stateCheckInterval: null,

  async init() {
    // Si ya existe el contexto, no lo recreamos
    if (this.ctx) return;
    // Crear el contexto de audio
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Políticas de reproducción automática requieren reanudar el contexto
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    // Crear nodo de ganancia y establecer volumen por defecto
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.7;
    // Crear analizador y ajustar parámetros
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    // Buffer para datos de frecuencia
    this.data = new Uint8Array(this.analyser.frequencyBinCount);
    // Conectar nodos: fuente → ganancia → analizador → destino
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    // ✅ NEW: Monitor the AudioContext state every second and attempt to resume if suspended
    if (this._stateCheckInterval) {
      clearInterval(this._stateCheckInterval);
    }
    this._stateCheckInterval = setInterval(() => {
      if (this.ctx && this.ctx.state === 'suspended' && this.playing) {
        console.warn('⚠️ AudioContext suspended, attempting resume...');
        this.ctx.resume().catch(err => {
          console.error('❌ Failed to resume AudioContext:', err);
        });
      }
    }, 1000);
    console.log('✓ AudioContext initialized:', this.ctx.state);
  },

  async loadAndPlayFile(file) {
    try {
      await this.init();
      // Detener cualquier sonido previo
      if (this.src) {
        this.src.stop();
        this.src.disconnect();
        this.src = null;
      }
      // Asegurar que el contexto esté activo antes de reproducir
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
        console.log('✓ AudioContext resumed');
      }
      const arrayBuf = await file.arrayBuffer();
      this.buf = await this.ctx.decodeAudioData(arrayBuf);
      this.src = this.ctx.createBufferSource();
      this.src.buffer = this.buf;
      this.src.loop = true;
      this.src.connect(this.gain);
      this.src.start(0);
      this.playing = true;
      UIManager.log(`Audio cargado: ${file.name}`, 'success');
      console.log('✓ Audio playback started');
    } catch (error) {
      console.error('❌ Error loading audio:', error);
      UIManager.log('Error al cargar audio', 'error');
    }
  },

  toggle() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
      this.playing = true;
    } else {
      this.ctx.suspend();
      this.playing = false;
    }
  },

  getSnapshot() {
    if (!this.analyser) return this.snapshot;
    this.analyser.getByteFrequencyData(this.data);
    const N = this.data.length;
    
    const band = (from, to) => {
      let s = 0, c = 0;
      for (let i = from; i < to && i < N; i++) {
        s += this.data[i];
        c++;
      }
      return c ? s / c / 255 : 0;
    };

    const low = band(2, 32);
    const mid = band(32, 128);
    const high = band(128, 512);
    const rms = Math.sqrt(
      this.data.reduce((a, v) => a + ((v / 255) ** 2), 0) / N
    );
    const bpmHint = Math.round(60 + 120 * (low * 0.6 + mid * 0.4));
    
    this.snapshot = { low, mid, high, rms, bpmHint };
    return this.snapshot;
  },

  // ✅ NUEVO: Método para asegurar que el AudioContext esté listo
  async ensureAudioContext() {
    // Inicializar si no se ha creado
    if (!this.ctx) {
      await this.init();
    }
    // Reanudar si está suspendido
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    // Devuelve true si está corriendo
    return this.ctx && this.ctx.state === 'running';
  },
  // ✅ NEW: Cleanup method to clear periodic checks and stop audio playback
  cleanup() {
    // Clear the interval monitoring the audio context
    if (this._stateCheckInterval) {
      clearInterval(this._stateCheckInterval);
      this._stateCheckInterval = null;
    }
    // Stop and disconnect the audio source if it exists
    if (this.src) {
      try {
        this.src.stop();
      } catch (e) {
        // ignore errors on stopping
      }
      this.src.disconnect();
      this.src = null;
    }
    console.log('✅ AudioManager cleaned up');
  }
};

// ============================================================================
// 3) GAMEPAD MANAGER (Sin cambios)
// ============================================================================

const GamepadManager = {
  active: false,
  last: [],
  cursor: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  deadzone: 0.18,
  aimSpeed: 1200,

  init() {
    window.addEventListener('gamepadconnected', () => {
      this.active = true;
      UIManager.log('Gamepad conectado', 'info');
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.active = false;
      UIManager.log('Gamepad desconectado', 'warn');
    });
  },

  poll(dt) {
    const gp = navigator.getGamepads && navigator.getGamepads()[0];
    if (!gp) return;

    // Sticks (con deadzone)
    const lx = this.applyDeadzone(gp.axes[0]);
    const ly = this.applyDeadzone(gp.axes[1]);
    const rx = this.applyDeadzone(gp.axes[2]);
    const ry = this.applyDeadzone(gp.axes[3]);

    // Movimiento del jugador (L-Stick)
    if (Game.running && Game.player) {
      Game.input.moveX = lx;
      Game.input.moveY = ly;
    }

    // Cursor virtual (R-Stick)
    const speed = this.aimSpeed * dt;
    this.cursor.x = clamp(this.cursor.x + rx * speed, 0, window.innerWidth);
    this.cursor.y = clamp(this.cursor.y + ry * speed, 0, window.innerHeight);
    Game.input.cursorX = this.cursor.x;
    Game.input.cursorY = this.cursor.y;

    // Botones
    // 0=A(dash), 1=B(heavy), 2=X(TBD), 3=Y, 4=LB, 5=RB, 6=LT, 7=RT(shoot), 8=Back, 9=Start(pause)
    Game.input.shoot = this.buttonPressed(gp, 7);
    Game.input.heavyAttack = this.buttonEdge(gp, 1); // B button for heavy attack

    if (this.buttonEdge(gp, 0)) Game.input.dash = true; // A
    if (this.buttonEdge(gp, 9)) this.togglePause(); // Start

    // Navegación UI
    if (UIManager.activeScreen !== 'game-ui') {
      this.navigateUI(gp);
    }

    this.last = gp.buttons.map(b => b.pressed);
  },

  navigateUI(gp) {
    if (this.buttonEdge(gp, 12)) UIManager.moveFocus('up');
    if (this.buttonEdge(gp, 13)) UIManager.moveFocus('down');
    if (this.buttonEdge(gp, 14)) UIManager.moveFocus('left');
    if (this.buttonEdge(gp, 15)) UIManager.moveFocus('right');
    if (this.buttonEdge(gp, 0)) UIManager.confirmFocused();
    if (this.buttonEdge(gp, 1)) UIManager.back();
  },

  togglePause() {
    if (UIManager.activeScreen === 'game-ui') {
      Game.paused = true;
      UIManager.go('game-ui', 'pause');
    } else if (UIManager.activeScreen === 'pause') {
      Game.paused = false;
      UIManager.go('pause', 'game-ui');
    }
  },

  buttonPressed(gp, idx) {
    return gp.buttons[idx]?.pressed || false;
  },

  buttonEdge(gp, idx) {
    const current = gp.buttons[idx]?.pressed || false;
    const previous = this.last[idx] || false;
    return current && !previous;
  },

  applyDeadzone(value) {
    return Math.abs(value) < this.deadzone ? 0 : value;
  }
};

// ============================================================================
// 4) GENERADOR DE DUNGEONS (Nuevo generador mejorado)
// ============================================================================

const DungeonGenerator = {
  generate(params = {}) {
    const maxRooms = params.rooms || 20;
    const voidDensity = params.voidDensity || 0.02;
    const width = params.width || GameConfig.MAP_WIDTH;
    const height = params.height || GameConfig.MAP_HEIGHT;
    const tileSize = GameConfig.TILE_SIZE;

    // Convertir dimensiones de tiles a píxeles para el nuevo generador
    const pixelWidth = width * tileSize;
    const pixelHeight = height * tileSize;

    let rooms = [];
    let corridors = [];
    let mapTiles = [];

    // ============================
    // 1) ROOMS RECTANGULARES
    // ============================
    let attempts = maxRooms * 5;
    while (rooms.length < maxRooms && attempts-- > 0) {
      const w = Math.floor(Math.random() * 8 + 8) * tileSize; // ancho 8–15 tiles (más grande)
      const h = Math.floor(Math.random() * 8 + 8) * tileSize; // alto 8–15 tiles (más grande)
      const x = Math.floor(Math.random() * (pixelWidth - w));
      const y = Math.floor(Math.random() * (pixelHeight - h));

      const overlap = rooms.some(r =>
        x < r.x + r.w &&
        x + w > r.x &&
        y < r.y + r.h &&
        y + h > r.y
      );
      if (!overlap) {
        const id = rooms.length;
        rooms.push({
          id,
          x,
          y,
          w,
          h,
          center: { x: x + w / 2, y: y + h / 2 }
        });
      }
    }

    // ============================
    // 2) GRAFO + MST + PASILLOS
    // ============================
    const hubRooms = rooms;
    const edges = [];

    if (hubRooms.length > 1) {
      // Distancias entre centros y aristas cortas
      for (let i = 0; i < hubRooms.length; i++) {
        const current = hubRooms[i];
        const distances = hubRooms
          .map((target, j) => ({
            dist: Math.hypot(
              current.center.x - target.center.x,
              current.center.y - target.center.y
            ),
            room: target,
            index: j
          }))
          .sort((a, b) => a.dist - b.dist);

        // Conectar a 1–3 vecinos cercanos
        for (let k = 1; k <= 3 && k < distances.length; k++) {
          const target = distances[k].room;
          const edgeId = [
            Math.min(current.id, target.id),
            Math.max(current.id, target.id)
          ].join("-");
          if (!edges.some(e => e.id === edgeId)) {
            edges.push({
              r1: current,
              r2: target,
              weight: distances[k].dist,
              id: edgeId,
              isMST: false
            });
          }
        }
      }

      // Kruskal para MST
      edges.sort((a, b) => a.weight - b.weight);
      const mstEdges = [];
      const dsu = new DSU(hubRooms.length);

      for (const edge of edges) {
        if (dsu.union(edge.r1.id, edge.r2.id)) {
          edge.isMST = true;
          mstEdges.push(edge);
        }
      }

      // Un pequeño % de conexiones extra para loops
      const nonMstEdges = edges.filter(e => !e.isMST);
      const numExtraEdges = Math.ceil(nonMstEdges.length * 0.15);
      const finalEdges = [...mstEdges];

      for (let i = 0; i < numExtraEdges && nonMstEdges.length > 0; i++) {
        const index = Math.floor(Math.random() * nonMstEdges.length);
        finalEdges.push(nonMstEdges.splice(index, 1)[0]);
      }

      // Pasillos ortogonales (en L) entre centros
      for (const edge of finalEdges) {
        const c1 = edge.r1.center;
        const c2 = edge.r2.center;

        // Horizontal
        corridors.push({
          x: Math.min(c1.x, c2.x),
          y: c1.y - tileSize / 4,
          w: Math.abs(c1.x - c2.x) + tileSize / 2,
          h: tileSize / 2
        });

        // Vertical
        corridors.push({
          x: c2.x - tileSize / 4,
          y: Math.min(c1.y, c2.y),
          w: tileSize / 2,
          h: Math.abs(c1.y - c2.y) + tileSize / 2
        });
      }
    }

    // ============================
    // 3) TILEMAP: 0 piso, 1 pared, 3 void
    // ============================
    const mapW = Math.ceil(pixelWidth / tileSize);
    const mapH = Math.ceil(pixelHeight / tileSize);

    mapTiles = new Array(mapW).fill(0).map(() => new Array(mapH).fill(1)); // todo paredes

    const carve = entity => {
      const startX = Math.floor(entity.x / tileSize);
      const endX = Math.ceil((entity.x + entity.w) / tileSize);
      const startY = Math.floor(entity.y / tileSize);
      const endY = Math.ceil((entity.y + entity.h) / tileSize);
      for (let x = Math.max(0, startX); x < Math.min(mapW, endX); x++) {
        for (let y = Math.max(0, startY); y < Math.min(mapH, endY); y++) {
          mapTiles[x][y] = 0; // piso
        }
      }
    };

    rooms.forEach(carve);
    corridors.forEach(carve);

    // ============================
    // 4) HOYOS (void = 3)
    // ============================
    if (rooms.length > 0) {
      const startRoom = rooms[0];
      const srCx = Math.floor((startRoom.x + startRoom.w / 2) / tileSize);
      const srCy = Math.floor((startRoom.y + startRoom.h / 2) / tileSize);

      for (let x = 1; x < mapW - 1; x++) {
        for (let y = 1; y < mapH - 1; y++) {
          if (mapTiles[x][y] !== 0) continue; // sólo desde piso
          const dx = x - srCx;
          const dy = y - srCy;
          const dist = Math.hypot(dx, dy);
          if (dist < 3) continue; // minVoidRadiusTiles
          if (Math.random() < voidDensity) {
            const size = 1 + Math.floor(Math.random() * 3);
            for (let ox = -size; ox <= size; ox++) {
              for (let oy = -size; oy <= size; oy++) {
                const nx = x + ox;
                const ny = y + oy;
                if (nx <= 0 || ny <= 0 || nx >= mapW - 1 || ny >= mapH - 1) continue;
                if (mapTiles[nx][ny] === 0) mapTiles[nx][ny] = 3; // void
              }
            }
          }
        }
      }
    }

    // ============================
    // 5) Convertir a formato original (map[y][x])
    // ============================
    const map = Array.from({ length: mapH }, () => Array(mapW).fill(1));
    for (let x = 0; x < mapW; x++) {
      for (let y = 0; y < mapH; y++) {
        map[y][x] = mapTiles[x][y];
      }
    }

    // Convertir rooms de píxeles a tiles
    const roomsInTiles = rooms.map(r => ({
      id: r.id,
      x: Math.floor(r.x / tileSize),
      y: Math.floor(r.y / tileSize),
      w: Math.ceil(r.w / tileSize),
      h: Math.ceil(r.h / tileSize),
      center: {
        x: r.center.x / tileSize,
        y: r.center.y / tileSize
      }
    }));

    return { map, rooms: roomsInTiles, corridors, width: mapW, height: mapH };
  },

  generateFromAudio(audioSnapshot) {
    const { low, mid, high, rms } = audioSnapshot;

    const rooms = Math.max(10, Math.min(40, Math.round(12 + rms * 20 + low * 10)));
    const voidDensity = Math.max(0.01, Math.min(0.05, 0.02 + high * 0.03));

    return this.generate({
      rooms,
      voidDensity,
      width: GameConfig.MAP_WIDTH,
      height: GameConfig.MAP_HEIGHT
    });
  }
};

// ============================================================================
// 5) UI MANAGER (Modificado para Meta-Progresión)
// ============================================================================

const UIManager = {
  activeScreen: 'boot-sequence',

init() {
    this.initCanvas();
    this.injectHubPanel(); // ¡NUEVO! Inyecta el panel del Hub dinámicamente
    this.bindEvents();
    this.bootLog();
  },

  el(id) {
    return document.getElementById(id);
  },
  
  // ¡NUEVO! Inyecta el HTML del Hub en el DOM, ya que no podemos editar game.html
  injectHubPanel() {
    try {
      const nav = document.querySelector('#main-menu-overlay .menu-nav');
      const panels = document.getElementById('menu-panels');

      if (!nav || !panels) {
        console.error("No se pudieron encontrar los contenedores del menú para inyectar el Hub.");
        return;
      }
      
      // 1. Inyectar el botón de navegación
      const hubButton = `
        <button data-target="hub-panel">El Hub (Meta)</button>
      `;
      nav.insertAdjacentHTML('beforeend', hubButton);

      // 2. Inyectar el panel del Hub
      const hubPanel = `
        <div id="hub-panel" class="tab-content" style="display:none">
          <h3>El Hub (Progreso Permanente)</h3>
          <p style="font-size:12px; color:var(--gold); margin-bottom:14px">
            Gasta tu Ceniza Cósmica (guardada entre partidas) para mejoras permanentes.
          </p>
          <div class="stat-item" style="margin-bottom: 20px; background: rgba(255,179,0,.1); border-color: var(--gold); text-align: left; padding: 14px;">
            <div class="stat-name" style="font-size: 14px;">Ceniza Cósmica</div>
            <div id="hub-ash-display" class="stat-value" style="font-size: 24px; color: var(--gold);">0</div>
          </div>

          <div id="hub-upgrades">
            <div class="setting-item">
              <span>+1 Grit Base (Costo: <span id="cost-grit">100</span>)</span>
              <button class="btn btn-outline" data-upgrade="grit">Comprar</button>
            </div>
            <div class="setting-item">
              <span>+1 Might Base (Costo: <span id="cost-might">150</span>)</span>
              <button class="btn btn-outline" data-upgrade="might">Comprar</button>
            </div>
            <div class="setting-item">
              <span>+1 Haste Base (Costo: <span id="cost-haste">120</span>)</span>
              <button class="btn btn-outline" data-upgrade="haste">Comprar</button>
            </div>
            <div class="setting-item">
              <span>+1 Luck Base (Costo: <span id="cost-luck">200</span>)</span>
              <button class="btn btn-outline" data-upgrade="luck">Comprar</button>
            </div>
          </div>
        </div>
      `;
      panels.insertAdjacentHTML('beforeend', hubPanel);
      
      console.log("Panel del Hub inyectado correctamente.");

    } catch (error) {
      console.error("Error al inyectar el panel del Hub:", error);
    }
  },

show(id) {
  console.log(`👁️ UIManager.show: ${id}`);
  const overlay = this.el(`${id}-overlay`);
  if (!overlay) {
    console.error(`❌ Overlay not found: ${id}-overlay`);
    return;
  }
  
  overlay.classList.add('active');
  
  // ✅ Force visibility with multiple methods
  if (id === 'game-ui') {
    // Game UI should not have background/backdrop
    overlay.style.display = 'block';
  } else {
    overlay.style.display = 'flex';
  }
  
  this.activeScreen = id;
  console.log(`✅ Active screen: ${this.activeScreen}`);
  
  // Manejar visibilidad del panel de stats
  if (id === 'pause') {
    document.body.classList.add('show-stats');
    const pauseContent = overlay.querySelector('.main-menu-container');
    if (pauseContent) pauseContent.style.opacity = '1';
  } else if (id === 'game-ui') {
    document.body.classList.remove('show-stats');
    
    // ✅ CRITICAL: Ensure canvas is visible
    const canvas = this.el('game-canvas');
    if (canvas) {
      canvas.style.display = 'block';
      canvas.style.opacity = '1';
      console.log('✅ Canvas visibility ensured');
    }
  }
},

hide(id) {
  console.log(`🙈 UIManager.hide: ${id}`);
  const overlay = this.el(`${id}-overlay`);
  if (!overlay) {
    console.warn(`⚠️ Overlay not found for hiding: ${id}-overlay`);
    return;
  }
  // Remove active class to begin CSS transition
  overlay.classList.remove('active');
  // Handler for transition end to hide element completely
  const handleTransitionEnd = (e) => {
    // Only act when the overlay itself finishes transitioning
    if (e.target === overlay && !overlay.classList.contains('active')) {
      overlay.style.display = 'none';
      console.log(`✅ ${id} hidden after transition`);
      overlay.removeEventListener('transitionend', handleTransitionEnd);
    }
  };
  overlay.addEventListener('transitionend', handleTransitionEnd);
  // Fallback: hide after 500ms if no transition event fires
  setTimeout(() => {
    if (!overlay.classList.contains('active')) {
      overlay.style.display = 'none';
      overlay.removeEventListener('transitionend', handleTransitionEnd);
    }
  }, 500);
},

go(from, to) {
  console.log(`🔄 UIManager.go: ${from} → ${to}`);
  // Hide the source screen first
  this.hide(from);
  const fromOverlay = this.el(`${from}-overlay`);
  // Function to execute once the source overlay is hidden
  const handleHideComplete = () => {
    // Show the target overlay
    this.show(to);
    // Manage stats panel visibility
    if (to === 'pause') {
      document.body.classList.add('show-stats');
    } else if (to === 'game-ui') {
      document.body.classList.remove('show-stats');
    } else {
      document.body.classList.remove('show-stats');
    }
    // Animate main menu when navigating to it
    if (to === 'main-menu') {
      const mm = this.el('main-menu-container');
      if (mm) {
        mm.classList.remove('active');
        // Delay the re-activation to allow transition
        setTimeout(() => mm.classList.add('active'), 60);
      }
      Game.updateHubUI();
    }
    // Special animation for title screen
    if (to === 'title-screen') {
      this.animateTitle();
    }
    // Start a new game only when moving into game-ui from allowed states
    if (to === 'game-ui' && from !== 'pause' && from !== 'levelup') {
      // Use requestAnimationFrame to wait for DOM to update
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          console.log('🎮 Calling Game.startNewGame()...');
          Game.startNewGame();
        });
      });
    }
    // Update active screen
    this.activeScreen = to;
    console.log(`✅ Active screen set to: ${this.activeScreen}`);
  };
  // If the from overlay exists, wait for it to finish hiding
  if (fromOverlay) {
    const checkHidden = () => {
      if (fromOverlay.style.display === 'none' || !fromOverlay.classList.contains('active')) {
        fromOverlay.removeEventListener('transitionend', checkHidden);
        handleHideComplete();
      }
    };
    fromOverlay.addEventListener('transitionend', checkHidden);
    // Fallback: run after 300ms in case no transition
    setTimeout(handleHideComplete, 300);
  } else {
    // If no overlay to hide, proceed immediately
    handleHideComplete();
  }
},

  bindEvents() {
    // Boot → Title
    this.el('boot-continue').addEventListener('click', () => {
      this.go('boot-sequence', 'title-screen');
    });

// ✅ Title → Menu (with audio context resume)
this.el('title-continue').addEventListener('click', async () => {
  console.log('▶️ Title continue clicked');
  
  // ✅ CRITICAL: Resume audio context on first user interaction
  try {
    const audioReady = await AudioManager.ensureAudioContext();
    if (audioReady) {
      console.log('✅ Audio context ready for playback');
    } else {
      console.warn('⚠️ Audio context not ready');
    }
  } catch (error) {
    console.error('❌ Audio context error:', error);
  }
  
  // Proceed to menu
  this.go('title-screen', 'main-menu');
});

    // Navegación de tabs en menú
    const nav = document.querySelector('#main-menu-overlay .menu-nav');
    nav.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      const targetId = e.target.dataset.target;
      if (!targetId) return;

      nav.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');

      document.querySelectorAll('#menu-panels .tab-content').forEach(p => {
        p.style.display = 'none';
      });
      
      const panel = document.getElementById(targetId);
      if (panel) {
        panel.style.display = 'block';
        
        // ¡NUEVO! Actualizar UI del Hub al hacer click
        if (targetId === 'hub-panel') {
          Game.updateHubUI();
        }
      }
    });
    
    // ¡NUEVO! Bindings para los botones del Hub
    // Usamos delegación de eventos en el panel inyectado
    document.body.addEventListener('click', (e) => {
      if (e.target.matches('#hub-upgrades button')) {
        const upgradeId = e.target.dataset.upgrade;
        if (upgradeId) {
          Game.spendCosmicAsh(upgradeId);
        }
      }
    });

    // Cargar MP3
    this.el('load-mp3-btn').addEventListener('click', () => {
      this.el('mp3-input').click();
    });

 this.el('mp3-input').addEventListener('change', async (e) => {
  const files = e.target.files;
  if (files && files[0]) {
    const fileName = files[0].name;
    console.log(`📁 Loading MP3: ${fileName}`);
    
    // Set seed from filename
    Game.setSeedFromString(fileName);

    // Ensure audio context is ready
    const audioReady = await AudioManager.ensureAudioContext();
    if (!audioReady) {
      this.log('Error: AudioContext no disponible', 'error');
      console.error('❌ AudioContext failed to initialize');
      return;
    }

    // Load and play audio
    try {
      await AudioManager.loadAndPlayFile(files[0]);
      console.log('✅ Audio loaded successfully');
      this.log(`Listo: ${fileName}`, 'success');
      
      // ✅ Wait for audio to stabilize before transitioning
      setTimeout(() => {
        console.log('🔄 Transitioning to game...');
        this.go('main-menu', 'game-ui');
      }, 200);
      
    } catch (error) {
      console.error('❌ Failed to load audio:', error);
      this.log('Error al cargar audio', 'error');
    }
  }
});

    // Seed aleatoria
this.el('random-seed-btn').addEventListener('click', async () => {
  console.log('🎲 Random seed button clicked');
  
  // Set random seed
  const seed = Math.random();
  Game.setSeed(seed);
  console.log(`✅ Seed set: ${seed}`);
  
  // Ensure audio context is ready (even without audio file)
  const audioReady = await AudioManager.ensureAudioContext();
  if (audioReady) {
    console.log('✅ Audio context ready (silent mode)');
  } else {
    console.warn('⚠️ Audio context not ready, continuing anyway');
  }
  
  // ✅ Small delay for UI stability
  setTimeout(() => {
    console.log('🔄 Transitioning to game...');
    this.go('main-menu', 'game-ui');
  }, 100);
});

    // Toggle música
    this.el('music-toggle').addEventListener('click', () => {
      AudioManager.toggle();
      const text = AudioManager.playing ? 'Toggle Off' : 'Toggle On';
      this.el('music-toggle').textContent = text;
    });

    // Volumen SFX
    this.el('sfx-volume').addEventListener('input', (e) => {
      this.el('sfx-volume-value').textContent = e.target.value + '%';
    });

    // Calidad gráfica
    this.el('graphics-quality').addEventListener('click', (e) => {
      const qualities = ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'];
      const current = e.target.textContent;
      const index = (qualities.indexOf(current) + 1) % qualities.length;
      e.target.textContent = qualities[index];
    });

    // Menú de pausa - CORREGIDO
    this.el('resume-btn').addEventListener('click', () => {
      if (this.activeScreen === 'pause') {
        // Primero despausar el juego, luego volver a la UI del juego
        Game.paused = false;
        this.go('pause', 'game-ui');
      }
    });

    this.el('settings-from-pause').addEventListener('click', () => {
      alert('Ajustes en pausa (placeholder)');
    });

    this.el('exit-to-menu').addEventListener('click', () => {
      if (confirm('¿Volver al menú? El progreso se perderá.')) {
        Game.running = false;
        Game.paused = false;
        this.go('pause', 'main-menu');
      }
    });

    // Auto-aim toggle
    this.el('auto-aim-indicator').addEventListener('click', () => {
      const indicator = this.el('auto-aim-indicator');
      const status = this.el('auto-aim-status');
      
      Game.autoAim = !Game.autoAim;
      
      if (Game.autoAim) {
        indicator.classList.remove('off');
        status.textContent = 'Auto-Aim: ON';
        this.log('Auto-Aim activado', 'success');
      } else {
        indicator.classList.add('off');
        status.textContent = 'Auto-Aim: OFF';
        this.log('Auto-Aim desactivado', 'warn');
      }
    });

    // Teclas globales (sin conflicto con gamepad)
    document.addEventListener('keydown', (e) => {
      const screen = this.activeScreen;
      
      if (screen === 'boot-sequence' && e.key === 'Enter') {
        this.go('boot-sequence', 'title-screen');
      } else if (screen === 'title-screen' && e.key === 'Enter') {
        this.go('title-screen', 'main-menu');
      } else if (screen === 'game-ui' && e.key === 'Escape') {
        e.preventDefault();
        Game.paused = true;
        this.go('game-ui', 'pause');
      } else if (screen === 'pause' && e.key === 'Escape') {
        e.preventDefault();
        Game.paused = false;
        this.go('pause', 'game-ui');
      }

      if (e.key === 'F1') {
        e.preventDefault();
        alert('Guía: WASD=mover, Mouse=apuntar, Space=dash, E=Ataque Pesado');
      }
    });
  },

  bootLog() {
    const lines = [
      'HIKARI CREATIVE BIOS v3.1.0',
      '> Cargando AXES & LASERS: Resaca Cósmica...',
      '> Build: v2.0 "Interlocking Loops"',
      '> Inicializando motor de Estamina... OK',
      '> Conectando a persistencia (Hub)... OK',
      '> Esperando entrada del usuario...'
    ];

    const box = this.el('bios-text');
    box.innerHTML = '';

    lines.forEach((text, i) => {
      const div = document.createElement('div');
      div.className = 'bios-line';
      div.textContent = text;
      div.style.opacity = 0;
      div.style.transition = 'opacity 0.7s ease';
      box.appendChild(div);
      
      setTimeout(() => {
        div.style.opacity = 1;
      }, i * 420);
    });
  },

  animateTitle() {
    const tagline = this.el('studio-tagline');
    const sfx = this.el('studio-sfx');
    
    tagline.style.opacity = 0;
    tagline.style.transition = 'opacity 1.2s ease';
    setTimeout(() => { tagline.style.opacity = 1; }, 300);

    sfx.style.opacity = 0;
    const flickerTimes = [0, 500, 900, 1300, 1700, 2100];
    flickerTimes.forEach((t, idx) => {
      setTimeout(() => {
        sfx.style.opacity = idx % 2 === 0 ? 1 : 0;
      }, 1200 + t);
    });
  },

initCanvas() {
  const gameCanvas = this.el('game-canvas');
  const hudCanvas = this.el('hud-canvas');

  if (!gameCanvas || !hudCanvas) {
    console.error('❌ Canvas elements not found!');
    return;
  }

  const gameCtx = gameCanvas.getContext('2d');
  const hudCtx = hudCanvas.getContext('2d');

  if (!gameCtx || !hudCtx) {
    console.error('❌ Failed to get canvas contexts!');
    return;
  }

  console.log('🎨 Initializing dual canvas system...');

  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Resize both canvases
    gameCanvas.width = w;
    gameCanvas.height = h;
    hudCanvas.width = w;
    hudCanvas.height = h;

    console.log(`📐 Canvases resized: ${w}x${h}`);
    drawGrid();
  };

  const drawGrid = () => {
    const w = gameCanvas.width;
    const h = gameCanvas.height;

    // Draw grid on game canvas
    gameCtx.fillStyle = '#0c1119';
    gameCtx.fillRect(0, 0, w, h);

    gameCtx.strokeStyle = 'rgba(0,242,255,.08)';
    gameCtx.lineWidth = 1;

    const gridSize = 64;
    for (let x = 0; x < w; x += gridSize) {
      gameCtx.beginPath();
      gameCtx.moveTo(x, 0);
      gameCtx.lineTo(x, h);
      gameCtx.stroke();
    }
    for (let y = 0; y < h; y += gridSize) {
      gameCtx.beginPath();
      gameCtx.moveTo(0, y);
      gameCtx.lineTo(w, y);
      gameCtx.stroke();
    }

    gameCtx.fillStyle = 'rgba(255,255,255,.08)';
    gameCtx.font = '48px "Press Start 2P"';
    gameCtx.textAlign = 'center';
    gameCtx.fillText('AXES & LASERS', w / 2, h / 2 - 48);

    gameCtx.fillStyle = 'rgba(0,242,255,.25)';
    gameCtx.font = '20px "Press Start 2P"';
    gameCtx.fillText('Resaca Cósmica', w / 2, h / 2);
  };

  window.addEventListener('resize', resize);
  resize();
  console.log('✅ Dual canvas system initialized (Game + HUD)');
},
  log(msg, type = 'info') {
    const log = this.el('event-log');
    if (!log) return; // Guarda contra errores de timing
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    
    const now = new Date();
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const ts = `[${mm}:${ss}]`;
    
    entry.textContent = `${ts} ${msg}`;
    log.prepend(entry);
    
    while (log.children.length > 12) {
      log.removeChild(log.lastChild);
    }
  },

  updateHUD() {
    if (!Game.running || !Game.player) return;

    const p = Game.player;
    // ✅ Mostrar contador de sala actual
    const roomDisplay = this.el('current-room');
    if (roomDisplay && Game.rooms && Game.rooms.length > 0) {
      const idx = Game.currentRoomIndex;
      const total = Game.rooms.length;
      roomDisplay.textContent = `Sala ${idx + 1}/${total}`;
    }
    
    // Barras
    const hpBar = this.el('hp-bar');
    const staminaBar = this.el('energy-bar'); // Reutilizamos el 'energy-bar' del HTML
    const xpBar = this.el('xp-bar');
    
    // ¡NUEVO! Ocultar la barra de Fuel
    const fuelBarContainer = this.el('fuel-bar')?.closest('.stat-bar');
    if (fuelBarContainer && fuelBarContainer.style.display !== 'none') {
      fuelBarContainer.style.display = 'none';
    }
    
    if (hpBar) hpBar.style.width = (p.hp / p.maxHp * 100) + '%';
    if (this.el('hp-text')) this.el('hp-text').textContent = `${Math.ceil(p.hp)}/${p.maxHp}`;
    
    // ¡MODIFICADO! 'energy-bar' ahora muestra Estamina
    if (staminaBar) {
      staminaBar.style.width = (p.stamina / p.maxStamina * 100) + '%';
      // Efecto "soft fail" en la barra
      if (p.stamina <= 0) {
        staminaBar.style.background = 'var(--danger)';
      } else {
        staminaBar.style.background = 'linear-gradient(90deg, #00e0ff, var(--accent))';
      }
    }
    if (this.el('energy-text')) {
      this.el('energy-text').textContent = `${Math.ceil(p.stamina)}/${p.maxStamina}`;
    }
    // ¡MODIFICADO! Renombrar etiqueta de Energy a Stamina
    const staminaLabel = this.el('energy-text')?.previousElementSibling?.querySelector('span:first-child');
    if (staminaLabel && staminaLabel.textContent !== 'Stamina') {
      staminaLabel.textContent = 'Stamina';
    }
    
    if (xpBar) xpBar.style.width = (p.xp / p.xpNext * 100) + '%';
    if (this.el('xp-text')) this.el('xp-text').textContent = `${Math.floor(p.xp)}/${p.xpNext}`;

    // Stats (¡NUEVO!)
    const statElements = {
      'stat-might': Game.stats.might,
      'stat-focus': Game.stats.focus,
      'stat-grit': Game.stats.grit,
      'stat-haste': Game.stats.haste,
      'stat-luck': Game.stats.luck,
      'stat-level': Game.stats.level
    };
    
    for (const [id, value] of Object.entries(statElements)) {
      const el = this.el(id);
      if (el) el.textContent = value;
    }
  },

  updateInventory() {
    const grid = this.el('inventory-grid');
    if (!grid) return;
    grid.innerHTML = '';
    
    Game.inventory.forEach(item => {
      const slot = document.createElement('div');
      slot.className = `item-slot rarity-${item.rarity}`;
      slot.innerHTML = `
        <span>${item.icon}</span>
        <div class="item-count">${item.count}</div>
      `;
      slot.title = `${item.name}: ${item.description}`;
      grid.appendChild(slot);
    });
  },

  /**
   * Actualiza elementos de la UI relacionados con las salas actuales,
   * como el contador de salas y enemigos restantes. Llamado desde
   * Game.update() después de cada actualización de estado.
   */
  updateRoomDisplay() {
    if (!Game.running || !Game.rooms) return;
    const currentRoom = Game.rooms[Game.currentRoomIndex];
    if (!currentRoom) return;
    // Actualizar contador de salas (con prefijo "Sala")
    const roomCounter = this.el('current-room');
    if (roomCounter) {
      roomCounter.textContent = `Sala ${Game.currentRoomIndex + 1}/${Game.rooms.length}`;
    }
    // Actualizar contador de enemigos restantes en la sala
    const enemyCounter = this.el('enemies-remaining');
    if (enemyCounter) {
      const roomEnemies = Game.enemies.filter(e => e.roomId === currentRoom.id);
      enemyCounter.textContent = roomEnemies.length;
    }
  },

  showPerkSelection(perks) {
    const container = this.el('perk-cards');
    if (!container) return;
    container.innerHTML = '';
    
    perks.forEach(perk => {
      const card = document.createElement('div');
      card.className = `perk-card ${perk.rarity}`;
      card.tabIndex = 0;
      
      // ¡NUEVO! Añadir "badges" de sinergia
      const badgeColors = { '🔴': 'var(--danger)', '🔵': 'var(--rare)', '🟢': 'var(--green)', '🟣': 'var(--epic)' };
      const badgeColor = badgeColors[perk.badge] || 'var(--text-dim)';
      
      card.innerHTML = `
        <h3 style="display: flex; justify-content: space-between; align-items: center;">
          <span>${perk.title}</span>
          <span style="color: ${badgeColor}; font-size: 16px;" title="Sinergia: ${perk.badge}">${perk.badge}</span>
        </h3>
        <p>${perk.description}</p>
      `;
      
      card.addEventListener('click', () => {
        Game.applyPerk(perk);
        this.hide('levelup');
        this.show('game-ui');
        Game.resumeFromLevelUp();
      });
      
      container.appendChild(card);
    });

    // Auto-focus para gamepad
    setTimeout(() => {
      const firstCard = container.querySelector('.perk-card');
      if (firstCard) firstCard.focus();
    }, 100);
  },

  // Navegación UI con gamepad
  moveFocus(dir) {
    const scope = document.querySelector(`#${this.activeScreen}-overlay`) || document;
    const focusables = Array.from(scope.querySelectorAll('button, [tabindex="0"], .perk-card, .slider'));
    
    if (!focusables.length) return;
    
    const current = focusables.indexOf(document.activeElement);
    const index = current === -1 ? 0 : current;
    const step = (dir === 'left' || dir === 'up') ? -1 : 1;
    const next = (index + step + focusables.length) % focusables.length;
    
    focusables[next].focus();
  },

  confirmFocused() {
    if (document.activeElement && document.activeElement.click) {
      document.activeElement.click();
    }
  },

  back() {
    if (this.activeScreen === 'pause') {
      this.go('pause', 'game-ui');
    }
  }
};

// ============================================================================
// 6) MOTOR DE JUEGO PRINCIPAL (Refactorizado con nuevo diseño)
// ============================================================================

const Game = {
  running: false,
  paused: false,
  autoAim: true,
  seed: Math.random(),
  _seedState: 0,
  // ✅ NEW: Track active timeouts to clear on restart
  _activeTimeouts: [],

  // Input unificado (teclado/mouse + gamepad)
  input: {
    moveX: 0,
    moveY: 0,
    shoot: false,
    dash: false,
    heavyAttack: false,
    cursorX: null,
    cursorY: null
  },

  // Estado del teclado/mouse
  keys: {},
  mousePos: null,

  // Mundo
  cols: GameConfig.MAP_WIDTH,
  rows: GameConfig.MAP_HEIGHT,
  tileSize: GameConfig.TILE_SIZE,
  map: [],
  camera: { x: 0, y: 0 },

  // Entidades
  player: null,
  enemies: [],
  bullets: [],
  items: [],
  inventory: [],

  // ===== Room-based combat system =====
  // Array de salas convertidas desde el generador de dungeons
  rooms: [],
  // Índice de la sala actual
  currentRoomIndex: 0,
  // Estado de la sala: 'Fight' cuando hay combate, 'Clear' cuando se completa, 'Transition' durante la transición
  roomState: 'Fight',
  
  // ¡NUEVO! Stats y progresión
  cosmicAsh: 0, // Total meta-currency (cargada de localStorage)
  
  // Stats base (mejorados por el Hub)
  baseStats: {
    level: 1,
    might: 0,
    focus: 0,
    grit: 0,
    haste: 0,
    luck: 0,
    // Costos de mejoras del Hub (podrían cargarse desde un config)
    costs: {
      might: 150,
      focus: 150,
      grit: 100,
      haste: 120,
      luck: 200
    }
  },
  
  // Stats de la run actual (reseteados cada partida)
  stats: {},

  // Control de spawns
  lastSpawnTime: 0,
  spawnInterval: 4,
  nextEnemyId: 0,

  // Timers
  shootCooldown: 0,
  lastTime: 0,

  // ========================================================================
  // PRNG (Pseudorandom Number Generator)
  // ========================================================================

  rng() {
    let t = this._seedState += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  },

  setSeed(seed) {
    this.seed = seed;
    this._seedState = Math.floor((seed % 1) * 0xffffffff);
  },

  setSeedFromString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
    }
    this.setSeed((hash >>> 0) / 0xffffffff);
  },

  // ✅ NEW: Wrapper for setTimeout that tracks active timers
  setTimeout(callback, delay) {
    const id = setTimeout(() => {
      callback();
      const idx = this._activeTimeouts.indexOf(id);
      if (idx !== -1) this._activeTimeouts.splice(idx, 1);
    }, delay);
    this._activeTimeouts.push(id);
    return id;
  },

  // ✅ NEW: Clear all tracked timeouts (called on restart)
  clearAllTimeouts() {
    this._activeTimeouts.forEach(id => clearTimeout(id));
    this._activeTimeouts = [];
    console.log('✅ All timeouts cleared');
  },

  // ========================================================================
  // GESTIÓN DE STATS Y CÁLCULOS
  // ========================================================================
  
  // ¡NUEVO! Carga stats base desde localStorage
  loadBaseStats() {
    try {
      const savedStats = localStorage.getItem('hikariBaseStats');
      const savedAsh = localStorage.getItem('cosmicAsh');
      if (savedStats) {
        const parsed = JSON.parse(savedStats);
        const isValid = (
          parsed &&
          typeof parsed === 'object' &&
          typeof parsed.level === 'number' &&
          typeof parsed.might === 'number' &&
          typeof parsed.focus === 'number' &&
          typeof parsed.grit === 'number' &&
          typeof parsed.haste === 'number' &&
          typeof parsed.luck === 'number' &&
          parsed.costs && typeof parsed.costs === 'object'
        );
        if (isValid) {
          // ✅ Sanitize values
          this.baseStats = {
            level: Math.max(1, Math.floor(parsed.level)),
            might: Math.max(0, Math.floor(parsed.might)),
            focus: Math.max(0, Math.floor(parsed.focus)),
            grit: Math.max(0, Math.floor(parsed.grit)),
            haste: Math.max(0, Math.floor(parsed.haste)),
            luck: Math.max(0, Math.floor(parsed.luck)),
            costs: {
              might: Math.max(100, Math.floor(parsed.costs.might || 150)),
              focus: Math.max(100, Math.floor(parsed.costs.focus || 150)),
              grit: Math.max(100, Math.floor(parsed.costs.grit || 100)),
              haste: Math.max(100, Math.floor(parsed.costs.haste || 120)),
              luck: Math.max(100, Math.floor(parsed.costs.luck || 200))
            }
          };
          console.log('✅ Base stats loaded and validated');
        } else {
          console.warn('⚠️ Invalid saved stats structure, using defaults');
          this.resetBaseStats();
        }
      }
      if (savedAsh) {
        const ashValue = parseInt(savedAsh, 10);
        this.cosmicAsh = isNaN(ashValue) ? 0 : Math.max(0, ashValue);
      }
    } catch (e) {
      console.error('❌ Error loading base stats:', e);
      this.resetBaseStats();
      localStorage.removeItem('hikariBaseStats');
      localStorage.removeItem('cosmicAsh');
    }
  },
  
  // ¡NUEVO! Guarda stats base en localStorage
  saveBaseStats() {
    try {
      localStorage.setItem('hikariBaseStats', JSON.stringify(this.baseStats));
      localStorage.setItem('cosmicAsh', this.cosmicAsh.toString());
    } catch (e) {
      console.error("Error al guardar stats base:", e);
    }
  },

  // ¡NUEVO! Calcula la velocidad del jugador basado en Haste
  getPlayerSpeed() {
    const baseSpeed = 180;
    return baseSpeed * (1 + this.stats.haste * 0.04);
  },
  
  // ¡NUEVO! Calcula el CD del dash basado en Haste
  getDashCooldown() {
    const baseDashCD = 0.8;
    // Haste da -10% CD por punto, con un cap de 75% CD reduction
    const cdMultiplier = 1 - Math.min(this.stats.haste * 0.1, 0.75);
    return baseDashCD * cdMultiplier;
  },

  // ✅ NEW: Create a new player object at world coordinates (x, y)
  createPlayer(x, y) {
    return {
      x: x,
      y: y,
      vx: 0,
      vy: 0,
      radius: GameConfig.PLAYER_RADIUS || 12,
      speed: GameConfig.PLAYER_BASE_SPEED || 180,
      hp: GameConfig.PLAYER_BASE_HP || 100,
      maxHp: GameConfig.PLAYER_BASE_HP || 100,
      stamina: GameConfig.MAX_STAMINA || 100,
      maxStamina: GameConfig.MAX_STAMINA || 100,
      staminaRegen: GameConfig.STAMINA_REGEN,
      xp: 0,
      xpNext: GameConfig.BASE_XP_NEXT || 100,
      isDashing: false,
      dashTime: 0,
      dashSpeed: GameConfig.DASH_SPEED || 600,
      dashDuration: GameConfig.DASH_DURATION || 0.25,
      dashCooldown: 0,
      dashCooldownTime: GameConfig.DASH_BASE_COOLDOWN || 0.8,
      invulnTime: 0,
      heavyAttackCooldown: 0,
      runCosmicAsh: 0,
      extraProjectiles: 0,
      vampiric: 0,
      reflectDamage: 0,
      perkStaminaRegen: 0,
      xpPenalty: 0,
      perks: []
    };
  },

  // ✅ NEW: Calculate fire rate based on Haste stat
  getFireRate() {
    const baseFireRate = 0.2; // 5 shots per second
    const cdMultiplier = 1 - Math.min(this.stats.haste * 0.1, 0.75);
    return baseFireRate * cdMultiplier;
  },

  // ✅ NEW: Validate and clamp stats to reasonable ranges
  validateStats() {
    const clampFn = (v, min, max) => Math.max(min, Math.min(max, v));
    this.stats.might = clampFn(this.stats.might, 0, 100);
    this.stats.focus = clampFn(this.stats.focus, 0, 100);
    this.stats.grit = clampFn(this.stats.grit, 0, 100);
    this.stats.haste = clampFn(this.stats.haste, 0, 100);
    this.stats.luck = clampFn(this.stats.luck, 0, 50);
    if (this.player) {
      this.player.maxHp = clampFn(this.player.maxHp, 50, 10000);
      this.player.hp = clampFn(this.player.hp, 0, this.player.maxHp);
      this.player.maxStamina = clampFn(this.player.maxStamina, 50, 1000);
      this.player.stamina = clampFn(this.player.stamina, 0, this.player.maxStamina);
      this.player.staminaRegen = clampFn(this.player.staminaRegen, 1, 500);
      this.player.extraProjectiles = clampFn(this.player.extraProjectiles, 0, 20);
      this.player.vampiric = clampFn(this.player.vampiric, 0, 0.5);
      this.player.reflectDamage = clampFn(this.player.reflectDamage, 0, 0.5);
      this.player.xpPenalty = clampFn(this.player.xpPenalty, 0, 0.9);
    }
    console.log('✅ Stats validated and clamped');
  },

  // ✅ NEW: Reset base stats to defaults
  resetBaseStats() {
    this.baseStats = {
      level: 1,
      might: 0,
      focus: 0,
      grit: 0,
      haste: 0,
      luck: 0,
      costs: {
        might: 150,
        focus: 150,
        grit: 100,
        haste: 120,
        luck: 200
      }
    };
    this.cosmicAsh = 0;
    console.log('✅ Base stats reset to defaults');
  },
  
  // ¡NUEVO! Calcula el HP máximo
  getMaxHP() {
    // 100 base + 10 por nivel (del stat de nivel) + 10 por cada punto de Grit (de perks/items)
    return 100 + (this.stats.level * 10) + (this.stats.grit * 10);
  },
  
  // ¡NUEVO! Actualiza los stats del jugador (p.ej. al subir de nivel o coger item)
  updatePlayerStats() {
    if (!this.player) return;
    this.player.maxHp = this.getMaxHP();
    this.player.speed = this.getPlayerSpeed();
    this.player.dashCooldownTime = this.getDashCooldown();
    // La regeneración de estamina puede ser modificada por perks
    this.player.staminaRegen = GameConfig.STAMINA_REGEN + (this.player.perkStaminaRegen || 0);
  },

  // ========================================================================
  // INICIALIZACIÓN Y CONTROL DE PARTIDA
  // ========================================================================

startNewGame() {
  console.log('🎮 Game.startNewGame() called');

  // ✅ Clear any lingering timeouts from previous run
  if (typeof this.clearAllTimeouts === 'function') {
    this.clearAllTimeouts();
  }
  
  // ✅ CRITICAL: Verify canvas exists before proceeding
  const canvas = UIManager.el('game-canvas');
  if (!canvas) {
    console.error('❌ Canvas not found! Cannot start game.');
    return;
  }
  
  // ✅ Force canvas visibility
  canvas.style.display = 'block';
  canvas.style.opacity = '1';
  canvas.style.pointerEvents = 'auto';
  console.log('✅ Canvas forced visible');
  
  // Reset estado
  console.log('🔄 Resetting game state...');
  this.running = false;
  this.paused = false;
  this.enemies = [];
  this.bullets = [];
  this.items = [];
  this.inventory = [];

  // ✅ CRITICAL: Hide ALL overlays that could block canvas
  console.log('🔄 Hiding all overlays...');
  ['title-screen', 'main-menu', 'boot-sequence', 'pause', 'levelup'].forEach(id => {
    UIManager.hide(id);
  });

  // ✅ Ensure game-ui is visible (should already be from go())
  const gameUI = UIManager.el('game-ui-overlay');
  if (gameUI) {
    gameUI.classList.add('active');
    gameUI.style.display = 'block';
    console.log('✅ game-ui-overlay visible');
  }
  
  // Cargar stats base y resetear stats de la run
  this.loadBaseStats();
  this.stats = { ...this.baseStats };
  this.stats.level = 1;

  this.lastSpawnTime = 0;
  this.spawnInterval = 4;
  this.nextEnemyId = 0;

  console.log('🗺️ Generating dungeon...');
  // Generar mapa con sistema de salas
  const audioSnapshot = AudioManager.getSnapshot();
  const dungeon = DungeonGenerator.generateFromAudio(audioSnapshot);
  this.map = dungeon.map;
  this.map.rooms = dungeon.rooms;
  this.cols = dungeon.map[0].length;
  this.rows = dungeon.map.length;
  console.log(`✅ Dungeon generated: ${this.cols}x${this.rows}, ${dungeon.rooms.length} rooms`);

  // Inicializar sistema de salas
  console.log('🏠 Initializing room system...');
  this.initializeRooms();
  console.log(`✅ Rooms initialized: ${this.rooms.length} rooms`);

  // Posicionar jugador en la primera sala
  const firstRoom = this.rooms[0];
  if (!firstRoom) {
    console.error('❌ No rooms generated!');
    return;
  }
  
  const worldX = firstRoom.center.x;
  const worldY = firstRoom.center.y;
  console.log(`🎮 Player spawn: (${worldX}, ${worldY})`);

  this.player = this.createPlayer(worldX, worldY);
  this.updatePlayerStats();
  this.player.hp = this.player.maxHp;
  this.player.stamina = this.player.maxStamina;

  // Reset timers
  this.shootCooldown = 0;

  // UI
  UIManager.updateInventory();
  this.updateHubUI();
  UIManager.log('Nueva partida iniciada. Build: v2.0', 'success');

  // Iniciar loop
  console.log('🔄 Starting game loop...');
  this.running = true;
  this.lastTime = performance.now();
  requestAnimationFrame(this.loop.bind(this));
  console.log('✅ Game started successfully!');
},
  
  // ========================================================================
  // GESTIÓN DEL HUB (Meta-Progresión)
  // ========================================================================
  
  // ¡NUEVO! Actualiza la UI del Hub (costos y total)
  updateHubUI() {
    const ashDisplay = UIManager.el('hub-ash-display');
    if (ashDisplay) {
      ashDisplay.textContent = this.cosmicAsh;
    }
    
    for (const [id, cost] of Object.entries(this.baseStats.costs)) {
      const costEl = UIManager.el(`cost-${id}`);
      if (costEl) {
        costEl.textContent = cost;
      }
      // Deshabilitar botón si no hay suficiente ceniza
      const btn = document.querySelector(`#hub-upgrades button[data-upgrade="${id}"]`);
      if (btn) {
        btn.disabled = this.cosmicAsh < cost;
        btn.style.opacity = this.cosmicAsh < cost ? 0.5 : 1;
      }
    }
    
    // Actualizar stats base en la UI del Hub (si existieran)
    // p.ej. UIManager.el('hub-grit-stat').textContent = this.baseStats.grit;
  },
  
  // ¡NUEVO! Gasta Ceniza Cósmica en mejoras
  spendCosmicAsh(upgradeId) {
    if (!this.baseStats.costs[upgradeId]) return;
    
    const cost = this.baseStats.costs[upgradeId];
    
    if (this.cosmicAsh >= cost) {
      // Pagar el costo
      this.cosmicAsh -= cost;
      
      // Aplicar la mejora
      this.baseStats[upgradeId]++;
      
      // Aumentar el costo de la siguiente mejora (ej. +20%)
      this.baseStats.costs[upgradeId] = Math.floor(cost * 1.25 + 20);
      
      // Guardar
      this.saveBaseStats();
      
      // Actualizar UI
      this.updateHubUI();
      UIManager.log(`Mejora permanente: +1 ${upgradeId}`, 'success');
      
    } else {
      UIManager.log('No tienes suficiente Ceniza Cósmica', 'error');
    }
  },

  // ========================================================================
  // SPAWN DE ENTIDADES (Rediseñado)
  // ========================================================================

  spawnEnemy() {
    const maxEnemies = 20 + this.stats.level * 2;
    if (this.enemies.length >= maxEnemies) return;

    // Buscar tile de suelo alejado del jugador
    let tries = 0;
    let ex = 0, ey = 0;
    while (tries < 200) {
      const tx = Math.floor(this.rng() * this.cols);
      const ty = Math.floor(this.rng() * this.rows);
      if (this.map[ty][tx] === 0) {
        ex = tx * this.tileSize + this.tileSize / 2;
        ey = ty * this.tileSize + this.tileSize / 2;
        const dx = ex - this.player.x;
        const dy = ey - this.player.y;
        if (Math.hypot(dx, dy) > this.tileSize * 10) break;
      }
      tries++;
    }

    const types = ['grunt', 'rusher', 'shooter', 'tank'];
    const type = types[Math.floor(this.rng() * types.length)];
    const level = this.stats.level;

    const enemy = {
      id: this.nextEnemyId++,
      x: ex, y: ey,
      vx: 0, vy: 0,
      speed: 120 + level * 5,
      radius: 12,
      hp: 30 + level * 5,
      maxHp: 30 + level * 5,
      type,
      lastShot: 0,
      shotInterval: 1.5,
      damage: 5 + level,
      // ¡NUEVO! Sistema de Poise
      poise: 50 + level * 10,
      maxPoise: 50 + level * 10,
      poiseStunTime: 0
    };
    
    // Stats de enemigos por tipo
    if (type === 'tank') {
      enemy.hp *= 2;
      enemy.maxHp *= 2;
      enemy.poise *= 2;
      enemy.maxPoise *= 2;
      enemy.speed *= 0.6;
      enemy.radius = 16;
    } else if (type === 'rusher') {
      enemy.speed *= 1.4;
      enemy.poise *= 0.5;
      enemy.maxPoise *= 0.5;
    }

    this.enemies.push(enemy);
  },

  spawnItem(x, y) {
    // ¡NUEVO! Pool de 16 ítems rediseñados
    const itemPool = [
      // Común 🟢
      { name: 'Cerveza', icon: '🍺', description: 'Recarga rápida', rarity: 'common', effect: (g) => { g.player.stamina = Math.min(g.player.maxStamina, g.player.stamina + 30); } },
      { name: 'Daga afilada', icon: '🗡️', description: 'Golpe seco', rarity: 'common', effect: (g) => { g.stats.might += 1; } },
      { name: 'Batería', icon: '⚡', description: 'Regen extra (10s)', rarity: 'common', effect: (g) => { g.player.staminaRegen += 20; setTimeout(() => g.player.staminaRegen -= 20, 10000); } },
      // Raro 🟡
      { name: 'Escudo oxidado', icon: '🛡️', description: 'Bloqueo básico', rarity: 'rare', effect: (g) => { g.stats.grit += 2; } },
      { name: 'Botas livianas', icon: '💨', description: 'Dash fluido', rarity: 'rare', effect: (g) => { g.stats.haste += 1; } },
      { name: 'Lupa', icon: '🎯', description: 'Precisión', rarity: 'rare', effect: (g) => { g.stats.focus += 1; } },
      // Épico 🟣
      { name: 'Piedra foco', icon: '💎', description: 'Ráfaga', rarity: 'epic', effect: (g) => { g.stats.focus += 2; } },
      { name: 'Frasco sangre', icon: '🩸', description: 'Vampiro', rarity: 'epic', effect: (g) => { g.player.vampiric = (g.player.vampiric || 0) + 0.03; } }, // 3% lifesteal
      { name: 'Vendaval', icon: '🌪️', description: 'Knockback', rarity: 'epic', effect: (g) => { /* TODO: Lógica de knockback en dash */ } },
      // Legendario 🔴
      { name: 'Motor turbo', icon: '🚀', description: 'Hipervelocidad', rarity: 'legendary', effect: (g) => { g.stats.haste += 2; g.player.dashCooldownTime *= 0.8; } },
      { name: 'Núcleo magma', icon: '🔥', description: 'Explosión', rarity: 'legendary', effect: (g) => { /* TODO: Lógica de explosión en Heavy Attack */ } },
      { name: 'Esencia etérea', icon: '👻', description: 'Fantasma', rarity: 'legendary', effect: (g) => { g.stats.focus += 3; /* TODO: Lógica de balas perforantes */ } },
      { name: 'Amuleto maldito', icon: '⚰️', description: 'Riesgo alto', rarity: 'legendary', effect: (g) => { g.stats.might += 3; g.stats.luck = Math.max(0, g.stats.luck - 1); } },
      { name: 'Trébol cósmico', icon: '🍀', description: 'Fortuna', rarity: 'legendary', effect: (g) => { g.stats.luck += 3; /* +20% Cosmic Ash (se aplica en drop) */ } },
      { name: 'Herramienta rota', icon: '🛠️', description: 'Reparación', rarity: 'legendary', effect: (g) => { g.stats.grit += 2; g.player.maxHp += 10; g.player.hp += 10; } },
      { name: 'Estrella fugaz', icon: '🌟', description: 'Omni', rarity: 'legendary', effect: (g) => { /* TODO: Mostrar UI para elegir stat */ g.stats.might += 1; g.stats.focus += 1; } }
    ];

    // ¡NUEVO! Lógica de rareza basada en Luck
    const luckBonus = this.stats.luck * 2;
    const roll = this.rng() * (100 - luckBonus);
    
    let rarity;
    if (roll < 5) rarity = 'legendary';
    else if (roll < 20) rarity = 'epic';
    else if (roll < 45) rarity = 'rare';
    else rarity = 'common';
    
    let candidates = itemPool.filter(i => i.rarity === rarity);
    if (candidates.length === 0) candidates = itemPool.filter(i => i.rarity === 'common');
    if (candidates.length === 0) return; // No hay ítems

    const template = candidates[Math.floor(this.rng() * candidates.length)];
    const item = {
      ...template,
      x, y,
      radius: 10,
      rarity: template.rarity,
      // Redefinir 'effect' para que no sea una referencia
      effect: template.effect 
    };

    this.items.push(item);
    return item; // ✅ Devolver el ítem para poder asignar roomId
  },

  // ========================================================================
  // SISTEMA DE SALAS Y COMBATE POR HABITACIONES (Nuevo)
  // ========================================================================

  /**
   * Convierte las habitaciones generadas por el generador de dungeons en
   * salas discretas de combate. Cada sala contiene información de sus
   * límites en coordenadas de mundo, su centro y cuántos enemigos deben
   * generarse en función del nivel del jugador y el índice de la sala.
   * También inicializa el estado de la sala activa y genera los enemigos
   * iniciales para la primera sala.
   */
initializeRooms() {
  console.log('🏠 Initializing room system...');
  
  const dungeonRooms = this.map.rooms || [];
  
  if (dungeonRooms.length === 0) {
    console.error('❌ No rooms found in dungeon!');
    // ✅ Create a single large room as fallback
    const fallbackRoom = {
      x: 2,
      y: 2,
      w: this.cols - 4,
      h: this.rows - 4,
      center: {
        x: Math.floor(this.cols / 2),
        y: Math.floor(this.rows / 2)
      }
    };
    dungeonRooms.push(fallbackRoom);
    console.warn('⚠️ Created fallback room covering map');
  }
  
  // ✅ Validate and filter rooms
  this.rooms = dungeonRooms
    .filter(room => {
      const valid = (
        room.x >= 0 &&
        room.y >= 0 &&
        room.x + room.w <= this.cols &&
        room.y + room.h <= this.rows &&
        room.w > 0 &&
        room.h > 0
      );
      if (!valid) {
        console.warn(`⚠️ Skipping invalid room at (${room.x}, ${room.y})`);
      }
      return valid;
    })
    .map((room, idx) => ({
      id: idx,
      bounds: {
        x: room.x * this.tileSize,
        y: room.y * this.tileSize,
        w: room.w * this.tileSize,
        h: room.h * this.tileSize
      },
      center: {
        x: room.center.x * this.tileSize,
        y: room.center.y * this.tileSize
      },
      state: 'locked',
      enemies: [],
      enemyCount: this.calculateRoomEnemyCount(idx),
      isBoss: ((idx + 1) % 5 === 0),
      doors: []
    }));
  
  console.log(`✅ Created ${this.rooms.length} valid rooms`);
  
  // ✅ Ensure at least one room exists
  if (this.rooms.length === 0) {
    console.error('❌ CRITICAL: No valid rooms after filtering!');
    this.running = false;
    if (typeof UIManager !== 'undefined') {
      UIManager.log('Error crítico: mapa sin salas válidas', 'error');
      UIManager.go('game-ui', 'main-menu');
    }
    return;
  }
  
  // Activate first room and spawn enemies
  this.rooms[0].state = 'active';
  this.currentRoomIndex = 0;
  console.log('🎯 Spawning enemies in first room...');
  this.spawnRoomEnemies(this.rooms[0]);
  console.log(`✅ Room 0 active with ${this.rooms[0].enemies.length} enemies`);
},

  /**
   * Calcula la cantidad de enemigos que debe tener una sala dada. Se utiliza
   * un conteo base incrementado por el nivel actual del jugador y el índice
   * de la sala para aumentar progresivamente la dificultad.
   * @param {number} roomIdx Índice de la sala en la lista de habitaciones
   * @returns {number} Número de enemigos a generar
   */
  calculateRoomEnemyCount(roomIdx) {
    const baseCount = 8;
    const levelMultiplier = 1 + (this.stats.level * 0.15);
    const roomMultiplier = 1 + (roomIdx * 0.05);
    return Math.floor(baseCount * levelMultiplier * roomMultiplier);
  },

  /**
   * Genera enemigos dentro de una sala específica. Si la sala es un jefe,
   * sólo se genera un enemigo de tipo jefe; de lo contrario, se genera
   * una cantidad determinada por enemyCount. Los enemigos se posicionan
   * uniformemente en torno al centro de la sala.
   * @param {object} room La sala en la que generar enemigos
   */
  spawnRoomEnemies(room) {
    if (!room) return;
    const count = room.isBoss ? 1 : room.enemyCount;
    room.enemies = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const radius = Math.min(room.bounds.w, room.bounds.h) * 0.3;
      const ex = room.center.x + Math.cos(angle) * radius;
      const ey = room.center.y + Math.sin(angle) * radius;
      const enemy = this.createEnemy(ex, ey, room.isBoss);
      enemy.roomId = room.id;
      room.enemies.push(enemy);
      this.enemies.push(enemy);
    }
    this.roomState = 'Fight';
    UIManager.log(`Sala ${room.id + 1}: ${count} enemigos generados.`, 'info');
  },

  /**
   * Crea un enemigo con estadísticas basadas en su tipo y en el nivel
   * actual del jugador. Permite crear enemigos jefe al pasar
   * isBoss=true, lo que incrementa sus estadísticas y utiliza un tipo
   * dedicado.
   * @param {number} x Posición x en el mundo
   * @param {number} y Posición y en el mundo
   * @param {boolean} isBoss Indica si el enemigo es un jefe
   */
  createEnemy(x, y, isBoss = false) {
    const types = isBoss ? ['boss'] : ['grunt', 'rusher', 'shooter', 'tank'];
    const type = types[Math.floor(this.rng() * types.length)];
    const level = this.stats.level;
    const enemy = {
      id: this.nextEnemyId++,
      x, y,
      vx: 0, vy: 0,
      speed: type === 'boss' ? 80 : 150 + level * 8,
      radius: type === 'boss' ? 32 : 12,
      hp: type === 'boss' ? 500 + level * 100 : 30 + level * 8,
      maxHp: type === 'boss' ? 500 + level * 100 : 30 + level * 8,
      type,
      lastShot: 0,
      shotInterval: type === 'boss' ? 0.8 : 1.5,
      damage: type === 'boss' ? 25 + level * 5 : 5 + level * 2,
      poise: type === 'boss' ? 500 : 50 + level * 10,
      maxPoise: type === 'boss' ? 500 : 50 + level * 10,
      poiseStunTime: 0,
      roomId: null,
      attackCooldown: 0,
      attackRange: type === 'rusher' ? 30 : 20
    };
    // Ajustes por tipo de enemigo
    if (type === 'tank') {
      enemy.hp *= 2;
      enemy.maxHp *= 2;
      enemy.poise *= 2;
      enemy.maxPoise *= 2;
      enemy.speed *= 0.6;
      enemy.radius = 16;
    } else if (type === 'rusher') {
      enemy.speed *= 1.6;
      enemy.poise *= 0.5;
      enemy.maxPoise *= 0.5;
    }
    return enemy;
  },

  /**
   * Comprueba si la sala actual ha sido despejada de enemigos. Si es así,
   * marca la sala como completada, otorga recompensas de Ceniza Cósmica
   * y desbloquea la siguiente sala en la lista. Sólo se ejecuta cuando
   * roomState es 'Fight'.
   */
  checkRoomClear() {
    if (this.roomState !== 'Fight') return;
    const currentRoom = this.rooms[this.currentRoomIndex];
    if (!currentRoom) return;
    const activeEnemies = this.enemies.filter(e => e.roomId === currentRoom.id);
    if (activeEnemies.length === 0) {
      this.roomState = 'Clear';
      currentRoom.state = 'cleared';
      UIManager.log(`¡Sala ${currentRoom.id + 1} completada!`, 'success');
      const ashReward = currentRoom.isBoss ? 50 : 10;
      this.player.runCosmicAsh += ashReward;
      UIManager.log(`+${ashReward} Ceniza Cósmica`, 'warn');
      // Desbloquear la siguiente sala (simplificado)
      if (this.currentRoomIndex + 1 < this.rooms.length) {
        this.rooms[this.currentRoomIndex + 1].state = 'active';
      }
    }
  },

  /**
   * Realiza la transición a la siguiente sala. Sólo puede iniciarse cuando
   * roomState es 'Clear'. Cambia a estado 'Transition', muestra un efecto
   * de desvanecimiento en el canvas y mueve al jugador al centro de la
   * siguiente sala o genera un nuevo piso si se completaron todas las salas.
   */
  transitionToNextRoom() {
    if (this.roomState !== 'Clear') return;
    this.roomState = 'Transition';
    UIManager.log('Transicionando a la siguiente sala...', 'info');
    const canvas = UIManager.el('game-canvas');
    if (canvas) {
      canvas.style.transition = 'opacity 0.5s';
      canvas.style.opacity = '0.3';
    }
    setTimeout(() => {
      this.currentRoomIndex++;
      if (this.currentRoomIndex >= this.rooms.length) {
        // Generar nuevo piso al completar todas las salas
        UIManager.log('¡Piso completado! Generando siguiente nivel...', 'success');
        this.generateNewFloor();
      } else {
        const nextRoom = this.rooms[this.currentRoomIndex];
        // Teletransportar al jugador al centro de la nueva sala
        this.player.x = nextRoom.center.x;
        this.player.y = nextRoom.center.y;
        // Generar enemigos
        this.spawnRoomEnemies(nextRoom);
      }
      // Restaurar la opacidad del canvas
      if (canvas) {
        canvas.style.opacity = '1';
      }
    }, 600);
  },

  /**
   * Genera un nuevo piso del dungeon a partir del audio actual. Reinicia
   * el mapa, recalcula sus dimensiones, reinicia el sistema de salas y
   * coloca al jugador en la primera sala.
   */
  generateNewFloor() {
    const audioSnapshot = AudioManager.getSnapshot();
    const dungeon = DungeonGenerator.generateFromAudio(audioSnapshot);
    this.map = dungeon.map;
    if (dungeon.rooms) {
      this.map.rooms = dungeon.rooms;
    }
    this.cols = dungeon.width || (dungeon.map ? dungeon.map[0].length : 0);
    this.rows = dungeon.height || (dungeon.map ? dungeon.map.length : 0);
    // Reiniciar salas
    this.initializeRooms();
    // Teletransportar al jugador a la primera sala
    const firstRoom = this.rooms[0];
    if (firstRoom) {
      this.player.x = firstRoom.center.x;
      this.player.y = firstRoom.center.y;
    }
    UIManager.log('Nuevo piso generado. ¡Adelante!', 'success');
  },

  // ========================================================================
  // SISTEMA DE PERKS Y LEVEL UP (Rediseñado)
  // ========================================================================

  checkLevelUp() {
    const p = this.player;
    if (p.xp >= p.xpNext) {
      this.stats.level++;
      p.xp -= p.xpNext;
      p.xpNext = Math.floor(p.xpNext * 1.5 + 50);
      this.updatePlayerStats(); // Actualizar maxHp por nivel
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.25); // Curar 25% al subir
      
      UIManager.log(`¡Nivel ${this.stats.level}!`, 'success');
      
      const perks = this.getRandomPerks(3);
      this.pauseForLevelUp();
      UIManager.showPerkSelection(perks);
      // Mostrar directamente la superposición de nivel
      UIManager.show('levelup'); // ✅ Mostrar overlay de subida de nivel
    }
  },

  getRandomPerks(count) {
    // ¡NUEVO! Pool de 20 perks rediseñados con badges
    const pool = [
      // 🟢 Común
      { title: 'Proyectiles extra', badge: '🔴', rarity: 'common', description: '+0.5 Proyectiles. +1 Focus.', effect: (g) => { g.stats.focus += 1; g.player.extraProjectiles += 0.5; } },
      { title: 'Corazón resistente', badge: '🟢', rarity: 'common', description: '+15 HP max.', effect: (g) => { g.stats.grit += 1; g.updatePlayerStats(); } }, // Grit da 10, +5 extra
      { title: 'Paso ligero', badge: '🔵', rarity: 'common', description: '+10% velocidad mov.', effect: (g) => { g.stats.haste += 2; g.updatePlayerStats(); } }, // +8% de 2 Haste, +2% extra
      // 🟡 Raro
      { title: 'Maestro dash', badge: '🔵', rarity: 'rare', description: 'Dash CD -25%. +1 Haste.', effect: (g) => { g.stats.haste += 1; g.player.dashCooldownTime *= 0.75; } },
      { title: 'Recarga vampírica', badge: '🔴', rarity: 'rare', description: 'Disparos curan 5% del daño.', effect: (g) => { g.player.vampiric = (g.player.vampiric || 0) + 0.05; } },
      { title: 'Poise breaker', badge: '🟢', rarity: 'rare', description: 'Heavy Attack +50% daño a poise.', effect: (g) => { /* Lógica en fireHeavyAttack */ } },
      { title: 'Velocidad borracha', badge: '🔵', rarity: 'rare', description: '+25% vel, -1 Might.', effect: (g) => { g.stats.haste += 5; g.stats.might = Math.max(0, g.stats.might - 1); g.updatePlayerStats(); } },
      // 🟣 Épico
      { title: 'Exceso cafeína', badge: '🔴', rarity: 'epic', description: '+10 Regen Stamina, XP gain -15%.', effect: (g) => { g.player.perkStaminaRegen += 10; g.player.xpPenalty = (g.player.xpPenalty || 0) + 0.15; } },
      { title: 'Suerte diablo', badge: '🟣', rarity: 'epic', description: 'x2 Luck, enemigos +15 HP.', effect: (g) => { g.stats.luck *= 2; g.enemies.forEach(e => { e.hp += 15; e.maxHp += 15; }); } },
      { title: 'Dash explosivo', badge: '🔵', rarity: 'epic', description: 'Dash rompe poise en AoE.', effect: (g) => { /* Lógica en updatePlayer (dash) */ } },
      { title: 'Balas homing', badge: '🔴', rarity: 'epic', description: 'Projs buscan 20%.', effect: (g) => { /* Lógica en update (bullets) */ } },
      { title: 'Armadura reflect', badge: '🟢', rarity: 'epic', description: '10% daño reflejado.', effect: (g) => { g.player.reflectDamage = (g.player.reflectDamage || 0) + 0.1; } },
      // 🔴 Legendario
      { title: 'Corazón titanio', badge: '🟢', rarity: 'legendary', description: '+30 HP, cura full. +2 Grit.', effect: (g) => { g.stats.grit += 2; g.updatePlayerStats(); g.player.hp = g.player.maxHp; } },
      { title: 'Tormenta eterna', badge: '🔴', rarity: 'legendary', description: '+1 projs, +2 Focus.', effect: (g) => { g.player.extraProjectiles += 1; g.stats.focus += 2; } },
      { title: 'Fantasma invencible', badge: '🔵', rarity: 'legendary', description: 'Dash i-frames +0.2s.', effect: (g) => { g.player.dashDuration += 0.2; } },
      { title: 'Poise infinito', badge: '🟢', rarity: 'legendary', description: '+50 poise jugador.', effect: (g) => { /* Lógica en playerTakeDamage */ } },
      { title: 'Multihit heavy', badge: '🔴', rarity: 'legendary', description: 'Spell: 3 hits rápidos.', effect: (g) => { /* Lógica en fireHeavyAttack */ } },
      { title: 'Economía cósmica', badge: '🟣', rarity: 'legendary', description: '+25% Cosmic Ash, +1 Luck.', effect: (g) => { g.stats.luck += 1; /* Lógica en drop de ceniza */ } },
      { title: 'Hiperhaste', badge: '🔵', rarity: 'legendary', description: '+2 Haste, AS +20%.', effect: (g) => { g.stats.haste += 2; g.updatePlayerStats(); /* Lógica en fireBullet */ } },
      { title: 'Apocalipsis', badge: '🟣', rarity: 'legendary', description: 'Elige 2 stats +1.', effect: (g) => { /* TODO: UI para elegir 2 stats */ g.stats.might++; g.stats.focus++; } }
    ];

    const results = [];
    const available = [...pool]; // Copiar pool para poder eliminar
    
    for (let i = 0; i < count; i++) {
      if (available.length === 0) break;
      
      const weights = available.map(p => {
        const base = {
          common: 1,
          rare: 0.7,
          epic: 0.4,
          legendary: 0.2
        }[p.rarity];
        return base + this.stats.luck * 0.02; // Luck aumenta chance de rarezas
      });

      const total = weights.reduce((a, b) => a + b, 0);
      const rnd = this.rng() * total;
      
      let acc = 0;
      let chosenIndex = 0;
      for (let j = 0; j < available.length; j++) {
        acc += weights[j];
        if (rnd <= acc) {
          chosenIndex = j;
          break;
        }
      }

      const perk = available.splice(chosenIndex, 1)[0];
      results.push(perk);
    }

    return results;
  },

  applyPerk(perk) {
    if (perk && typeof perk.effect === 'function') {
      perk.effect(this);
      UIManager.log(`Perk: ${perk.title}`, 'success');
      // ✅ Validate and clamp stats after applying
      if (typeof this.validateStats === 'function') {
        this.validateStats();
      }
      this.updatePlayerStats();
    }
  },

  pauseForLevelUp() {
    this.paused = true;
  },

  resumeFromLevelUp() {
    this.paused = false;
  },

  // ========================================================================
  // LOOP PRINCIPAL
  // ========================================================================

loop(now) {
  // ✅ Verify game is still running
  if (!this.running) {
    console.log('⏸️ Game loop stopped (running = false)');
    return; // Exit completely, don't schedule another frame
  }
  
  // ✅ Verify player exists
  if (!this.player) {
    console.error('❌ Game loop: player not initialized! Stopping game.');
    this.running = false;
    if (typeof UIManager !== 'undefined') {
      UIManager.log('Error crítico: jugador no inicializado', 'error');
    }
    return; // Exit completely
  }

  const dt = (now - this.lastTime) / 1000;
  this.lastTime = now;
  
  // Cap delta time to prevent physics explosions
  const cappedDt = Math.min(dt, 0.1);

  // Procesar input de gamepad
  if (GamepadManager.active) {
    GamepadManager.poll(cappedDt);
  }

  // Componer input de teclado/mouse
  this.composeKeyboardMouseInput();

  // Update y render (solo si no está pausado)
  if (!this.paused) {
    this.update(cappedDt);
    this.draw();
    this.drawHUD();
  }

  // Actualizar HUD
  UIManager.updateHUD();

  requestAnimationFrame(this.loop.bind(this));
},

  // ========================================================================
  // UPDATE (Rediseñado con Estamina y Poise)
  // ========================================================================

  update(dt) {
    // Guardar dt para uso en draw (p.ej. popups de daño)
    this.lastDt = dt;
    // Actualizar jugador
    this.updatePlayer(dt);

    // Actualizar enemigos sólo en la sala actual
    const currentRoom = this.rooms[this.currentRoomIndex];
    if (currentRoom) {
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        // Saltar enemigos que pertenecen a otras salas
        if (e.roomId !== currentRoom.id) continue;
        this.updateEnemy(e, dt);
        if (e.hp <= 0) {
          // Drop item (ahora sala-consciente)
          if (this.rng() < 0.4) {
            const item = this.spawnItem(e.x, e.y);
            if (item) {
              item.roomId = e.roomId;
            }
          }
          // Drop de Ceniza Cósmica
          let ashDrop = 0;
          if (this.rng() < (0.05 + this.stats.luck * 0.01)) {
            ashDrop = randInt(1, 3);
          }
          const perkBonus = Game.player.perks?.includes('Economía cósmica') ? 1.25 : 1;
          ashDrop = Math.ceil(ashDrop * (1 + this.stats.luck * 0.05) * perkBonus);
          if (ashDrop > 0) {
            this.player.runCosmicAsh += ashDrop;
            UIManager.log(`+${ashDrop} Ceniza Cósmica!`, 'warn');
          }
          // XP
          const xpGain = 10 + this.stats.level;
          const penalty = this.player.xpPenalty || 0;
          this.player.xp += xpGain * (1 - penalty);
          // Eliminar enemigo
          this.enemies.splice(i, 1);
        }
      }
    }
    // Verificar si la sala se ha despejado
    this.checkRoomClear();

    // Comprobar subida de nivel
    this.checkLevelUp();

    // ===========================
    // Actualizar balas (optimizado)
    // ===========================
    const survivingBullets = [];
    // Determine current room for bullet collision
    const currentRoomBullets = this.rooms ? this.rooms[this.currentRoomIndex] : null;
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      let bulletAlive = true;
      // Mover bala
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.lifetime -= dt;
      // Verificar expiración o colisión con paredes y void
      const tx = Math.floor(b.x / this.tileSize);
      const ty = Math.floor(b.y / this.tileSize);
      const tile = (tx >= 0 && ty >= 0 && tx < this.cols && ty < this.rows) ? this.map[ty][tx] : 1;
      if (b.lifetime <= 0 || tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows || tile === 1 || tile === 3) {
        bulletAlive = false;
      }
      // Procesar colisiones si la bala sigue viva
      if (bulletAlive && currentRoomBullets) {
        if (!b.isEnemy) {
          // Balas del jugador vs enemigos
          for (let j = this.enemies.length - 1; j >= 0; j--) {
            const e = this.enemies[j];
            if (e.roomId !== currentRoomBullets.id) continue;
            const dx = e.x - b.x;
            const dy = e.y - b.y;
            if (Math.hypot(dx, dy) < e.radius + b.radius) {
              this.enemyTakeDamage(e, b.damage, b.poiseDamage || 0);
              // Lifesteal
              if (this.player.vampiric > 0) {
                const heal = b.damage * this.player.vampiric;
                this.player.hp = Math.min(this.player.maxHp, this.player.hp + heal);
              }
              bulletAlive = false;
              break;
            }
          }
        } else {
          // Balas de enemigos vs jugador
          const p = this.player;
          const dx = p.x - b.x;
          const dy = p.y - b.y;
          if (Math.hypot(dx, dy) < p.radius + b.radius) {
            this.playerTakeDamage(b.damage);
            bulletAlive = false;
          }
        }
      }
      // Conservar bala si aún está viva
      if (bulletAlive) {
        survivingBullets.push(b);
      }
    }
    // Reemplazar array en una sola operación
    this.bullets = survivingBullets;

    // ===========================
    // Actualizar ítems (sólo en sala actual)
    // ===========================
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      // Ignorar ítems que no pertenezcan a la sala actual
      if (item.roomId && currentRoom && item.roomId !== currentRoom.id) continue;
      const dx = this.player.x - item.x;
      const dy = this.player.y - item.y;
      if (Math.hypot(dx, dy) < this.player.radius + item.radius) {
        item.effect(this);
        // Añadir a inventario o incrementar contador
        const found = this.inventory.find(it => it.name === item.name);
        if (found) {
          found.count += 1;
        } else {
          this.inventory.push({
            name: item.name,
            icon: item.icon,
            description: item.description,
            rarity: item.rarity,
            count: 1
          });
        }
        this.updatePlayerStats();
        UIManager.updateInventory();
        UIManager.log(`Recogido: ${item.name}`, 'success');
        this.items.splice(i, 1);
      }
    }
    // Actualizar pantallas de HUD relativas a la sala
    if (UIManager.updateRoomDisplay) {
      UIManager.updateRoomDisplay();
    }
  },

  updatePlayer(dt) {
    const p = this.player;
    if (!p) return;

    // 1) Movimiento
    let ax = this.input.moveX || 0;
    let ay = this.input.moveY || 0;

    // Fallback a teclado si gamepad no activo
    if (Math.abs(ax) < 0.001 && Math.abs(ay) < 0.001) {
      if (this.keys['w'] || this.keys['arrowup']) ay -= 1;
      if (this.keys['s'] || this.keys['arrowdown']) ay += 1;
      if (this.keys['a'] || this.keys['arrowleft']) ax -= 1;
      if (this.keys['d'] || this.keys['arrowright']) ax += 1;
    }

    const len = Math.hypot(ax, ay);
    if (len > 0) { ax /= len; ay /= len; }

    const speed = this.getPlayerSpeed();
    const accel = speed * 8; // ✅ Mayor aceleración para movimiento responsivo
    const friction = 0.88;   // ✅ Fricción más ligera para desaceleración
    if (!p.isDashing) {
      // ✅ Movimiento basado en aceleración
      p.vx += ax * accel * dt;
      p.vy += ay * accel * dt;
      // Aplicar fricción
      p.vx *= friction;
      p.vy *= friction;
      // Limitar a velocidad máxima
      const vlen = Math.hypot(p.vx, p.vy);
      if (vlen > speed) {
        p.vx = (p.vx / vlen) * speed;
        p.vy = (p.vy / vlen) * speed;
      }
    }

    // 2) Dash (✅ FIXED!)
    p.dashCooldown -= dt;
    if (p.dashCooldown < 0) p.dashCooldown = 0;
    p.dashTime -= dt;
    if (p.isDashing && p.dashTime <= 0) {
      p.isDashing = false;
    }
    const wantsDash = this.input.dash;
    if (wantsDash) {
      // ✅ Always reset dash input immediately
      this.input.dash = false;
      if (!p.isDashing && p.dashCooldown <= 0) {
        if (p.stamina >= GameConfig.DASH_COST) {
          p.stamina -= GameConfig.DASH_COST;
          let dx = ax, dy = ay;
          if (dx === 0 && dy === 0) {
            const ang = this.getAimAngle();
            dx = Math.cos(ang);
            dy = Math.sin(ang);
          }
          const n = Math.hypot(dx, dy) || 1;
          p.vx = (dx / n) * p.dashSpeed;
          p.vy = (dy / n) * p.dashSpeed;
          p.isDashing = true;
          p.dashTime = p.dashDuration;
          p.dashCooldown = this.getDashCooldown();
          p.invulnTime = p.dashDuration + 0.1;
          UIManager.log('¡Dash!', 'info');
        } else {
          // ✅ Feedback when not enough stamina
          UIManager.log('Sin stamina para dash', 'warn');
        }
      }
    }

    // 3) Disparo (✅ FIXED!)
    this.shootCooldown -= dt;
    const wantsShoot = this.input.shoot; // Input continuo
    if (wantsShoot && this.shootCooldown <= 0) {
      this.fireBullet(); // fireBullet ahora chequea estamina
      this.shootCooldown = this.getFireRate(); // ✅ Use calculated rate
    }
    
    // 4) Heavy Attack (¡NUEVO!)
    p.heavyAttackCooldown -= dt;
    const wantsHeavy = this.input.heavyAttack; // Input de 1 frame
    if (wantsHeavy && p.heavyAttackCooldown <= 0 && p.stamina >= GameConfig.HEAVY_COST) {
      p.stamina -= GameConfig.HEAVY_COST;
      this.fireHeavyAttack();
      p.heavyAttackCooldown = 1.0; // TODO: Basar en Haste
    }
    this.input.heavyAttack = false; // Resetear input

    // 5) Física y Colisiones
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    // ... (lógica de colisión con paredes) ...
    const r = p.radius;
    if (this.isWall(p.x, p.y - p.vy * dt, r)) {
      p.x -= p.vx * dt; p.vx = 0;
    }
    if (this.isWall(p.x - p.vx * dt, p.y, r)) {
      p.y -= p.vy * dt; p.vy = 0;
    }
    // ✅ Restringir movimiento a los límites de la sala actual (o del dungeon si no hay sala)
    const currentRoom = this.rooms ? this.rooms[this.currentRoomIndex] : null;
    if (currentRoom) {
      const bounds = currentRoom.bounds;
      p.x = clamp(p.x, bounds.x + r, bounds.x + bounds.w - r);
      p.y = clamp(p.y, bounds.y + r, bounds.y + bounds.h - r);
    } else {
      p.x = clamp(p.x, r, this.cols * this.tileSize - r);
      p.y = clamp(p.y, r, this.rows * this.tileSize - r);
    }

    // 6) Invulnerabilidad
    p.invulnTime -= dt;
    if (p.invulnTime < 0) p.invulnTime = 0;

    // 7) Regeneración (¡MODIFICADO!)
    p.stamina = Math.min(p.maxStamina, p.stamina + p.staminaRegen * dt);

    // 8) Colisión con enemigos (solo en la sala actual)
    if (p.invulnTime <= 0) {
      const currentRoom = this.rooms ? this.rooms[this.currentRoomIndex] : null;
      for (const e of this.enemies) {
        // Ignorar enemigos de otras salas
        if (currentRoom && e.roomId !== currentRoom.id) continue;
        const dx = p.x - e.x;
        const dy = p.y - e.y;
        if (Math.hypot(dx, dy) < p.radius + e.radius) {
          this.playerTakeDamage(e.damage);
          if (p.hp <= 0) return; // Salir si el jugador muere
        }
      }
    }
  },

  isWall(x, y, radius) {
    const minX = Math.floor((x - radius) / this.tileSize);
    const maxX = Math.floor((x + radius) / this.tileSize);
    const minY = Math.floor((y - radius) / this.tileSize);
    const maxY = Math.floor((y + radius) / this.tileSize);

    if (minX < 0 || minY < 0 || maxX >= this.cols || maxY >= this.rows) {
      return true;
    }
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        const tile = this.map[ty][tx];
        if (tile === 1 || tile === 3) return true; // Pared o void
      }
    }
    return false;
  },
  
  // ¡NUEVO! Lógica de recibir daño del jugador
  playerTakeDamage(incomingDamage) {
    const p = this.player;
    if (p.invulnTime > 0) return; // Invencible (dash, etc)
    
    // 1. Aplicar Reducción de Daño (Grit)
    const damageReduction = 1 + this.stats.grit * 0.05; // 5% DR por punto
    const actualDamage = incomingDamage / damageReduction;
    
    p.hp -= actualDamage;
    p.invulnTime = 0.6; // Cooldown de invencibilidad post-golpe
    UIManager.log(`¡Daño! -${Math.round(actualDamage)} HP`, 'error');
    
    // 2. Lógica de reflejar daño
    if (p.reflectDamage > 0) {
      // TODO: Encontrar enemigo que golpeó y aplicarle p.reflectDamage * actualDamage
    }
    
    // 3. Chequear muerte
    if (p.hp <= 0) {
      this.gameOver();
      return;
    }
  },
  
  // ¡NUEVO! Lógica de recibir daño del enemigo
  enemyTakeDamage(enemy, damage, poiseDamage) {
    // Aplicar daño y mostrar número flotante
    enemy.hp -= damage;
    // Guardar para popup de daño
    enemy.lastDamage = damage;
    enemy.damagePopupTime = 0.5;
    // Sólo aplicar daño de poise si no está ya aturdido
    if (enemy.poiseStunTime <= 0) {
      enemy.poise -= poiseDamage;
      if (enemy.poise <= 0) {
        // Poise roto: aplicar stun y efecto visual
        enemy.poiseStunTime = 1.5;
        enemy.poise = enemy.maxPoise;
        enemy.poiseBreakEffect = true;
        setTimeout(() => {
          enemy.poiseBreakEffect = false;
        }, 300);
        UIManager.log('¡Poise roto!', 'warn');
      }
    }
  },

  updateEnemy(e, dt) {
    // ¡NUEVO! Chequeo de stun por poise
    if (e.poiseStunTime > 0) {
      e.poiseStunTime -= dt;
      e.vx = 0; // Detener movimiento
      e.vy = 0;
      return; // No hacer nada más si está aturdido
    }
  
    const dx = this.player.x - e.x;
    const dy = this.player.y - e.y;
    const dist = Math.hypot(dx, dy);

    let ax = dx / (dist || 1);
    let ay = dy / (dist || 1);

    // Shooters mantienen distancia
    if (e.type === 'shooter' && dist < this.tileSize * 8) {
      ax = 0;
      ay = 0;
      e.lastShot += dt;
      if (e.lastShot >= e.shotInterval) {
        e.lastShot = 0;
        const ang = Math.atan2(dy, dx);
        const speed = 250;
        // ✅ Telegraph: indicar que está cargando el disparo
        e.charging = true;
        setTimeout(() => { e.charging = false; }, 200);
        this.bullets.push({
          x: e.x + Math.cos(ang) * (e.radius + 5),
          y: e.y + Math.sin(ang) * (e.radius + 5),
          vx: Math.cos(ang) * speed,
          vy: Math.sin(ang) * speed,
          radius: 6,
          damage: e.damage,
          isEnemy: true,
          lifetime: 3.0
        });
      }
    }

    // ✅ Lógica de ataque cuerpo a cuerpo para grunt/rusher/tank
    if ((e.type === 'grunt' || e.type === 'rusher' || e.type === 'tank') && dist < e.attackRange) {
      e.attackCooldown -= dt;
      if (e.attackCooldown <= 0) {
        e.attackCooldown = e.type === 'rusher' ? 0.8 : 1.5;
        // Telegraph: indicador visual de ataque
        e.attacking = true;
        setTimeout(() => { e.attacking = false; }, 300);
        // Aplicar daño después de una breve demora para dar tiempo al jugador de reaccionar
        setTimeout(() => {
          const finalDist = Math.hypot(this.player.x - e.x, this.player.y - e.y);
          if (finalDist < e.attackRange) {
            this.playerTakeDamage(e.damage);
          }
        }, 150);
      }
    }

    // Ajustar multiplicadores de velocidad según el tipo
    let speedMult = 1;
    if (e.type === 'rusher') speedMult = 2.0;
    else if (e.type === 'tank') speedMult = 0.7;
    else if (e.type === 'boss') speedMult = 0.9;
    // Mayor aceleración base
    const accel = e.speed * 3.5;
    e.vx += ax * accel * dt * speedMult;
    e.vy += ay * accel * dt * speedMult;
    // Fricción más suave para mayor respuesta
    e.vx *= 0.92;
    e.vy *= 0.92;
    // Limitar velocidad máxima
    const maxSpeed = e.speed * speedMult;
    const len = Math.hypot(e.vx, e.vy);
    if (len > maxSpeed) {
      e.vx = e.vx / len * maxSpeed;
      e.vy = e.vy / len * maxSpeed;
    }

    // Mover y evitar paredes
    const nextX = e.x + e.vx * dt;
    const nextY = e.y + e.vy * dt;
    if (!this.isWall(nextX, e.y, e.radius)) { e.x = nextX; } else { e.vx = -e.vx * 0.3; }
    if (!this.isWall(e.x, nextY, e.radius)) { e.y = nextY; } else { e.vy = -e.vy * 0.3; }
  },

  getAimAngle() {
    // Auto-aim hacia enemigo más cercano
    if (this.autoAim) {
      let nearest = null, minDist = Infinity;
      for (const e of this.enemies) {
        const d2 = Math.hypot(e.x - this.player.x, e.y - this.player.y);
        if (d2 < minDist) { minDist = d2; nearest = e; }
      }
      if (nearest) {
        return Math.atan2(nearest.y - this.player.y, nearest.x - this.player.x);
      }
    }

    // Puntero unificado (mouse o R-Stick)
    const cx = this.input.cursorX != null ? this.input.cursorX : (this.mousePos?.x ?? window.innerWidth / 2);
    const cy = this.input.cursorY != null ? this.input.cursorY : (this.mousePos?.y ?? window.innerHeight / 2);
    const worldX = this.camera.x + cx;
    const worldY = this.camera.y + cy;
    return Math.atan2(worldY - this.player.y, worldX - this.player.x);
  },

  fireBullet() {
    // ¡NUEVO! Chequeo de estamina
    if (this.player.stamina < GameConfig.SHOOT_COST) {
      // No disparar si no hay estamina (o implementar "soft fail")
      return; 
    }
    this.player.stamina -= GameConfig.SHOOT_COST;
  
    const ang = this.getAimAngle();
    
    // ¡NUEVO! Fórmulas de stats
    const baseDmg = 10 + this.stats.might * 2;
    const finalDmg = baseDmg * (1 + this.stats.focus * 0.1);
    const poiseDmg = finalDmg * 0.1; // Balas hacen 10% de su daño como poise
    
    const count = Math.floor(1 + this.stats.focus * 0.5 + this.player.extraProjectiles);
    const speed = 500 * (1 + this.stats.focus * 0.05);
    
    // ¡NUEVO! Soft fail: si la estamina es 0, el spread aumenta
    const spread = this.player.stamina <= 0 ? 0.4 : 0.1;

    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * spread;
      const dir = ang + offset;

      this.bullets.push({
        x: this.player.x + Math.cos(dir) * (this.player.radius + 5),
        y: this.player.y + Math.sin(dir) * (this.player.radius + 5),
        vx: Math.cos(dir) * speed,
        vy: Math.sin(dir) * speed,
        radius: 4,
        damage: finalDmg,
        poiseDamage: poiseDmg,
        lifetime: 2.0,
        isEnemy: false
      });
    }
  },
  
  // ¡NUEVO! Ataque Pesado (Spell)
  fireHeavyAttack() {
    const ang = this.getAimAngle();
    
    const baseDmg = 30 + this.stats.might * 3;
    const finalDmg = baseDmg * (1 + this.stats.focus * 0.1);
    const poiseDmg = 100 + finalDmg * 0.5; // Alto daño de poise
    
    this.bullets.push({
      x: this.player.x + Math.cos(ang) * (this.player.radius + 5),
      y: this.player.y + Math.sin(ang) * (this.player.radius + 5),
      vx: Math.cos(ang) * 300, // Más lento
      vy: Math.sin(ang) * 300,
      radius: 10, // Más grande
      damage: finalDmg,
      poiseDamage: poiseDmg,
      lifetime: 2.0,
      isEnemy: false,
      color: '#ff6a00' // Color distintivo
    });
    
    UIManager.log('¡Ataque Pesado!', 'warn');
  },

  // ========================================================================
  // RENDER
  // ========================================================================

  draw() {
    const canvas = UIManager.el('game-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Actualizar cámara siguiendo al jugador con restricciones de sala
    this.camera.x = this.player.x - w / 2;
    this.camera.y = this.player.y - h / 2;
    const currentRoom = this.rooms ? this.rooms[this.currentRoomIndex] : null;
    if (currentRoom) {
      const roomBounds = currentRoom.bounds;
      const minX = roomBounds.x;
      const minY = roomBounds.y;
      const maxX = roomBounds.x + roomBounds.w - w;
      const maxY = roomBounds.y + roomBounds.h - h;
      this.camera.x = clamp(this.camera.x, minX, Math.max(minX, maxX));
      this.camera.y = clamp(this.camera.y, minY, Math.max(minY, maxY));
    } else {
      // Fallback: delimitar a todo el dungeon
      const maxX = this.cols * this.tileSize - w;
      const maxY = this.rows * this.tileSize - h;
      this.camera.x = clamp(this.camera.x, 0, Math.max(0, maxX));
      this.camera.y = clamp(this.camera.y, 0, Math.max(0, maxY));
    }

    // Limpiar pantalla
    ctx.fillStyle = '#0c1119';
    ctx.fillRect(0, 0, w, h);

    // Dibujar tiles (optimizado: sólo la sala actual + borde de 1 tile)
    const currentRoomForTiles = this.rooms ? this.rooms[this.currentRoomIndex] : null;
    if (currentRoomForTiles) {
      const roomBounds = currentRoomForTiles.bounds;
      const startCol = Math.max(0, Math.floor(roomBounds.x / this.tileSize) - 1);
      const endCol = Math.min(this.cols - 1, Math.floor((roomBounds.x + roomBounds.w) / this.tileSize) + 1);
      const startRow = Math.max(0, Math.floor(roomBounds.y / this.tileSize) - 1);
      const endRow = Math.min(this.rows - 1, Math.floor((roomBounds.y + roomBounds.h) / this.tileSize) + 1);
      for (let y = startRow; y <= endRow; y++) {
        for (let x = startCol; x <= endCol; x++) {
          const tile = this.map[y][x];
          const screenX = x * this.tileSize - this.camera.x;
          const screenY = y * this.tileSize - this.camera.y;
          if (tile === 1) {
            // Pared
            ctx.fillStyle = '#0c1833';
            ctx.fillRect(screenX, screenY, this.tileSize, this.tileSize);
          } else if (tile === 0) {
            // Piso
            ctx.fillStyle = '#1d5ea8';
            ctx.fillRect(screenX, screenY, this.tileSize, this.tileSize);
            ctx.strokeStyle = 'rgba(0,242,255,0.35)';
            ctx.strokeRect(screenX, screenY, this.tileSize, this.tileSize);
          } else if (tile === 3) {
            // Void (hoyo/abismo)
            ctx.fillStyle = '#000000';
            ctx.fillRect(screenX, screenY, this.tileSize, this.tileSize);
          }
        }
      }
    } else {
      // Fallback: dibujar toda el área visible del dungeon (depuración)
      const startCol = Math.floor(this.camera.x / this.tileSize) - 1;
      const endCol = Math.floor((this.camera.x + w) / this.tileSize) + 1;
      const startRow = Math.floor(this.camera.y / this.tileSize) - 1;
      const endRow = Math.floor((this.camera.y + h) / this.tileSize) + 1;
      for (let y = startRow; y <= endRow; y++) {
        if (y < 0 || y >= this.rows) continue;
        for (let x = startCol; x <= endCol; x++) {
          if (x < 0 || x >= this.cols) continue;
          const tile = this.map[y][x];
          const screenX = x * this.tileSize - this.camera.x;
          const screenY = y * this.tileSize - this.camera.y;
          if (tile === 1) {
            // Pared
            ctx.fillStyle = '#0c1833';
            ctx.fillRect(screenX, screenY, this.tileSize, this.tileSize);
          } else if (tile === 0) {
            // Piso
            ctx.fillStyle = '#1d5ea8';
            ctx.fillRect(screenX, screenY, this.tileSize, this.tileSize);
            ctx.strokeStyle = 'rgba(0,242,255,0.35)';
            ctx.strokeRect(screenX, screenY, this.tileSize, this.tileSize);
          } else if (tile === 3) {
            // Void (hoyo/abismo)
            ctx.fillStyle = '#000000';
            ctx.fillRect(screenX, screenY, this.tileSize, this.tileSize);
          }
        }
      }
    }

    // Dibujar items
    for (const item of this.items) {
      const screenX = item.x - this.camera.x;
      const screenY = item.y - this.camera.y;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(screenX, screenY, item.radius + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '24px "Press Start 2P"';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const rarityColors = { common: '#6a6a6a', rare: '#009dff', epic: '#9d00ff', legendary: '#ff6a00' };
      ctx.fillStyle = rarityColors[item.rarity] || '#ccc';
      ctx.fillText(item.icon, screenX, screenY);
    }

    // Dibujar balas
    for (const b of this.bullets) {
      ctx.fillStyle = b.color || (b.isEnemy ? '#ff2a6d' : '#00e0ff');
      ctx.beginPath();
      ctx.arc(b.x - this.camera.x, b.y - this.camera.y, b.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Dibujar enemigos
    for (const e of this.enemies) {
      const screenX = e.x - this.camera.x;
      const screenY = e.y - this.camera.y;
      // ✅ Visualizar estados: stun, ataque, carga
      if (e.poiseStunTime > 0) {
        ctx.fillStyle = '#ffffff';
      } else if (e.attacking) {
        ctx.fillStyle = '#ff0000'; // Rojo durante ataque melee
      } else if (e.charging) {
        ctx.fillStyle = '#ffff00'; // Amarillo durante carga de disparo
      } else {
        const enemyColors = {
          grunt: '#ff2a6d',
          rusher: '#ffb300',
          shooter: '#009dff',
          tank: '#9d00ff',
          boss: '#ff0000'
        };
        ctx.fillStyle = enemyColors[e.type] || '#ff2a6d';
      }
      // Boss: contorno con pulso
      if (e.type === 'boss') {
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 3 + Math.sin(Date.now() / 200) * 1;
        ctx.beginPath();
        ctx.arc(screenX, screenY, e.radius + 8, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === 'tank') {
        // Tank: borde cuadrado
        ctx.strokeStyle = '#9d00ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(screenX - e.radius, screenY - e.radius, e.radius * 2, e.radius * 2);
      } else if (e.type === 'rusher') {
        // Rusher: líneas de velocidad
        ctx.strokeStyle = 'rgba(255, 179, 0, 0.5)';
        ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) {
          const offset = 20 + i * 10;
          ctx.beginPath();
          ctx.moveTo(screenX - offset, screenY);
          ctx.lineTo(screenX - offset + 8, screenY);
          ctx.stroke();
        }
      } else if (e.type === 'shooter') {
        // Shooter: retícula de puntería
        ctx.strokeStyle = '#009dff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(screenX, screenY, e.radius + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(screenX - 10, screenY);
        ctx.lineTo(screenX + 10, screenY);
        ctx.moveTo(screenX, screenY - 10);
        ctx.lineTo(screenX, screenY + 10);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(screenX, screenY, e.radius, 0, Math.PI * 2);
      ctx.fill();
      // Barra de HP
      const barW = e.radius * 2;
      const hpPct = e.hp / e.maxHp;
      ctx.fillStyle = '#55111a';
      ctx.fillRect(screenX - e.radius, screenY - e.radius - 12, barW, 4);
      ctx.fillStyle = '#ff4964';
      ctx.fillRect(screenX - e.radius, screenY - e.radius - 12, barW * hpPct, 4);
      // Barra de Poise
      if (e.poiseStunTime <= 0) {
        const poisePct = e.poise / e.maxPoise;
        ctx.fillStyle = '#554400';
        ctx.fillRect(screenX - e.radius, screenY - e.radius - 6, barW, 4);
        ctx.fillStyle = '#ffb300';
        ctx.fillRect(screenX - e.radius, screenY - e.radius - 6, barW * poisePct, 4);
      }
      // ✅ Popup de daño flotante
      if (e.damagePopupTime > 0) {
        const dt = this.lastDt || 0.016;
        e.damagePopupTime -= dt;
        const popupY = screenY - e.radius - 30 - (0.5 - e.damagePopupTime) * 40;
        const opacity = Math.max(0, e.damagePopupTime * 2);
        ctx.fillStyle = `rgba(255,255,255,${opacity})`;
        ctx.font = 'bold 16px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(`-${Math.ceil(e.lastDamage)}`, screenX, popupY);
      }
      // ✅ Efecto visual cuando se rompe el poise
      if (e.poiseBreakEffect) {
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(screenX, screenY, e.radius + 10, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Dibujar jugador
    const px = this.player.x - this.camera.x;
    const py = this.player.y - this.camera.y;
    
    // ¡NUEVO! Efecto de i-frames
    if (this.player.invulnTime > 0) {
      ctx.fillStyle = 'rgba(0, 200, 224, 0.5)'; // Flash de invencibilidad
    } else {
      ctx.fillStyle = '#00c8e0';
    }
    
    ctx.beginPath();
    ctx.arc(px, py, this.player.radius, 0, Math.PI * 2);
    ctx.fill();

    // Línea de puntería
    const aimAngle = this.getAimAngle();
    ctx.strokeStyle = 'rgba(0,242,255,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(aimAngle) * 40, py + Math.sin(aimAngle) * 40);
    ctx.stroke();

    // Crosshair (cursor unificado)
    const cx = this.input.cursorX != null ? this.input.cursorX : (this.mousePos?.x ?? null);
    const cy = this.input.cursorY != null ? this.input.cursorY : (this.mousePos?.y ?? null);

    if (cx != null && cy != null) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,242,255,.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-14, 0); ctx.lineTo(14, 0);
      ctx.moveTo(0, -14); ctx.lineTo(0, 14);
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.stroke();
      ctx.restore();
    }

    // Cursor del gamepad (R-Stick)
    if (GamepadManager.active) {
      const gx = GamepadManager.cursor.x;
      const gy = GamepadManager.cursor.y;
      const distFromCenter = Math.hypot(gx - window.innerWidth / 2, gy - window.innerHeight / 2);
      if (distFromCenter > 10) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,180,0,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(gx, gy, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(gx - 16, gy); ctx.lineTo(gx + 16, gy);
        ctx.moveTo(gx, gy - 16); ctx.lineTo(gx, gy + 16);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ✅ Dibuja la puerta de salida si la sala está despejada
    const roomForDoor = this.rooms ? this.rooms[this.currentRoomIndex] : null;
    if (this.roomState === 'Clear' && roomForDoor) {
      const roomBounds = roomForDoor.bounds;
      const roomScreenBounds = {
        x: roomBounds.x - this.camera.x,
        y: roomBounds.y - this.camera.y,
        w: roomBounds.w,
        h: roomBounds.h
      };
      const doorSize = 40;
      const doorX = roomScreenBounds.x + roomScreenBounds.w / 2;
      const doorY = roomScreenBounds.y + roomScreenBounds.h - 10;
      ctx.fillStyle = 'rgba(0, 255, 136, 0.8)';
      ctx.fillRect(doorX - doorSize / 2, doorY - doorSize / 2, doorSize, doorSize);
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 3;
      ctx.strokeRect(doorX - doorSize / 2, doorY - doorSize / 2, doorSize, doorSize);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 20px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('→', doorX, doorY + 8);
      // Detectar si el jugador está cerca de la puerta para transicionar automáticamente
      const playerDist = Math.hypot(
        this.player.x - (roomBounds.x + roomBounds.w / 2),
        this.player.y - (roomBounds.y + roomBounds.h - 20)
      );
      if (playerDist < 50) {
        this.transitionToNextRoom();
      }
    }
    // Minimapa
    this.drawMinimap();
  },

  // ========================================================================
  // RENDERIZADO DE HUD (Canvas Overlay)
  // ========================================================================

  drawHUD() {
    const hudCanvas = UIManager.el('hud-canvas');
    if (!hudCanvas) return;

    const hudCtx = hudCanvas.getContext('2d');
    const w = hudCanvas.width;
    const h = hudCanvas.height;

    // Limpiar HUD canvas
    hudCtx.clearRect(0, 0, w, h);

    // Indicador de estado de sala
    hudCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    hudCtx.fillRect(20, h - 60, 200, 40);
    hudCtx.font = 'bold 16px Arial';
    if (this.roomState === 'Fight') {
      hudCtx.fillStyle = '#ff2a6d';
      hudCtx.fillText('⚔ COMBATE', 30, h - 35);
    } else if (this.roomState === 'Clear') {
      hudCtx.fillStyle = '#00ff88';
      hudCtx.fillText('✓ COMPLETADO', 30, h - 35);
      hudCtx.font = '12px Arial';
      hudCtx.fillStyle = '#ffffff';
      hudCtx.fillText('Presiona N para avanzar', 30, h - 15);
    } else if (this.roomState === 'Transition') {
      hudCtx.fillStyle = '#ffb300';
      hudCtx.fillText('→ TRANSICIÓN...', 30, h - 35);
    }
  },

  drawMinimap() {
    const mini = UIManager.el('minimap');
    if (!mini) return;
    const ctx = mini.getContext('2d');
    const size = 150;
    mini.width = size;
    mini.height = size;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, size, size);
    // ✅ Mostrar únicamente la sala actual
    const currentRoom = this.rooms ? this.rooms[this.currentRoomIndex] : null;
    if (!currentRoom) return;
    const roomBounds = currentRoom.bounds;
    const sx = size / roomBounds.w;
    const sy = size / roomBounds.h;
    // Dibujar borde de la sala
    ctx.strokeStyle = 'rgba(0,242,255,0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, size, size);
    // Jugador relativo a la sala
    ctx.fillStyle = '#00f2ff';
    ctx.beginPath();
    const playerX = (this.player.x - roomBounds.x) * sx;
    const playerY = (this.player.y - roomBounds.y) * sy;
    ctx.arc(playerX, playerY, 4, 0, Math.PI * 2);
    ctx.fill();
    // Enemigos en la sala actual
    for (const e of this.enemies) {
      if (e.roomId !== currentRoom.id) continue;
      const colors = { grunt: '#ff2a6d', rusher: '#ffb300', shooter: '#009dff', tank: '#9d00ff', boss: '#ff0000' };
      ctx.fillStyle = colors[e.type] || '#ff2a6d';
      const ex = (e.x - roomBounds.x) * sx;
      const ey = (e.y - roomBounds.y) * sy;
      ctx.fillRect(ex - 2, ey - 2, 4, 4);
    }
    // Ítems en la sala actual
    for (const item of this.items) {
      // Filtrar ítems que estén dentro del radio aproximado de la sala actual
      const centerDist = Math.hypot(item.x - currentRoom.center.x, item.y - currentRoom.center.y);
      if (centerDist > roomBounds.w / 2) continue;
      ctx.fillStyle = '#fff700';
      const ix = (item.x - roomBounds.x) * sx;
      const iy = (item.y - roomBounds.y) * sy;
      ctx.fillRect(ix - 2, iy - 2, 4, 4);
    }
  },

  // ========================================================================
  // INPUT (Teclado y Mouse)
  // ========================================================================

  setupInput() {
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      this.keys[k] = true;
      
      // Inputs de un solo frame (Edge-triggered)
      if (k === ' ') {
        this.input.dash = true;
      }
      if (k === 'e') {
        this.input.heavyAttack = true;
      }
      // ✅ DEBUG: Tecla N avanza a la siguiente sala si está en estado Clear
      if (k === 'n' && this.roomState === 'Clear') {
        this.transitionToNextRoom();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys[e.key.toLowerCase()] = false;
    });

    const canvas = UIManager.el('game-canvas');
    if (!canvas) return;
    
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mousePos = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
      this.input.cursorX = this.mousePos.x;
      this.input.cursorY = this.mousePos.y;
    });

    canvas.addEventListener('mousedown', () => {
      this.keys['mousedown'] = true;
      this.input.shoot = true;
    });

    canvas.addEventListener('mouseup', () => {
      this.keys['mousedown'] = false;
      this.input.shoot = false;
    });
  },

  composeKeyboardMouseInput() {
    // Movimiento por teclado (si gamepad no activo)
    if (Math.abs(this.input.moveX) < 0.001) {
      let ax = 0;
      if (this.keys['a'] || this.keys['arrowleft']) ax -= 1;
      if (this.keys['d'] || this.keys['arrowright']) ax += 1;
      this.input.moveX = ax;
    }
    if (Math.abs(this.input.moveY) < 0.001) {
      let ay = 0;
      if (this.keys['w'] || this.keys['arrowup']) ay -= 1;
      if (this.keys['s'] || this.keys['arrowdown']) ay += 1;
      this.input.moveY = ay;
    }

    // Disparo por mouse (continuo)
    this.input.shoot = this.keys['mousedown'] || this.input.shoot; // Combinar con gamepad

    // Cursor por mouse
    if (this.mousePos && !GamepadManager.active) {
      this.input.cursorX = this.mousePos.x;
      this.input.cursorY = this.mousePos.y;
    }
  },

  // ========================================================================
  // GAME OVER (¡MODIFICADO!)
  // ========================================================================

  gameOver() {
  UIManager.log('¡Has muerto! Game Over.', 'error');
  this.running = false;
  this.paused = false;
  
  // Save Cosmic Ash
  const ashGained = this.player.runCosmicAsh || 0;
  const totalAsh = this.cosmicAsh + ashGained;
  this.cosmicAsh = totalAsh;
  this.saveBaseStats();
  
  UIManager.log(`Has guardado ${ashGained} Ceniza Cósmica. Total: ${totalAsh}`, 'warn');
  
  // Show death screen with fade
  const canvas = UIManager.el('game-canvas');
  if (canvas) {
    canvas.style.transition = 'opacity 1s';
    canvas.style.opacity = '0';
  }
  
  setTimeout(() => {
    UIManager.go('game-ui', 'main-menu'); // ✅ CORRECT: Use UIManager.go()
    if (canvas) {
      canvas.style.opacity = '1';
    }
  }, 1500);
}
};

// ============================================================================
// 7) INICIALIZACIÓN
// ============================================================================

window.addEventListener('load', () => {
  // Inicializar subsistemas
  UIManager.init();
  GamepadManager.init();
  Game.setupInput();
  Game.loadBaseStats(); // Cargar stats persistentes
  Game.setSeed(Math.random());

  // Log inicial
  console.log('%c🎮 AXES & LASERS — Resaca Cósmica v2.0', 'color: #00f2ff; font-size: 20px; font-weight: bold;');
  console.log('%c✓ Motor v2 "Interlocking Loops" inicializado', 'color: #00ff88;');
  console.log('%c✓ Cargadas stats del Hub. Ceniza Total: ' + Game.cosmicAsh, 'color: #00ff88;');
  console.log('%cPresiona F12 para debug, F1 para ayuda', 'color: #ffb300;');
});

// ============================================================================
// 8) DEBUG Y UTILIDADES (¡MODIFICADO!)
// ============================================================================

// Exponer Game a la consola para debug
window.AxesAndLasers = {
  Game,
  UIManager,
  AudioManager,
  GamepadManager,
  DungeonGenerator,
  
  // Comandos útiles
  giveXP(amount) {
    if (Game.player) {
      Game.player.xp += amount;
      console.log(`✓ ${amount} XP otorgado`);
    }
  },
  
  giveAsh(amount) {
    Game.player.runCosmicAsh += amount;
    console.log(`✓ ${amount} Ceniza Cósmica (run) otorgada`);
  },
  
  heal() {
    if (Game.player) {
      Game.player.hp = Game.player.maxHp;
      Game.player.stamina = Game.player.maxStamina;
      console.log('✓ Salud y Estamina restauradas');
    }
  },
  
  clearEnemies() {
    Game.enemies = [];
    console.log('✓ Enemigos eliminados');
  },
  
  showStats() {
    console.log("--- STATS DE LA RUN ---");
    console.table(Game.stats);
    console.log("--- STATS BASE (HUB) ---");
    console.table(Game.baseStats);
  },
  
  spawnEnemy(type = 'grunt') {
    // Generar un enemigo en la sala actual para pruebas
    if (!Game.running || !Game.player) {
      console.log('❌ El juego no está corriendo');
      return;
    }
    const currentRoom = Game.rooms[Game.currentRoomIndex];
    if (!currentRoom) {
      console.log('❌ No hay sala activa');
      return;
    }
    const enemy = Game.createEnemy(
      currentRoom.center.x + randInt(-100, 100),
      currentRoom.center.y + randInt(-100, 100),
      type === 'boss'
    );
    enemy.roomId = currentRoom.id;
    enemy.type = type;
    currentRoom.enemies.push(enemy);
    Game.enemies.push(enemy);
    console.log(`✓ Enemigo ${type} generado en sala ${currentRoom.id}`);
  },

  teleport(x, y) {
    if (Game.player) {
      Game.player.x = x || 0;
      Game.player.y = y || 0;
      console.log(`✓ Jugador teletransportado a (${x}, ${y})`);
    }
  },

  // ✅ NUEVO: saltar a una sala específica
  skipToRoom(roomIndex) {
    if (!Game.rooms[roomIndex]) {
      console.log(`❌ Sala ${roomIndex} no existe. Total: ${Game.rooms.length}`);
      return;
    }
    Game.currentRoomIndex = roomIndex;
    const room = Game.rooms[roomIndex];
    Game.player.x = room.center.x;
    Game.player.y = room.center.y;
    Game.spawnRoomEnemies(room);
    console.log(`✓ Saltado a sala ${roomIndex + 1}`);
  },

  // ✅ Completar sala instantáneamente
  completeRoom() {
    const currentRoom = Game.rooms[Game.currentRoomIndex];
    if (!currentRoom) {
      console.log('❌ No hay sala activa');
      return;
    }
    Game.enemies = Game.enemies.filter(e => e.roomId !== currentRoom.id);
    Game.roomState = 'Clear';
    console.log('✓ Sala completada instantáneamente');
  },
  
  toggleGodMode() {
    if (Game.player) {
      Game.player.invulnTime = Game.player.invulnTime > 999 ? 0 : 99999;
      const status = Game.player.invulnTime > 999 ? 'ACTIVADO' : 'DESACTIVADO';
      console.log(`✓ Modo dios ${status}`);
    }
  },
  
  resetMeta() {
    if (confirm("¿BORRAR TODO EL PROGRESO PERMANENTE (CENIZA Y MEJORAS)?")) {
      localStorage.removeItem('cosmicAsh');
      localStorage.removeItem('hikariBaseStats');
      Game.cosmicAsh = 0;
      Game.baseStats = { level: 1, might: 0, focus: 0, grit: 0, haste: 0, luck: 0, costs: { might: 150, focus: 150, grit: 100, haste: 120, luck: 200 } };
      Game.updateHubUI();
      console.log('✓ Progreso permanente reseteado.');
    }
  }
};

console.log('%c💡 Comandos de debug disponibles:', 'color: #ffb300; font-weight: bold;');
console.log('%cAxesAndLasers.giveXP(1000)', 'color: #8fa1c4;');
console.log('%cAxesAndLasers.giveAsh(500)', 'color: #8fa1c4;');
console.log('%cAxesAndLasers.heal()', 'color: #8fa1c4;');
console.log('%cAxesAndLasers.showStats()', 'color: #8fa1c4;');
console.log('%cAxesAndLasers.toggleGodMode()', 'color: #8fa1c4;');
console.log('%cAxesAndLasers.resetMeta() - ¡PELIGRO!', 'color: #ff2a6d;');