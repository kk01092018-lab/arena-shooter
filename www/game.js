'use strict';
const $ = id => document.getElementById(id);
const clampP = v => Math.max(-1.45, Math.min(1.45, v));

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1018);
scene.fog = new THREE.Fog(0x0d1018, 8, 45);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 100);
camera.rotation.order = 'YXZ';
camera.position.set(0, 1.6, 0);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x303040, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 0.7); sun.position.set(10, 20, 6); scene.add(sun);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

// ---------- arena ----------
const ARENA = 30;
const solids = [], boxes = [];
{
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#1d2230'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#2e3650'; g.lineWidth = 4; g.strokeRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(30, 30);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA * 2, ARENA * 2), new THREE.MeshLambertMaterial({ map: tex }));
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x3a4466 });
  [[0, -ARENA, ARENA * 2, 0.5], [0, ARENA, ARENA * 2, 0.5], [-ARENA, 0, 0.5, ARENA * 2], [ARENA, 0, 0.5, ARENA * 2]]
    .forEach(([x, z, w, d]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 4, d), wallMat);
      m.position.set(x, 2, z); scene.add(m); solids.push(m);
    });
  for (let i = 0; i < 16; i++) {
    let x, z;
    do { x = (Math.random() * 2 - 1) * (ARENA - 5); z = (Math.random() * 2 - 1) * (ARENA - 5); } while (Math.hypot(x, z) < 7);
    const w = 2 + Math.random() * 3, d = 2 + Math.random() * 3, h = 1.5 + Math.random() * 2.5;
    const col = new THREE.Color().setHSL(0.55 + Math.random() * 0.12, 0.3, 0.35);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: col }));
    m.position.set(x, h / 2, z); scene.add(m); solids.push(m);
    boxes.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });
  }
}
function resolve(p, r) {
  const lim = ARENA - r - 0.3;
  p.x = Math.max(-lim, Math.min(lim, p.x)); p.z = Math.max(-lim, Math.min(lim, p.z));
  for (const b of boxes) {
    const cx = Math.max(b.x0, Math.min(p.x, b.x1)), cz = Math.max(b.z0, Math.min(p.z, b.z1));
    const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-6) { const d = Math.sqrt(d2); p.x = cx + dx / d * r; p.z = cz + dz / d * r; }
      else {
        const l = p.x - b.x0, rr = b.x1 - p.x, t = p.z - b.z0, bt = b.z1 - p.z, m = Math.min(l, rr, t, bt);
        if (m === l) p.x = b.x0 - r; else if (m === rr) p.x = b.x1 + r; else if (m === t) p.z = b.z0 - r; else p.z = b.z1 + r;
      }
    }
  }
}

// ---------- gun ----------
const gun = new THREE.Group();
gun.add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.6), new THREE.MeshLambertMaterial({ color: 0x888888 })));
const flash = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffdd55 }));
flash.position.z = -0.38; flash.visible = false; gun.add(flash);
gun.position.set(0.28, -0.25, -0.6); camera.add(gun);

// ---------- state ----------
const S = { playing: false, hp: 100, score: 0, wave: 0, toSpawn: 0, spawnT: 0, nextWaveT: 0, fireT: 0,
  yaw: 0, pitch: 0, flashT: 0, dmgT: 0, bob: 0, overAt: 0, best: 0 };
const player = { x: 0, z: 0 };
let enemies = [], packs = [];
try { S.best = +localStorage.getItem('arena_best') || 0; } catch (e) {}

// ---------- audio ----------
let ac;
function sfx(f, d, type = 'square', v = 0.05) {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(Math.max(40, f * 0.4), t + d);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(t + d);
  } catch (e) {}
}

// ---------- enemies / pickups ----------
function spawnEnemy() {
  const w = S.wave, t = Math.random();
  let type = { hp: 3, speed: 2.6, scale: 1, color: 0xc0392b, dmg: 12 };
  if (w >= 3 && t < 0.25) type = { hp: 2, speed: 4.6, scale: 0.85, color: 0xe67e22, dmg: 9 };
  else if (w >= 4 && t < 0.45) type = { hp: 9, speed: 1.9, scale: 1.4, color: 0x8e44ad, dmg: 20 };
  const grp = new THREE.Group(), mat = new THREE.MeshLambertMaterial({ color: type.color });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.5), mat); body.position.y = 0.9;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 8), mat); head.position.y = 1.76;
  grp.add(body, head); grp.scale.setScalar(type.scale);
  let x, z, tries = 0;
  do { const a = Math.random() * Math.PI * 2; x = Math.cos(a) * (ARENA - 3); z = Math.sin(a) * (ARENA - 3); }
  while (Math.hypot(x - player.x, z - player.z) < 15 && ++tries < 20);
  grp.position.set(x, 0, z);
  grp.userData = { hp: type.hp, speed: type.speed, dmg: type.dmg, mat, head, r: 0.55 * type.scale, flash: 0 };
  scene.add(grp); enemies.push(grp);
}
const packGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5), packMat = new THREE.MeshBasicMaterial({ color: 0x2ecc71 });
function dropPack(x, z) { const m = new THREE.Mesh(packGeo, packMat); m.position.set(x, 0.6, z); scene.add(m); packs.push(m); }
function killEnemy(e) {
  scene.remove(e); enemies.splice(enemies.indexOf(e), 1);
  S.score += 10 + S.wave; sfx(180, 0.25, 'sawtooth', 0.08);
  if (Math.random() < 0.18) dropPack(e.position.x, e.position.z);
}

// ---------- shooting ----------
const ray = new THREE.Raycaster(); ray.far = 60;
function hitMarker(head) {
  const h = $('hit'); h.style.opacity = 1; h.style.filter = head ? 'hue-rotate(60deg) brightness(1.5)' : 'none';
  setTimeout(() => h.style.opacity = 0, 120);
}
function shoot() {
  S.fireT = 0.14; S.flashT = 0.05; flash.visible = true; gun.position.z = -0.5;
  sfx(520, 0.06, 'square', 0.06);
  camera.updateMatrixWorld();
  ray.setFromCamera({ x: 0, y: 0 }, camera);
  const wallHit = ray.intersectObjects(solids, false)[0];
  const h = ray.intersectObjects(enemies, true)[0];
  if (h && (!wallHit || h.distance < wallHit.distance)) {
    let e = h.object; while (e.parent && e.parent !== scene) e = e.parent;
    const u = e.userData, isHead = h.object === u.head;
    u.hp -= isHead ? 2 : 1; u.flash = 0.1; u.mat.emissive.setHex(0xffffff);
    hitMarker(isHead); sfx(900, 0.05, 'triangle', 0.05);
    if (u.hp <= 0) killEnemy(e);
  }
}

// ---------- input ----------
const keys = {}; let mouseFire = false, isTouch = false;
addEventListener('keydown', e => keys[e.code] = true);
addEventListener('keyup', e => keys[e.code] = false);
addEventListener('mousedown', () => {
  if (isTouch || !S.playing) return;
  if (!document.pointerLockElement && renderer.domElement.requestPointerLock) renderer.domElement.requestPointerLock();
  mouseFire = true;
});
addEventListener('mouseup', () => mouseFire = false);
addEventListener('mousemove', e => {
  if (isTouch || !S.playing || !document.pointerLockElement) return;
  S.yaw -= e.movementX * 0.0025; S.pitch = clampP(S.pitch - e.movementY * 0.0025);
});

const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 }, look = { id: null, lx: 0, ly: 0 };
let fireId = null;
const fireBtn = $('fire'), joyEl = $('joy'), knob = $('knob');
function resetTouch() {
  joy.id = look.id = fireId = null; joy.x = joy.y = 0; mouseFire = false;
  joyEl.style.display = 'none'; knob.style.transform = ''; fireBtn.classList.remove('on');
}
const ptOpt = { passive: false };
document.addEventListener('touchstart', e => {
  isTouch = true; if (!S.playing) return; e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.target === fireBtn) { fireId = t.identifier; fireBtn.classList.add('on'); }
    else if (t.clientX < innerWidth * 0.45) {
      if (joy.id === null) {
        joy.id = t.identifier; joy.ox = t.clientX; joy.oy = t.clientY; joy.x = joy.y = 0;
        joyEl.style.display = 'block'; joyEl.style.left = t.clientX + 'px'; joyEl.style.top = t.clientY + 'px';
      }
    } else if (look.id === null) { look.id = t.identifier; look.lx = t.clientX; look.ly = t.clientY; }
  }
}, ptOpt);
document.addEventListener('touchmove', e => {
  if (!S.playing) return; e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) {
      let dx = t.clientX - joy.ox, dy = t.clientY - joy.oy; const R = 55, d = Math.hypot(dx, dy);
      if (d > R) { dx *= R / d; dy *= R / d; }
      joy.x = dx / R; joy.y = dy / R; knob.style.transform = `translate(${dx}px,${dy}px)`;
    } else if (t.identifier === look.id) {
      S.yaw -= (t.clientX - look.lx) * 0.006; S.pitch = clampP(S.pitch - (t.clientY - look.ly) * 0.006);
      look.lx = t.clientX; look.ly = t.clientY;
    }
  }
}, ptOpt);
function tend(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) { joy.id = null; joy.x = joy.y = 0; joyEl.style.display = 'none'; knob.style.transform = ''; }
    else if (t.identifier === look.id) look.id = null;
    else if (t.identifier === fireId) { fireId = null; fireBtn.classList.remove('on'); }
  }
}
document.addEventListener('touchend', tend); document.addEventListener('touchcancel', tend);

// ---------- game flow ----------
function banner(txt) {
  const b = $('banner'); b.textContent = txt; b.style.opacity = 1; setTimeout(() => b.style.opacity = 0, 1500);
}
function nextWave() {
  S.wave++; S.toSpawn = 4 + S.wave * 3; S.spawnT = 0; S.nextWaveT = -1;
  S.hp = Math.min(100, S.hp + 15); banner('WAVE ' + S.wave);
}
function startGame() {
  for (const e of enemies) scene.remove(e); enemies = [];
  for (const p of packs) scene.remove(p); packs = [];
  Object.assign(S, { playing: true, hp: 100, score: 0, wave: 0, toSpawn: 0, spawnT: 0, nextWaveT: 0.5, fireT: 0, yaw: 0, pitch: 0, dmgT: 0, bob: 0 });
  player.x = 0; player.z = 0; resetTouch();
  $('msg').style.display = 'none'; document.body.classList.add('playing');
  sfx(300, 0.1, 'sine', 0.02);
}
function gameOver() {
  S.playing = false; S.overAt = performance.now(); resetTouch(); document.body.classList.remove('playing');
  if (document.exitPointerLock) document.exitPointerLock();
  if (S.score > S.best) { S.best = S.score; try { localStorage.setItem('arena_best', S.best); } catch (e) {} }
  $('msg').innerHTML = `<h1>GAME OVER</h1><p>Score: ${S.score} &nbsp;·&nbsp; Wave: ${S.wave} &nbsp;·&nbsp; Best: ${S.best}</p><p class="big">TAP TO RESTART</p>`;
  $('msg').style.display = 'flex';
}
$('msg').addEventListener('click', () => { if (!S.playing && performance.now() - S.overAt > 800) startGame(); });

// ---------- update loop ----------
function update(dt) {
  S.flashT -= dt; if (S.flashT <= 0) flash.visible = false;
  gun.position.z += (-0.6 - gun.position.z) * Math.min(1, dt * 20);
  S.dmgT = Math.max(0, S.dmgT - dt); $('dmg').style.opacity = Math.min(1, S.dmgT * 2.5);
  if (!S.playing) return;

  let f = 0, r = 0;
  if (keys.KeyW || keys.ArrowUp) f += 1; if (keys.KeyS || keys.ArrowDown) f -= 1;
  if (keys.KeyD) r += 1; if (keys.KeyA) r -= 1;
  f += -joy.y; r += joy.x;
  const l = Math.hypot(f, r); if (l > 1) { f /= l; r /= l; }
  const sy = Math.sin(S.yaw), cy = Math.cos(S.yaw);
  player.x += (-sy * f + cy * r) * 6 * dt; player.z += (-cy * f - sy * r) * 6 * dt;
  resolve(player, 0.45);
  S.bob += Math.min(1, l) * dt * 10;
  camera.position.set(player.x, 1.6 + Math.sin(S.bob) * 0.03 * Math.min(1, l), player.z);
  camera.rotation.set(S.pitch, S.yaw, 0);

  S.fireT -= dt;
  if ((fireId !== null || mouseFire || keys.Space) && S.fireT <= 0) shoot();

  for (const e of enemies) {
    const u = e.userData, dx = player.x - e.position.x, dz = player.z - e.position.z, d = Math.hypot(dx, dz) || 1;
    if (d > 1.1) { e.position.x += dx / d * u.speed * dt; e.position.z += dz / d * u.speed * dt; }
    e.rotation.y = Math.atan2(dx, dz);
    e.position.y = Math.abs(Math.sin(performance.now() / 150 + e.id)) * 0.08;
    if (u.flash > 0) { u.flash -= dt; if (u.flash <= 0) u.mat.emissive.setHex(0); }
    if (d < 1.5) { S.hp -= u.dmg * dt; S.dmgT = 0.3; }
  }
  for (let i = 0; i < enemies.length; i++) for (let j = i + 1; j < enemies.length; j++) {
    const a = enemies[i].position, b = enemies[j].position; let dx = a.x - b.x, dz = a.z - b.z; const d = Math.hypot(dx, dz);
    if (d > 0 && d < 1) { const p = (1 - d) / 2; dx /= d; dz /= d; a.x += dx * p; a.z += dz * p; b.x -= dx * p; b.z -= dz * p; }
  }
  for (const e of enemies) resolve(e.position, e.userData.r);

  for (let i = packs.length - 1; i >= 0; i--) {
    const p = packs[i]; p.rotation.y += dt * 2;
    if (Math.hypot(p.position.x - player.x, p.position.z - player.z) < 1.2) {
      S.hp = Math.min(100, S.hp + 25); scene.remove(p); packs.splice(i, 1); sfx(700, 0.2, 'sine', 0.06);
    }
  }

  if (S.toSpawn > 0) {
    S.spawnT -= dt;
    if (S.spawnT <= 0 && enemies.length < 18) { spawnEnemy(); S.toSpawn--; S.spawnT = Math.max(0.35, 1.2 - S.wave * 0.08); }
  } else if (enemies.length === 0) {
    if (S.nextWaveT < 0) S.nextWaveT = 2.5;
    S.nextWaveT -= dt; if (S.nextWaveT <= 0) nextWave();
  }

  $('hp').style.width = Math.max(0, S.hp) + '%';
  $('info').textContent = 'Wave ' + S.wave + '  ·  Score ' + S.score;
  if (S.hp <= 0) gameOver();
}
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  update(dt); renderer.render(scene, camera);
}
requestAnimationFrame(loop);
