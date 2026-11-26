// Tiny synthesized sound effects — no audio files needed.
let ctx = null;
let enabled = true;
try { enabled = localStorage.getItem('ac_sound') !== '0'; } catch (e) {}

export function soundOn() { return enabled; }
export function toggleSound() {
  enabled = !enabled;
  try { localStorage.setItem('ac_sound', enabled ? '1' : '0'); } catch (e) {}
  return enabled;
}
export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

function tone(freq, dur, type = 'sine', vol = 0.18, slideTo = null, delay = 0) {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(dur, from, to, vol = 0.15) {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime;
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
  f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t);
}

export const sfx = {
  whoosh() { noise(0.35, 600, 4000, 0.22); tone(520, 0.18, 'triangle', 0.08, 1100); },
  bump() { tone(140, 0.18, 'square', 0.12, 70); },
  queue() { tone(330, 0.12, 'triangle', 0.12, 220, 0.12); },
  match() { [660, 880, 1100].forEach((f, i) => tone(f, 0.18, 'triangle', 0.14, null, i * 0.07)); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.16, null, i * 0.11)); },
  lose() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.3, 'sawtooth', 0.08, null, i * 0.14)); },
  tap() { tone(900, 0.05, 'sine', 0.06); },
};

export function buzz(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
}
