// dungeon-generator.js
// Genera un dungeon con rooms conectados, pasillos y hoyos (void).
// Devuelve: rooms, corridors, mapTiles, doors (placeholder).

function createDungeon({
  width = 800,
  height = 600,
  tileSize = 32,
  maxRooms = 20,
  voidDensity = 0.02,
  minVoidRadiusTiles = 3
} = {}) {
  const TILE_SIZE = tileSize;
  const CANVAS_WIDTH = width;
  const CANVAS_HEIGHT = height;
  const MAX_ROOMS = maxRooms;

  let rooms = [];
  let corridors = [];
  let doors = [];
  let mapTiles = [];

  // ============================
  // 1) ROOMS RECTANGULARES
  // ============================
  let attempts = MAX_ROOMS * 5;
  while (rooms.length < MAX_ROOMS && attempts-- > 0) {
    const w = Math.floor(Math.random() * 5 + 3) * TILE_SIZE; // ancho 3–7 tiles
    const h = Math.floor(Math.random() * 5 + 3) * TILE_SIZE; // alto 3–7 tiles
    const x = Math.floor(Math.random() * (CANVAS_WIDTH - w));
    const y = Math.floor(Math.random() * (CANVAS_HEIGHT - h));

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
  //    (todo conectado, estilo "caminos unidos")
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
    const disjointSet = new Array(hubRooms.length)
      .fill(0)
      .map((_, i) => i);

    function find(i) {
      if (disjointSet[i] === i) return i;
      disjointSet[i] = find(disjointSet[i]);
      return disjointSet[i];
    }

    function union(i, j) {
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) {
        disjointSet[rootI] = rootJ;
        return true;
      }
      return false;
    }

    for (const edge of edges) {
      if (union(edge.r1.id, edge.r2.id)) {
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
        y: c1.y - TILE_SIZE / 4,
        w: Math.abs(c1.x - c2.x) + TILE_SIZE / 2,
        h: TILE_SIZE / 2
      });

      // Vertical
      corridors.push({
        x: c2.x - TILE_SIZE / 4,
        y: Math.min(c1.y, c2.y),
        w: TILE_SIZE / 2,
        h: Math.abs(c1.y - c2.y) + TILE_SIZE / 2
      });
    }
  }

  // ============================
  // 3) TILEMAP: 0 piso, 1 pared, 3 void
  // ============================
  const mapW = Math.ceil(CANVAS_WIDTH / TILE_SIZE);
  const mapH = Math.ceil(CANVAS_HEIGHT / TILE_SIZE);

  mapTiles = new Array(mapW).fill(0).map(() => new Array(mapH).fill(1)); // todo paredes

  const carve = entity => {
    const startX = Math.floor(entity.x / TILE_SIZE);
    const endX = Math.ceil((entity.x + entity.w) / TILE_SIZE);
    const startY = Math.floor(entity.y / TILE_SIZE);
    const endY = Math.ceil((entity.y + entity.h) / TILE_SIZE);
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
    const srCx = Math.floor((startRoom.x + startRoom.w / 2) / TILE_SIZE);
    const srCy = Math.floor((startRoom.y + startRoom.h / 2) / TILE_SIZE);

    for (let x = 1; x < mapW - 1; x++) {
      for (let y = 1; y < mapH - 1; y++) {
        if (mapTiles[x][y] !== 0) continue; // sólo desde piso
        const dx = x - srCx;
        const dy = y - srCy;
        const dist = Math.hypot(dx, dy);
        if (dist < minVoidRadiusTiles) continue;
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
  // 5) PUERTAS
  //    Aquí te dejo el hook: tú decides cuántas y dónde.
  // ============================
  doors = []; // por ahora vacío, puedes meter tu propia lógica

  return {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    tileSize: TILE_SIZE,
    rooms,
    corridors,
    doors,
    mapTiles
  };
}

// Helper opcional para dibujar rápido en un canvas 2D
function drawDungeonToCanvas(ctx, dungeon) {
  const { mapTiles, tileSize } = dungeon;
  const mapW = mapTiles.length;
  const mapH = mapTiles[0].length;

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  for (let x = 0; x < mapW; x++) {
    for (let y = 0; y < mapH; y++) {
      const tile = mapTiles[x][y];
      const px = x * tileSize;
      const py = y * tileSize;

      if (tile === 1) {
        ctx.fillStyle = "#444"; // pared
      } else if (tile === 0) {
        ctx.fillStyle = "#222"; // piso
      } else if (tile === 3) {
        ctx.fillStyle = "#000"; // hoyo / void
      } else {
        ctx.fillStyle = "#555"; // fallback
      }
      ctx.fillRect(px, py, tileSize, tileSize);

      if (tile === 0) {
        ctx.fillStyle = "#333";
        ctx.fillRect(px + 2, py + 2, tileSize - 4, tileSize - 4);
      }
    }
  }
}
