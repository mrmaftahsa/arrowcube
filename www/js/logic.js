// Arrow Cube — pure game logic (no rendering). Works in browser and Node.

export const QUEUE_SIZE = 4;
export const MATCH_COUNT = 3;

export const PALETTE = [
  0x3fe0b0, // mint
  0xff7ad9, // pink
  0x8b5cff, // violet
  0xc6f432, // lime
  0xffa53a, // orange
  0x40c8ff, // sky
  0xb5643a, // brown
  0xf2f2ff, // white
];

// Seeded RNG so every level is the same each time you play it.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Face definitions for a W x H x D box centred at the origin.
export function makeFaces(W, H, D) {
  return [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], nu: D, nv: H, half: W / 2 },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], nu: D, nv: H, half: W / 2 },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], nu: W, nv: D, half: H / 2 },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], nu: W, nv: D, half: H / 2 },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], nu: W, nv: H, half: D / 2 },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], nu: W, nv: H, half: D / 2 },
  ];
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function levelConfig(level) {
  let size = Math.min(3 + Math.floor((level - 1) / 6), 6);
  let W = size, H = size, D = size;
  const shape = level % 3;
  if (level > 2 && shape === 2) { W = size + 1; H = Math.max(2, size - 1); D = size; }
  else if (level > 2 && shape === 0) { W = size; H = size + 1; D = Math.max(2, size - 1); }
  return {
    W, H, D,
    maxLen: Math.min(2 + Math.floor(level / 2), 7),
    colors: Math.min(4 + Math.floor(level / 4), PALETTE.length),
    seed: level * 7919 + 13,
  };
}

// ---------- Board ----------
export class Board {
  constructor(W, H, D) {
    this.W = W; this.H = H; this.D = D;
    this.faces = makeFaces(W, H, D);
    this.grid = this.faces.map(f => new Int32Array(f.nu * f.nv).fill(-1));
    this.arrows = new Map(); // id -> arrow
    this.nextId = 0;
  }
  inside(f, i, j) { const F = this.faces[f]; return i >= 0 && j >= 0 && i < F.nu && j < F.nv; }
  at(f, i, j) { return this.grid[f][j * this.faces[f].nu + i]; }
  set(f, i, j, id) { this.grid[f][j * this.faces[f].nu + i] = id; }

  add(arrow) {
    const id = arrow.id ?? this.nextId++;
    arrow.id = id;
    this.nextId = Math.max(this.nextId, id + 1);
    this.arrows.set(id, arrow);
    for (const [i, j] of arrow.cells) this.set(arrow.face, i, j, id);
    return id;
  }
  remove(id) {
    const a = this.arrows.get(id);
    if (!a) return;
    for (const [i, j] of a.cells) if (this.at(a.face, i, j) === id) this.set(a.face, i, j, -1);
    this.arrows.delete(id);
  }

  // Look along the arrow's head direction. Returns {free, blocker, steps}
  // steps = how many empty cells the head can move before hitting something.
  ray(id) {
    const a = this.arrows.get(id);
    const [hi, hj] = a.cells[a.cells.length - 1];
    const [di, dj] = a.dir;
    let i = hi + di, j = hj + dj, steps = 0;
    while (this.inside(a.face, i, j)) {
      const o = this.at(a.face, i, j);
      if (o !== -1) return { free: false, blocker: o, steps };
      i += di; j += dj; steps++;
    }
    return { free: true, blocker: -1, steps };
  }

  freeArrows() {
    const out = [];
    for (const id of this.arrows.keys()) if (this.ray(id).free) out.push(id);
    return out;
  }

  // Removing a free arrow never blocks anything, so greedy removal is an exact solvability test.
  stuckSet() {
    const b = this.clone();
    let progress = true;
    while (progress && b.arrows.size) {
      progress = false;
      for (const id of [...b.arrows.keys()]) {
        if (b.ray(id).free) { b.remove(id); progress = true; }
      }
    }
    return [...b.arrows.keys()];
  }

  clone() {
    const b = new Board(this.W, this.H, this.D);
    for (const a of this.arrows.values()) b.add({ ...a, cells: a.cells.map(c => [...c]) });
    b.nextId = this.nextId;
    return b;
  }
}

// Does an arrow's own forward ray run into its own body?
function selfBlocked(board, face, cells, dir) {
  const set = new Set(cells.map(([i, j]) => i + ',' + j));
  let [i, j] = cells[cells.length - 1];
  i += dir[0]; j += dir[1];
  while (board.inside(face, i, j)) {
    if (set.has(i + ',' + j)) return true;
    i += dir[0]; j += dir[1];
  }
  return false;
}

function randomWalk(board, face, start, len, R) {
  const cells = [start];
  const used = new Set([start.join(',')]);
  let last = null;
  for (let k = 1; k < len; k++) {
    const [ci, cj] = cells[cells.length - 1];
    let opts = DIRS.filter(([di, dj]) => {
      const ni = ci + di, nj = cj + dj;
      return board.inside(face, ni, nj) && board.at(face, ni, nj) === -1 && !used.has(ni + ',' + nj);
    });
    if (!opts.length) break;
    let d;
    if (last && R() < 0.55 && opts.some(o => o[0] === last[0] && o[1] === last[1])) d = last;
    else d = opts[Math.floor(R() * opts.length)];
    const nxt = [ci + d[0], cj + d[1]];
    cells.push(nxt); used.add(nxt.join(',')); last = d;
  }
  return cells;
}

function makeArrow(board, face, cells, R) {
  let dir;
  if (cells.length === 1) {
    const order = DIRS.slice().sort(() => R() - 0.5);
    dir = order[0];
  } else {
    const a = cells[cells.length - 2], b = cells[cells.length - 1];
    dir = [b[0] - a[0], b[1] - a[1]];
  }
  if (!selfBlocked(board, face, cells, dir)) return { face, cells, dir };
  // Try reversed
  const rev = cells.slice().reverse();
  if (rev.length > 1) {
    const a = rev[rev.length - 2], b = rev[rev.length - 1];
    const d2 = [b[0] - a[0], b[1] - a[1]];
    if (!selfBlocked(board, face, rev, d2)) return { face, cells: rev, dir: d2 };
  }
  return null;
}

export function generateLevel(level) {
  const cfg = levelConfig(level);
  const R = rng(cfg.seed);
  const board = new Board(cfg.W, cfg.H, cfg.D);
  const pickColor = () => PALETTE[Math.floor(R() * cfg.colors)];

  const fillPass = (checkEach) => {
    for (let f = 0; f < 6; f++) {
      const F = board.faces[f];
      const cells = [];
      for (let j = 0; j < F.nv; j++) for (let i = 0; i < F.nu; i++) cells.push([i, j]);
      cells.sort(() => R() - 0.5);
      for (const c of cells) {
        if (board.at(f, c[0], c[1]) !== -1) continue;
        const minLen = Math.min(2, cfg.maxLen);
        const len = minLen + Math.floor(R() * (cfg.maxLen - minLen + 1));
        const path = randomWalk(board, f, c, len, R);
        if (path.length < 2 && R() < 0.7) continue; // prefer real arrows over dots
        const arrow = makeArrow(board, f, path, R);
        if (!arrow) continue;
        arrow.color = pickColor();
        const id = board.add(arrow);
        if (checkEach && board.stuckSet().length) board.remove(id);
      }
    }
  };

  fillPass(false);

  // Repair until solvable: flip stuck arrows, else delete them.
  for (let guard = 0; guard < 200; guard++) {
    const stuck = board.stuckSet();
    if (!stuck.length) break;
    const id = stuck[Math.floor(R() * stuck.length)];
    const a = board.arrows.get(id);
    board.remove(id);
    const rev = a.cells.slice().reverse();
    let d2;
    if (rev.length > 1) {
      const p = rev[rev.length - 2], q = rev[rev.length - 1];
      d2 = [q[0] - p[0], q[1] - p[1]];
    } else d2 = [-a.dir[0], -a.dir[1]];
    if (!selfBlocked(board, a.face, rev, d2) && R() < 0.6) {
      board.add({ ...a, cells: rev, dir: d2 });
    }
  }
  // Fill holes again, keeping it solvable.
  fillPass(true);

  // Re-number ids 0..n-1
  const out = new Board(cfg.W, cfg.H, cfg.D);
  let k = 0;
  for (const a of board.arrows.values()) out.add({ ...a, id: k++ });
  out.cfg = cfg;
  return out;
}

// ---------- Queue ----------
// Returns {queue, matched:[color]|null}
export function pushQueue(queue, color) {
  const q = [...queue, color];
  const same = q.filter(c => c === color).length;
  if (same >= MATCH_COUNT) {
    let removed = 0;
    const nq = q.filter(c => (c === color && removed < MATCH_COUNT) ? (removed++, false) : true);
    return { queue: nq, matched: color };
  }
  return { queue: q, matched: null };
}
