import * as THREE from 'three';
import { RoundedBoxGeometry } from '../lib/RoundedBoxGeometry.js';
import { mergeGeometries } from '../lib/BufferGeometryUtils.js';
import { generateLevel, pushQueue, QUEUE_SIZE } from './logic.js';
import { sfx, buzz, unlockAudio, toggleSound, soundOn } from './audio.js';

// ---------------- Storage ----------------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};

// ---------------- DOM ----------------
const $ = id => document.getElementById(id);
const canvas = $('c');
const ui = {
  hud: $('hud'), menu: $('menu'), modal: $('modal'), queue: $('queue'), level: $('levelPill'),
  hintCount: $('hintCount'), fill: $('progressFill'), ptext: $('progressText'), tip: $('tip'),
  toast: $('toast'), mTitle: $('mTitle'), mStars: $('mStars'), mText: $('mText'), mBtn: $('mBtn'), mBtn2: $('mBtn2'),
  menuLevel: $('menuLevel'), btnSound: $('btnSound'),
};

// ---------------- Three setup ----------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x302a66, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(3, 6, 8);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x9f8bff, 0.8);
rim.position.set(-6, -2, -4);
scene.add(rim);

const puzzle = new THREE.Group();
scene.add(puzzle);

const hitGeo = new THREE.BoxGeometry(1, 1, 1);
const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });

// ---------------- Game state ----------------
let level = store.get('ac_level', 1);
let board = null;
let views = new Map();      // arrow id -> view
let cubeMesh = null;
let queue = [];
let sentToQueue = 0;
let hintsLeft = 3;
let totalArrows = 0;
let state = 'menu';         // menu | play | won | lost
let anims = [];             // running animations
let hintTimer = 0;
let introT = 1;
let camDist = 12;

const LIFT = 0.075, W_ARROW = 0.18, H_ARROW = 0.12;

// ---------------- Geometry helpers ----------------
const V = a => new THREE.Vector3(a[0], a[1], a[2]);

function cellPos(face, i, j, lift = LIFT) {
  const F = board.faces[face];
  return V(F.n).multiplyScalar(F.half + lift)
    .addScaledVector(V(F.u), i - F.nu / 2 + 0.5)
    .addScaledVector(V(F.v), j - F.nv / 2 + 0.5);
}
function faceDir(face, d) {
  const F = board.faces[face];
  return V(F.u).multiplyScalar(d[0]).addScaledVector(V(F.v), d[1]);
}

function arrowPolyline(a) {
  const c = a.cells.map(([i, j]) => cellPos(a.face, i, j));
  const fwd = faceDir(a.face, a.dir);
  const first = c.length > 1 ? c[1].clone().sub(c[0]).normalize() : fwd.clone();
  const pts = [c[0].clone().addScaledVector(first, -0.32), ...c.slice(1, -1).map(p => p.clone())];
  pts.push(c[c.length - 1].clone().addScaledVector(fwd, 0.1));
  return pts;
}

function polyLength(pts) { let L = 0; for (let k = 1; k < pts.length; k++) L += pts[k].distanceTo(pts[k - 1]); return L; }

// Return the part of polyline between arc lengths s0..s1
function subPolyline(pts, s0, s1) {
  const out = [];
  let acc = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    const l = a.distanceTo(b);
    const segS = acc, segE = acc + l;
    if (segE >= s0 && segS <= s1 && l > 1e-6) {
      const t0 = Math.max(0, (s0 - segS) / l), t1 = Math.min(1, (s1 - segS) / l);
      const p0 = a.clone().lerp(b, t0), p1 = a.clone().lerp(b, t1);
      if (!out.length) out.push(p0);
      else if (out[out.length - 1].distanceToSquared(p0) > 1e-8) out.push(p0);
      out.push(p1);
    }
    acc = segE;
  }
  // remove duplicates
  return out.filter((p, i) => i === 0 || p.distanceToSquared(out[i - 1]) > 1e-8);
}

const _m = new THREE.Matrix4();
function orient(geo, xAxis, zAxis, pos) {
  const x = xAxis.clone().normalize();
  const z = zAxis.clone().normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  _m.makeBasis(x, y, z).setPosition(pos);
  geo.applyMatrix4(_m);
  return geo;
}

const headShape = new THREE.Shape();
headShape.moveTo(-0.27, 0); headShape.lineTo(0.27, 0); headShape.lineTo(0, 0.38); headShape.lineTo(-0.27, 0);
const headBase = new THREE.ExtrudeGeometry(headShape, { depth: H_ARROW, bevelEnabled: false });
headBase.translate(0, 0, -H_ARROW / 2);
// rotate so the arrow tip points along +X (local), extruded along Z (normal)
headBase.rotateZ(-Math.PI / 2);
const headGeoNI = headBase.index ? headBase.toNonIndexed() : headBase;

function buildArrowGeometry(pts, normal) {
  const parts = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    const len = a.distanceTo(b);
    if (len < 1e-4) continue;
    const g = new THREE.BoxGeometry(len + W_ARROW, W_ARROW, H_ARROW).toNonIndexed();
    orient(g, b.clone().sub(a), normal, a.clone().add(b).multiplyScalar(0.5));
    parts.push(g);
  }
  if (pts.length >= 2) {
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    const dir = b.clone().sub(a);
    if (dir.lengthSq() > 1e-8) {
      const h = headGeoNI.clone();
      orient(h, dir, normal, b.clone().addScaledVector(dir.normalize(), -0.02));
      parts.push(h);
    }
  }
  if (!parts.length) return new THREE.BufferGeometry();
  const merged = mergeGeometries(parts, false);
  parts.forEach(p => p.dispose());
  return merged;
}

// ---------------- Level build ----------------
function clearScene() {
  for (const v of views.values()) disposeView(v);
  views.clear();
  if (cubeMesh) { puzzle.remove(cubeMesh); cubeMesh.geometry.dispose(); }
  puzzle.clear();
  anims = [];
}

function disposeView(v) {
  puzzle.remove(v.group);
  v.mesh.geometry.dispose();
  v.mat.dispose();
}

function buildLevel(n) {
  clearScene();
  board = generateLevel(n);
  const { W, H, D } = board;

  const cubeGeo = new RoundedBoxGeometry(W, H, D, 4, 0.16);
  cubeMesh = new THREE.Mesh(cubeGeo, new THREE.MeshStandardMaterial({ color: 0x1d2442, roughness: 0.55, metalness: 0.15 }));
  puzzle.add(cubeMesh);
  // white silhouette outline
  const outline = new THREE.Mesh(cubeGeo, new THREE.MeshBasicMaterial({ color: 0xdfe3ff, side: THREE.BackSide, transparent: true, opacity: 0.85 }));
  outline.scale.set((W + 0.07) / W, (H + 0.07) / H, (D + 0.07) / D);
  puzzle.add(outline);
  // faint grid dots on each face so players can read the lanes
  const dotGeo = new THREE.CircleGeometry(0.035, 8);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0x3a4470 });
  board.faces.forEach((F, f) => {
    const count = F.nu * F.nv;
    const inst = new THREE.InstancedMesh(dotGeo, dotMat, count);
    const n = V(F.n), u = V(F.u), v = V(F.v);
    const m = new THREE.Matrix4().makeBasis(u, v, n);
    let k = 0;
    for (let j = 0; j < F.nv; j++) for (let i = 0; i < F.nu; i++) {
      const p = cellPos(f, i, j, 0.004);
      m.setPosition(p); inst.setMatrixAt(k++, m);
    }
    puzzle.add(inst);
  });

  for (const a of board.arrows.values()) createView(a);

  queue = []; sentToQueue = 0; hintsLeft = 3; totalArrows = board.arrows.size;
  puzzle.quaternion.setFromEuler(new THREE.Euler(0.55, -0.75, 0));
  introT = 0;
  fitCamera();
  renderQueue(queue);
  updateHud();
}

function createView(a) {
  const F = board.faces[a.face];
  const normal = V(F.n);
  const pts = arrowPolyline(a);
  const color = new THREE.Color(a.color);
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.05, transparent: true, opacity: 1 });
  const mesh = new THREE.Mesh(buildArrowGeometry(pts, normal), mat);
  const group = new THREE.Group();
  group.add(mesh);
  const hits = [];
  const n = V(F.n), u = V(F.u), v = V(F.v);
  for (const [i, j] of a.cells) {
    const h = new THREE.Mesh(hitGeo, hitMat);
    h.position.copy(cellPos(a.face, i, j, 0.1));
    const s = new THREE.Vector3().addScaledVector(n.clone().set(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)), 0.25)
      .addScaledVector(u.clone().set(Math.abs(u.x), Math.abs(u.y), Math.abs(u.z)), 0.96)
      .addScaledVector(v.clone().set(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)), 0.96);
    h.scale.copy(s);
    h.userData.arrowId = a.id;
    group.add(h); hits.push(h);
  }
  puzzle.add(group);
  const fwd = faceDir(a.face, a.dir);
  const ext = [...pts, pts[pts.length - 1].clone().addScaledVector(fwd, 30)];
  views.set(a.id, { id: a.id, group, mesh, mat, hits, pts, ext, len: polyLength(pts), normal, color, busy: false });
}

function setViewOffset(v, s) {
  const sub = subPolyline(v.ext, s, s + v.len);
  v.mesh.geometry.dispose();
  v.mesh.geometry = buildArrowGeometry(sub, v.normal);
}

// ---------------- Camera ----------------
function fitCamera() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const topUI = 215, botUI = 60;
  const availH = Math.max(200, h - topUI - botUI);
  const availPx = Math.min(availH, w * 0.94);
  if (board) {
    const r = Math.sqrt(board.W ** 2 + board.H ** 2 + board.D ** 2) / 2 + 0.25;
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camDist = (r * h) / (availPx * tanH) * 0.98;
  }
  camera.position.set(0, 0, camDist * zoom);
  camera.lookAt(0, 0, 0);
  // shift the image so the cube sits in the free area under the queue
  const centerY = topUI + availH / 2;
  camera.setViewOffset(w, h, 0, -(centerY - h / 2), w, h);
  camera.updateProjectionMatrix();
}
let zoom = 1;
window.addEventListener('resize', fitCamera);

// ---------------- Input ----------------
const pointers = new Map();
let drag = null;
let velX = 0, velY = 0;
let pinchStart = 0, zoomStart = 1;

canvas.addEventListener('pointerdown', e => {
  unlockAudio();
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    drag = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    velX = velY = 0;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = Math.hypot(a.x - b.x, a.y - b.y); zoomStart = zoom;
    if (drag) drag.moved = true;
  }
});
canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    zoom = THREE.MathUtils.clamp(zoomStart * pinchStart / Math.max(d, 1), 0.6, 1.6);
    fitCamera();
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 9) drag.moved = true;
  if (drag.moved) { rotateBy(dx, dy); velX = dx; velY = dy; }
  drag.x = e.clientX; drag.y = e.clientY;
});
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (drag && pointers.size === 0) {
    if (!drag.moved && performance.now() - drag.t < 500) handleTap(e.clientX, e.clientY);
    drag = null;
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0);
function rotateBy(dx, dy) {
  const k = 0.0085;
  _qa.setFromAxisAngle(AY, dx * k);
  _qb.setFromAxisAngle(AX, dy * k);
  puzzle.quaternion.premultiply(_qa).premultiply(_qb).normalize();
}

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function handleTap(x, y) {
  if (state !== 'play') return;
  ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const targets = [cubeMesh];
  for (const v of views.values()) if (!v.busy) targets.push(...v.hits);
  const hit = raycaster.intersectObjects(targets, false)[0];
  if (!hit || hit.object === cubeMesh) return;
  tapArrow(hit.object.userData.arrowId);
}

// ---------------- Core moves ----------------
function tapArrow(id) {
  const v = views.get(id);
  if (!v || v.busy) return;
  hideTip();
  const r = board.ray(id);
  const arrow = board.arrows.get(id);
  v.busy = true;
  board.remove(id);

  if (r.free) {
    sfx.whoosh(); buzz(12);
    anims.push({ type: 'escape', v, t: 0, s: 0, speed: 0 });
  } else {
    sfx.bump(); buzz([30, 40, 30]);
    const before = [...queue, arrow.color];
    const res = pushQueue(queue, arrow.color);
    queue = res.queue;
    sentToQueue++;
    const blockerView = views.get(r.blocker);
    anims.push({ type: 'blocked', v, t: 0, steps: r.steps, before, after: [...queue], matched: res.matched, blocker: blockerView });
    if (queue.length >= QUEUE_SIZE && board.arrows.size > 0) state = 'lost';
  }
  if (board.arrows.size === 0 && state === 'play') state = 'won';
  updateHud();
}

function finishCheck() {
  if (anims.length) return;
  if (state === 'won') { state = 'done'; setTimeout(showWin, 350); }
  else if (state === 'lost') { state = 'done'; setTimeout(showLose, 300); }
}

// ---------------- Animation loop ----------------
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);

  // inertia after swipe
  if (!drag && (Math.abs(velX) > 0.05 || Math.abs(velY) > 0.05)) {
    rotateBy(velX, velY);
    velX *= 0.9; velY *= 0.9;
  }
  // intro pop
  if (introT < 1) {
    introT = Math.min(1, introT + dt * 1.8);
    const e = 1 - Math.pow(1 - introT, 3);
    puzzle.scale.setScalar(0.4 + 0.6 * e + Math.sin(e * Math.PI) * 0.06);
  }

  for (const a of anims) stepAnim(a, dt);
  const was = anims.length;
  anims = anims.filter(a => !a.done);
  if (was && !anims.length) finishCheck();

  // hint pulse
  if (hintTimer > 0) {
    hintTimer -= dt;
    for (const v of views.values()) if (v.hint) {
      v.mat.emissiveIntensity = 0.55 + 0.9 * (0.5 + 0.5 * Math.sin(performance.now() / 110));
      if (hintTimer <= 0) { v.mat.emissiveIntensity = 0.55; v.hint = false; }
    }
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function stepAnim(a, dt) {
  a.t += dt;
  const v = a.v;
  if (a.type === 'turn') {
    const e = Math.min(1, a.t / 0.5);
    puzzle.quaternion.slerpQuaternions(a.from, a.to, 1 - Math.pow(1 - e, 3));
    velX = velY = 0;
    if (e >= 1) a.done = true;
  } else if (a.type === 'escape') {
    a.speed = Math.min(a.speed + dt * 70, 26);
    a.s += a.speed * dt;
    setViewOffset(v, a.s);
    if (a.s > v.len + 1.5) v.mat.opacity = Math.max(0, 1 - (a.s - v.len - 1.5) / 6);
    if (a.s > v.len + 9) { disposeView(v); views.delete(v.id); a.done = true; }
  } else if (a.type === 'blocked') {
    const reach = a.steps + 0.18;
    const T1 = 0.08 + reach * 0.06, T2 = 0.18, T3 = 0.38;
    if (a.t < T1) {
      const e = a.t / T1; setViewOffset(v, reach * e * e);
    } else if (a.t < T1 + T2) {
      if (!a.hitDone) {
        a.hitDone = true;
        v.mat.emissive.setHex(0xff2a4a); v.mat.color.setHex(0xff2a4a);
        if (a.blocker && !a.blocker.busy) a.blocker.shake = 0.25;
      }
      const e = (a.t - T1) / T2; setViewOffset(v, reach * (1 - e));
    } else if (a.t < T1 + T2 + T3) {
      if (!a.queued) {
        a.queued = true; sfx.queue();
        renderQueue(a.before, a.matched);
        if (a.matched) setTimeout(() => { renderQueue(a.after); sfx.match(); toast('MATCH!'); buzz(20); }, 380);
      }
      const e = (a.t - T1 - T2) / T3;
      v.group.scale.setScalar(1 - e);
      v.group.position.copy(v.normal).multiplyScalar(e * 2.5);
      v.mat.opacity = 1 - e;
    } else { disposeView(v); views.delete(v.id); a.done = true; }
    // shake the arrow that blocked us
    if (a.blocker && a.blocker.shake > 0) {
      const b = a.blocker;
      b.shake -= dt;
      const amp = Math.max(0, b.shake) * 0.25;
      b.group.position.copy(b.normal).multiplyScalar(Math.sin(a.t * 70) * amp);
      if (b.shake <= 0) b.group.position.set(0, 0, 0);
    }
  }
}

// ---------------- UI ----------------
function hex(c) { return '#' + c.toString(16).padStart(6, '0'); }

function renderQueue(q, matchColor = null) {
  ui.queue.innerHTML = '';
  let matchedLeft = matchColor !== null ? 3 : 0;
  for (let i = 0; i < QUEUE_SIZE; i++) {
    const d = document.createElement('div');
    d.className = 'slot';
    if (q[i] !== undefined) {
      d.classList.add('filled');
      d.style.background = hex(q[i]);
      if (matchedLeft && q[i] === matchColor) { d.classList.add('match'); matchedLeft--; }
    }
    if (!matchColor && q.length === QUEUE_SIZE - 1 && q[i] === undefined) d.classList.add('danger');
    ui.queue.appendChild(d);
  }
}

function updateHud() {
  ui.level.textContent = 'LEVEL ' + level;
  ui.hintCount.textContent = hintsLeft;
  const cleared = totalArrows - board.arrows.size;
  ui.fill.style.width = (100 * cleared / Math.max(1, totalArrows)) + '%';
  ui.ptext.textContent = cleared + ' / ' + totalArrows;
}

let toastT = null;
function toast(msg) {
  ui.toast.textContent = msg; ui.toast.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => ui.toast.classList.remove('show'), 700);
}
function hideTip() { ui.tip.style.opacity = 0; }

function starsFor() { return sentToQueue === 0 ? 3 : sentToQueue <= 2 ? 2 : 1; }

function showWin() {
  sfx.win(); buzz([20, 50, 20]);
  const stars = starsFor();
  const best = store.get('ac_stars', {});
  best[level] = Math.max(best[level] || 0, stars);
  store.set('ac_stars', best);
  level++;
  store.set('ac_level', level);
  ui.mTitle.textContent = stars === 3 ? 'PERFECT!' : 'LEVEL COMPLETE!';
  [...ui.mStars.children].forEach((s, i) => s.classList.toggle('on', i < stars));
  ui.mStars.classList.remove('hidden');
  ui.mText.textContent = sentToQueue === 0 ? 'No arrows queued — flawless!' : `${sentToQueue} arrow${sentToQueue > 1 ? 's' : ''} hit the queue`;
  ui.mBtn.textContent = 'NEXT';
  ui.mBtn.onclick = () => { hideModal(); startLevel(); };
  ui.modal.classList.remove('hidden');
}
function showLose() {
  sfx.lose(); buzz([60, 60, 120]);
  ui.mTitle.textContent = 'JAMMED!';
  ui.mStars.classList.add('hidden');
  ui.mText.textContent = 'All 4 queue slots filled up. Look for arrows with a clear path first!';
  ui.mBtn.textContent = 'TRY AGAIN';
  ui.mBtn.onclick = () => { hideModal(); startLevel(); };
  ui.modal.classList.remove('hidden');
}
function hideModal() { ui.modal.classList.add('hidden'); }
ui.mBtn2.onclick = () => { hideModal(); showMenu(); };

function startLevel() {
  buildLevel(level);
  state = 'play';
  ui.hud.classList.remove('hidden');
  ui.menu.classList.add('hidden');
  ui.tip.style.opacity = 0.8;
}
function showMenu() {
  state = 'menu';
  ui.menuLevel.textContent = 'Level ' + level;
  ui.btnSound.textContent = 'Sound: ' + (soundOn() ? 'On' : 'Off');
  ui.hud.classList.add('hidden');
  ui.menu.classList.remove('hidden');
  buildLevel(level); // shows a preview spinning behind the menu
  velX = 2.2; velY = 0.6;
}

$('btnPlay').onclick = () => { unlockAudio(); sfx.tap(); startLevel(); };
$('btnMenu').onclick = () => { sfx.tap(); showMenu(); };
$('btnRestart').onclick = () => { sfx.tap(); if (state === 'play' || state === 'done') startLevel(); };
$('btnHint').onclick = () => {
  if (state !== 'play') return;
  if (hintsLeft <= 0) { toast('No hints left'); return; }
  const free = board.freeArrows().filter(id => !views.get(id)?.busy);
  if (!free.length) return;
  // prefer an arrow whose removal frees another arrow
  let pick = free[0];
  for (const id of free) {
    const b = board.clone(); b.remove(id);
    if (b.freeArrows().length > free.length - 1) { pick = id; break; }
  }
  hintsLeft--; updateHud(); sfx.tap();
  const v = views.get(pick); v.hint = true; hintTimer = 2.2;
  // turn the cube so the hinted arrow faces the camera
  const n = v.normal.clone().applyQuaternion(puzzle.quaternion);
  const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0.25, 0.3, 1).normalize());
  anims.push({ type: 'turn', from: puzzle.quaternion.clone(), to: q.multiply(puzzle.quaternion.clone()), t: 0, v: null });
};
ui.btnSound.onclick = () => { toggleSound(); ui.btnSound.textContent = 'Sound: ' + (soundOn() ? 'On' : 'Off'); };
$('btnReset').onclick = () => {
  if (!confirm('Reset all progress back to level 1?')) return;
  level = 1; store.set('ac_level', 1); store.set('ac_stars', {}); showMenu();
};

// ---------------- Boot ----------------
showMenu();
tick();
// handy for testing in a desktop browser console
window.__ac = { get board() { return board; }, get state() { return state; }, get queue() { return queue; }, tapArrow };
