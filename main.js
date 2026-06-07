/* ============================================================
   Color Queue: Desktop Panic
   - Queue 연산 딜레이 (Merge 0.5s lock)
   - Subset 방어막 판정
   - Glitch 청소 (collision-based)
   - 5-stage loop infinity (X-1 normal / X-2 single / X-3 mixed / X-4 shop / X-5 boss)
   - Data Bit 재화 + 상점 (인플레이션 공식)
   - 보스 3종 + 페이즈 2 + 방화벽(Firewall) 기믹
   ============================================================ */
(() => {
'use strict';

// =====================================================
//  DEBUG FLAGS
// =====================================================
// When true: each non-boss stage spawns only 1 mob instead of the designed wave.
// Boss stages are unaffected (spawnBoss already spawns exactly 1 boss).
// Flip back to `false` to restore the original hardcore difficulty curve.
let DEBUG_SINGLE_MOB = false;        // F7 키로 토글 가능

// When true: every shop AND lobby purchase costs exactly 1 bit.
// Use to quickly verify item effects/UI behavior without grinding economy.
// Flip back to `false` for normal pricing (Defrag 15, Bus Overclock 40, etc.).
let DEBUG_CHEAP_PRICES = false;      // F8 키로 토글 가능

// =====================================================
//  Canvas / DOM
// =====================================================
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width;   // 960
const H = canvas.height;  // 608

const $ = (id) => document.getElementById(id);

const ui = {
  stage:     $('stage-indicator'),
  hpFill:    $('hp-fill'),
  hpText:    $('hp-text'),
  bits:      $('db-count'),
  shopBits:  $('shop-db-count'),
  kill:      $('kill-counter'),
  qMaxLabel: $('queue-max-label'),
  slots:     Array.from(document.querySelectorAll('#ammo-slots .ammo-slot')),
  holdSlot:  $('hold-slot'),
  shopGrid:  $('shop-grid'),
  shopContinue: $('shop-continue'),
  banner:    { root: $('banner-overlay'), title: $('banner-title'), sub: $('banner-sub') },
  overlays: {
    loading:  $('loading-overlay'),
    title:    $('title-overlay'),
    banner:   $('banner-overlay'),
    shop:     $('shop-overlay'),
    gameover: $('gameover-overlay'),
  },
  goStat: $('go-stat'),
  lobbyCore: $('lobby-core-count'),
  lobbyConv: $('lobby-conv'),
  lobbyGrid: $('lobby-grid'),
  rebootBtn: $('reboot-btn'),
};

function showOverlay(name) {
  Object.entries(ui.overlays).forEach(([k, el]) => {
    el.classList.toggle('hidden', k !== name);
  });
}
function hideAllOverlays() {
  Object.values(ui.overlays).forEach(el => el.classList.add('hidden'));
}
function showBannerFor(t, title, sub) {
  ui.banner.title.textContent = title;
  ui.banner.sub.textContent = sub;
  ui.banner.root.classList.remove('hidden');
  setTimeout(() => ui.banner.root.classList.add('hidden'), t * 1000);
}

// =====================================================
//  Assets (procedural — no external for now)
// =====================================================
const ASSETS = {};
function loadImage(src, timeoutMs = 4000) {
  return new Promise((res, rej) => {
    const img = new Image();
    const t = setTimeout(() => rej(new Error('Timeout: ' + src)), timeoutMs);
    img.onload  = () => { clearTimeout(t); res(img); };
    img.onerror = () => { clearTimeout(t); rej(new Error('Failed: ' + src)); };
    img.src = src;
  });
}

// ---- Sprite sheet configuration ----
// Astro player: 3 sheets, 140x100 per frame, 4 rows = 4 directions
const SPR_ASTRO = {
  run:  { src: 'assets/character/Astro-run-gun 140x100.png',       fw: 140, fh: 100, cols: 8, fps: 14, loop: true },
  dash: { src: 'assets/character/Astro-dash-gun-flash 140x100.png', fw: 140, fh: 100, cols: 6, fps: 22, loop: false },
  hit:  { src: 'assets/character/Astro-hit damage-gun140x100.png',  fw: 140, fh: 100, cols: 5, fps: 18, loop: false },
};
// Direction → row index (top to bottom of sprite sheet).
// ⚠ Verified by in-game test: row 1 actually faces LEFT, row 3 faces RIGHT.
// The visual zoom was misleading — gun orientation in profile sprites is opposite
// to first-glance interpretation. Mapping swapped accordingly.
const ASTRO_DIR_ROW = { down: 0, left: 1, up: 2, right: 3 };

// Explicit X/Y comparison → row index. Used in updatePlayer/updateLobby.
// Guarantees left/right correctness regardless of atan2 quadrant quirks.
function astroRowFromAim(px, py, mx, my) {
  const dx = mx - px;
  const dy = my - py;
  if (Math.abs(dx) >= Math.abs(dy)) {
    // mouseX vs player.x  →  right if dx>0, left otherwise
    return dx > 0 ? ASTRO_DIR_ROW.right : ASTRO_DIR_ROW.left;
  } else {
    return dy > 0 ? ASTRO_DIR_ROW.down : ASTRO_DIR_ROW.up;
  }
}

// Spider (melee): 96 × 96 per cell. The sheet is 1344×672, but the actual content
// only fills the top 576 px (6 rows × 96). The bottom 96 px is unused empty space.
// ⚠ Naive (image.height / 6 = 112) is wrong — it would cause vertical bleeding from
// the next row's sprite into the current row's draw area. Confirmed by measuring
// content-block center spacing: rows are exactly 96 px apart.
//
// Per-row maxFrames is set explicitly based on actual animation length:
//   • Attack row: 9 spider frames + extra blur cells → cap at 9
//   • Walk   row: 6 stride frames
const SPR_SPIDER = {
  src: 'assets/melee_mob/Spider.png',
  fw: 96, fh: 96,                            // square cells (not 96×112)
  anims: {
    attack: { row: 0, count: 9, fps: 18 },
    death:  { row: 1, count: 9, fps: 12 },
    hurt:   { row: 2, count: 7, fps: 16 },
    walk:   { row: 3, count: 6, fps: 12, loop: true },
    idle:   { row: 4, count: 4, fps: 8,  loop: true },
  },
};
// Drone (ranged): 96x96 per frame (square).
// ⚠ Attack row: frames 0..7 contain the drone body charging up. Frames 8..12
// are "projectile-only" cells where the drone vanishes and only motion particles
// remain — using them causes the boss to look INVISIBLE during phase 2 (when
// fireCd cycles fast enough to consume the entire animation). Cap at 8 frames
// and pick fps so the animation duration matches the 0.5s telegraph window
// exactly (8 / 16 = 0.5s → walk takes over cleanly when cooldown expires).
const SPR_DRONE = {
  src: 'assets/ranged_mob/Drone.png',
  fw: 96, fh: 96,
  anims: {
    attack: { row: 0, count: 8,  fps: 16 },  // body-only frames
    death:  { row: 1, count: 12, fps: 14 },
    hurt:   { row: 2, count: 4,  fps: 12 },
    walk:   { row: 3, count: 5,  fps: 8, loop: true },
    idle:   { row: 4, count: 6,  fps: 8, loop: true },
  },
};

async function preloadAssets() {
  // Boot must NEVER block on assets — fallback is procedural shapes.
  // Kick all loads off in background; resolve immediately so the game starts.
  const tasks = [
    [SPR_ASTRO.run.src,  'astroRun'],
    [SPR_ASTRO.dash.src, 'astroDash'],
    [SPR_ASTRO.hit.src,  'astroHit'],
    [SPR_SPIDER.src,     'spider'],
    [SPR_DRONE.src,      'drone'],
  ];
  for (const [src, key] of tasks) {
    loadImage(src)
      .then(img => { ASSETS[key] = img; })
      .catch(err => console.warn(`[assets] ${key} skipped:`, err.message));
  }
  // tiny tick so DOM has a chance to paint the loading frame
  await new Promise(r => setTimeout(r, 50));
}

// =====================================================
//  Input
// =====================================================
const keys = new Set();
const justPressed = new Set();

// ── 디버그 메시지 — 한 번에 한 줄만, 2초 후 자동 사라짐 ──
// floaters 처럼 누적되지 않고 항상 가장 최신 메시지로 덮어쓰기.
let debugMsg = null;     // { text, color, until } | null
function showDebugMsg(text, color) {
  debugMsg = { text, color: color || '#3ddc6b', until: performance.now() + 2000 };
}
function drawDebugMessage() {
  if (!debugMsg) return;
  const now = performance.now();
  if (now >= debugMsg.until) {
    debugMsg = null;        // 시간 지나면 즉시 비움 (잔상 제거)
    return;
  }
  const remainMs = debugMsg.until - now;
  // 마지막 0.4초 동안 fade out
  const alpha = Math.min(1, remainMs / 400);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 14px monospace';
  ctx.globalAlpha = alpha;
  ctx.shadowColor = debugMsg.color;
  ctx.shadowBlur  = 12;
  ctx.fillStyle   = debugMsg.color;
  ctx.fillText(debugMsg.text, W / 2, 120);
  ctx.shadowBlur  = 0;
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────
//  Pause Menu — 사이버펑크 옵션 패널 + 3 볼륨 슬라이더
// ─────────────────────────────────────────────────────────────────────────
function drawPauseMenu() {
  if (!PauseMenu.open) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // 어두운 반투명 백드롭
  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.fillRect(0, 0, W, H);

  // 미세 시안 그리드 (사이버 톤)
  ctx.strokeStyle = 'rgba(77, 226, 255, 0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 32) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  // 중앙 패널
  const pw = 440, ph = 320;
  const px = (W - pw) / 2;
  const py = (H - ph) / 2;

  // 패널 배경
  ctx.fillStyle = 'rgba(20, 24, 42, 0.92)';
  ctx.fillRect(px, py, pw, ph);
  // 외곽선 (시안)
  ctx.strokeStyle = '#4de2ff';
  ctx.shadowColor = '#4de2ff';
  ctx.shadowBlur  = 14;
  ctx.lineWidth   = 1.5;
  ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
  // 4 코너 brackets
  ctx.shadowBlur = 0;
  const cl = 14;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px,        py + cl);     ctx.lineTo(px,        py);          ctx.lineTo(px + cl,  py);
  ctx.moveTo(px + pw - cl, py);          ctx.lineTo(px + pw,  py);          ctx.lineTo(px + pw,  py + cl);
  ctx.moveTo(px,        py + ph - cl); ctx.lineTo(px,        py + ph);     ctx.lineTo(px + cl,  py + ph);
  ctx.moveTo(px + pw - cl, py + ph);     ctx.lineTo(px + pw,  py + ph);     ctx.lineTo(px + pw,  py + ph - cl);
  ctx.stroke();

  // 타이틀
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 30px monospace';
  ctx.fillStyle = '#4de2ff';
  ctx.shadowColor = '#4de2ff';
  ctx.shadowBlur  = 20;
  ctx.fillText('// PAUSED', W / 2, py + 36);
  ctx.shadowBlur = 0;

  // 서브 타이틀
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = '#aab2c5';
  ctx.fillText('// SYSTEM OPTIONS', W / 2, py + 60);

  // 슬라이더 3개
  const sliderW = 280;
  const sliderH = 8;
  const sliderX = (W - sliderW) / 2;
  let sy = py + 100;
  const trackRects = {};
  ctx.textAlign = 'left';
  ctx.font = 'bold 13px monospace';

  for (const s of PauseMenu.sliders) {
    const val = Math.max(0, Math.min(1, s.get()));
    // 라벨 (좌측)
    ctx.fillStyle = '#aef4ff';
    ctx.shadowColor = '#4de2ff';
    ctx.shadowBlur  = 4;
    ctx.fillText(s.label, sliderX, sy + 3);
    // 퍼센트 (우측)
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd166';
    ctx.shadowColor = '#ff8a00';
    ctx.fillText(`${Math.round(val * 100)}%`, sliderX + sliderW, sy + 3);
    ctx.textAlign = 'left';
    ctx.shadowBlur = 0;

    // 트랙 배경
    const trackY = sy + 22;
    ctx.fillStyle = 'rgba(77, 226, 255, 0.12)';
    ctx.fillRect(sliderX, trackY, sliderW, sliderH);
    // 트랙 외곽선
    ctx.strokeStyle = 'rgba(77, 226, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sliderX + 0.5, trackY + 0.5, sliderW - 1, sliderH - 1);
    // 채워진 영역
    const fillW = sliderW * val;
    const grad = ctx.createLinearGradient(sliderX, 0, sliderX + sliderW, 0);
    grad.addColorStop(0, '#4de2ff');
    grad.addColorStop(1, '#ff4dd2');
    ctx.fillStyle = grad;
    ctx.shadowColor = '#4de2ff';
    ctx.shadowBlur  = 8;
    ctx.fillRect(sliderX, trackY, fillW, sliderH);
    ctx.shadowBlur = 0;
    // 손잡이 (knob)
    const knobX = sliderX + fillW;
    const knobY = trackY + sliderH / 2;
    const isDragging = (PauseMenu.draggingKey === s.key);
    ctx.fillStyle   = isDragging ? '#ffffff' : '#aef4ff';
    ctx.shadowColor = '#4de2ff';
    ctx.shadowBlur  = isDragging ? 16 : 10;
    ctx.beginPath();
    ctx.arc(knobX, knobY, isDragging ? 8 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // hit-test 영역 저장
    trackRects[s.key] = { x: sliderX, y: trackY, w: sliderW, h: sliderH };
    sy += 56;
  }
  PauseMenu.trackRects = trackRects;

  // 하단 안내
  ctx.textAlign = 'center';
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = '#aab2c5';
  ctx.fillText('[ESC]  RESUME', W / 2, py + ph - 30);
  ctx.fillStyle = 'rgba(170, 178, 197, 0.6)';
  ctx.font = '10px monospace';
  ctx.fillText('드래그로 볼륨 조절 · 설정은 자동 저장', W / 2, py + ph - 14);

  ctx.restore();
}
window.addEventListener('keydown', (e) => {
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
  if (!keys.has(e.code)) justPressed.add(e.code);
  keys.add(e.code);

  // ── ESC — 일시정지 메뉴 토글 ──
  // playing / boss_intro / lobby / shop 상태에서만 작동. 엔딩/타이틀은 무시.
  if (e.code === 'Escape') {
    const allowedStates = ['playing', 'boss_intro', 'lobby', 'shop'];
    if (allowedStates.includes(G.state)) {
      e.preventDefault();
      PauseMenu.toggle();
    }
  }

  // ── [DEBUG] F1/F2/F3 — 보스 스테이지 즉시 점프 ──
  // F1 → 1-5 (Spider melee)
  // F2 → 2-5 (Drone ranged)
  // F3 → 3-5 (Twin Boss — Dual Core)
  // 항상 newGame() 으로 깨끗한 런 시작 후 startStage(target) 으로 점프.
  // 영구 강화(coreBits/lobby.upgrades) 는 유지됨 (newGame 이 그대로 둠).
  if (e.code === 'F1' || e.code === 'F2' || e.code === 'F3') {
    e.preventDefault();
    if (G.ending) return;                  // 엔딩 시퀀스 진행 중엔 무시
    const stageMap  = { F1: 5, F2: 10, F3: 15 };
    const target    = stageMap[e.code];
    if (typeof newGame === 'function' && typeof startStage === 'function') {
      newGame();                           // 깨끗한 init + state='playing' + HUD 복귀
      startStage(target);                  // 곧바로 목표 보스 스테이지로 덮어쓰기
    }
  }

  // ── [DEBUG] F7 — DEBUG_SINGLE_MOB 토글 (몬스터 1마리만 스폰) ──
  if (e.code === 'F7') {
    e.preventDefault();
    DEBUG_SINGLE_MOB = !DEBUG_SINGLE_MOB;
    const msg = DEBUG_SINGLE_MOB ? 'DEBUG: SINGLE MOB ON' : 'DEBUG: SINGLE MOB OFF';
    const color = DEBUG_SINGLE_MOB ? '#3ddc6b' : '#ff8a4d';
    showDebugMsg(msg, color);           // ← 한 줄짜리 덮어쓰기 메시지
    if (typeof SoundManager !== 'undefined') SoundManager.playSFX('click');
    console.log(`[DEBUG] DEBUG_SINGLE_MOB = ${DEBUG_SINGLE_MOB} (next stage applies)`);
  }

  // ── [DEBUG] F8 — DEBUG_CHEAP_PRICES 토글 (상점/로비 가격 1) ──
  if (e.code === 'F8') {
    e.preventDefault();
    DEBUG_CHEAP_PRICES = !DEBUG_CHEAP_PRICES;
    const msg = DEBUG_CHEAP_PRICES ? 'DEBUG: CHEAP PRICES ON' : 'DEBUG: CHEAP PRICES OFF';
    const color = DEBUG_CHEAP_PRICES ? '#3ddc6b' : '#ff8a4d';
    showDebugMsg(msg, color);           // ← 이전 디버그 메시지 즉시 덮어쓰기
    if (typeof SoundManager !== 'undefined') SoundManager.playSFX('click');
    if (typeof renderShop === 'function' && G.state === 'shop') renderShop();
    console.log(`[DEBUG] DEBUG_CHEAP_PRICES = ${DEBUG_CHEAP_PRICES}`);
  }

  // ── [DEBUG] F9 — 즉시 엔딩 시퀀스 발동 ──
  // 인게임 어느 상태에서든 호출 가능. 가짜 트윈 보스 객체를 만들어
  // triggerFinalBossDefeat() 에 넘겨주면 정상 시퀀스가 그대로 재생됨.
  // 시연/녹화/테스트용 — 정식 빌드에서 제거하거나 플래그로 가두는 게 좋음.
  if (e.code === 'F9') {
    e.preventDefault();
    if (typeof triggerFinalBossDefeat === 'function' && !G.ending) {
      const pl = G.player || { x: W * 0.5, y: H * 0.5 };
      const fakeBoss = {
        x: pl.x, y: pl.y,         // 폭발 중심 = 플레이어 위치 (cleanse 충격파와 일치)
        r: 50,
        isBoss: true,
        isTwinBoss: true,         // 트윈 60 sBit 보너스
        isDying: false,
        hp: 0,
      };
      // 실제 게임 통계 (playTime, hitsTaken, colorsMerged) 그대로 사용
      triggerFinalBossDefeat(fakeBoss);
    }
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
function consumeJustPressed(code) {
  if (justPressed.has(code)) { justPressed.delete(code); return true; }
  return false;
}

// =====================================================
//  SoundManager — BGM + SFX with Overlap + Autoplay Unlock
// =====================================================
//   • playSFX: Audio.cloneNode 로 매번 복제 → 같은 효과음 연속 재생 시 끊김 없음
//   • unlock(): 첫 user gesture (keydown / mousedown / touchstart) 에서 호출
//   • BGM/SFX 볼륨 따로 (기본: BGM 0.3, SFX 0.5)
//   • 경로 baseSfxPath / baseBgmPath = 'assets/sounds/'
//   • 사운드 파일이 없어도 silent fail (catch on play promise)
// =====================================================
const SoundManager = {
  // ── Mixer: master × channel × perSFX ──
  //   final = masterVolume × (bgmChannel | sfxChannel) × (per-SFX scale)
  //   유저가 "전체 작다" 하면 masterVolume 만 키우면 됨 (예: 1.0 → 1.5)
  masterVolume: 1.0,               // 게임 전체 볼륨 (0.0 ~ 1.0+)
  bgmChannel:   0.6,               // BGM 채널 고정 비율 (60%)
  sfxChannel:   0.9,               // SFX 채널 고정 비율 (90%)

  // ── Legacy compat — 일부 외부 코드가 이 키를 참조할 수 있어 유지. ──
  //   읽기 전용 미러: bgmVolume = masterVolume × bgmChannel
  //   (setBgmVolume / setSfxVolume 은 채널값 setter 로 매핑됨)
  get bgmVolume() { return this.masterVolume * this.bgmChannel; },
  get sfxVolume() { return this.masterVolume * this.sfxChannel; },

  basePath:   'assets/sounds/',
  unlocked:   false,
  bgm:        null,
  bgmKey:     null,
  _pendingBgm: null,
  sfxCache:   {},                  // name → 원본 Audio 객체

  // SFX 로딩 — name → 파일명. volume 지정 가능 (UI 사운드 0.4 등 개별 볼륨).
  loadSFX(name, filename, volume) {
    try {
      const a = new Audio(this.basePath + filename);
      a.preload  = 'auto';
      a._volume  = (volume != null ? volume : this.sfxVolume);   // clone 시 사용
      a.volume   = a._volume;
      this.sfxCache[name] = a;
    } catch (_) { /* silent */ }
  },

  // SFX 재생 — cloneNode 로 overlap 보장. final = master × sfxChannel × perSFX
  playSFX(name) {
    if (!this.unlocked) return;
    const orig = this.sfxCache[name];
    if (!orig) return;
    try {
      const clone = orig.cloneNode();
      clone.volume = this._effectiveSfxVolume(orig);
      const pr = clone.play();
      if (pr && typeof pr.catch === 'function') pr.catch(() => {});
    } catch (_) { /* silent */ }
  },

  // ── 채널별 최종 볼륨 계산 헬퍼 (Mixer) ──
  _effectiveBgmVolume() {
    return this._clamp01(this.masterVolume * this.bgmChannel);
  },
  _effectiveSfxVolume(audio) {
    // per-SFX scale (등록 시 지정) 가 SFX 채널 내부의 상대 비율
    const perSFX = (audio && audio._volume != null) ? audio._volume : 1;
    return this._clamp01(this.masterVolume * this.sfxChannel * perSFX);
  },
  _clamp01(v) { return Math.max(0, Math.min(1, v)); },

  // BGM 키 → 파일 매핑 (assets/sounds/bgm/*.wav)
  bgmFiles: {
    stage: 'bgm/stage.wav',
    boss:  'bgm/boss.wav',
    lobby: 'bgm/lobby.wav',
  },

  // BGM 재생 (crossfade) — playBGM('stage'|'boss'|'lobby')
  //   같은 트랙이 이미 재생 중이면 무시. 다른 트랙이면 1초 fade-out + fade-in.
  playBGM(key) {
    const filename = this.bgmFiles[key] || key;   // key 직접 파일명도 허용
    if (!this.unlocked) {
      this._pendingBgm = key;
      return;
    }
    if (this.bgm && this.bgmKey === key) return;   // 동일 트랙 — 무시

    // 진행 중인 fade 가 있으면 중단
    if (this._fadeId) {
      clearInterval(this._fadeId);
      this._fadeId = null;
    }

    const oldBgm = this.bgm;
    const oldVol = oldBgm ? oldBgm.volume : 0;
    const targetVol = this._effectiveBgmVolume();   // master × bgmChannel

    // 새 BGM 생성 — 볼륨 0 으로 시작
    let newBgm = null;
    try {
      newBgm = new Audio(this.basePath + filename);
      newBgm.loop   = true;
      newBgm.volume = 0;
      const pr = newBgm.play();
      if (pr && typeof pr.catch === 'function') pr.catch(() => {});
    } catch (_) { newBgm = null; }

    this.bgm    = newBgm;
    this.bgmKey = key;

    // ── Crossfade: 1초 동안 oldBgm 페이드아웃 + newBgm 페이드인 ──
    const fadeDur = 1000;
    const startT  = performance.now();
    const self    = this;
    this._fadeId = setInterval(() => {
      const k = Math.min(1, (performance.now() - startT) / fadeDur);
      if (oldBgm) {
        try { oldBgm.volume = Math.max(0, oldVol * (1 - k)); } catch (_) {}
      }
      if (newBgm) {
        // fade in 중에도 mixer 변경 가능 → 매 tick targetVol 재계산
        try { newBgm.volume = self._effectiveBgmVolume() * k; } catch (_) {}
      }
      if (k >= 1) {
        if (oldBgm) { try { oldBgm.pause(); } catch (_) {} }
        clearInterval(self._fadeId);
        self._fadeId = null;
      }
    }, 33);
  },

  stopBGM() {
    if (this.bgm) {
      try { this.bgm.pause(); this.bgm.currentTime = 0; } catch (_) {}
    }
  },

  // ── Mixer 제어 setter ──
  //   setMasterVolume(v)  → 전체 볼륨 (이걸로 한 번에 키우거나 줄임)
  //   setBgmChannel(v)    → BGM 채널 비율 (기본 0.6)
  //   setSfxChannel(v)    → SFX 채널 비율 (기본 0.9)
  //   setBgmVolume(v)/setSfxVolume(v) → legacy 호환: 채널값 setter 로 매핑
  setMasterVolume(v) {
    this.masterVolume = this._clamp01(v);
    this._applyBgmVolumeNow();
  },
  setBgmChannel(v) {
    this.bgmChannel = this._clamp01(v);
    this._applyBgmVolumeNow();
  },
  setSfxChannel(v) {
    this.sfxChannel = this._clamp01(v);
  },
  // Legacy aliases
  setBgmVolume(v) { this.setBgmChannel(v); },
  setSfxVolume(v) { this.setSfxChannel(v); },

  // 현재 재생 중 BGM 볼륨을 즉시 갱신 (fade 진행 중이 아닐 때만)
  _applyBgmVolumeNow() {
    if (this.bgm && !this._fadeId) this.bgm.volume = this._effectiveBgmVolume();
  },

  // 첫 user gesture 시 호출 → 모든 캐시된 Audio 의 자동재생 잠금 해제
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    // 모든 sfxCache 의 audio 를 "load" 호출 — 일부 브라우저는 user gesture 안에서 만져야 unlock
    for (const a of Object.values(this.sfxCache)) {
      try { a.load(); } catch (_) {}
    }
    if (this._pendingBgm) {
      const f = this._pendingBgm;
      this._pendingBgm = null;
      this.playBGM(f);
    } else {
      // pending BGM 이 없으면 기본 'stage' (또는 'lobby') 로 시작 — 타이틀 ambient
      this.playBGM('lobby');
    }
  },
};

// =====================================================
//  PauseMenu — ESC 일시정지 + 3 볼륨 슬라이더
// =====================================================
const PauseMenu = {
  open: false,
  draggingKey: null,           // 현재 드래그 중인 슬라이더 키 (master/bgm/sfx)
  _wasMouseDown: false,        // mousedown edge 감지

  // 슬라이더 hitbox (canvas 좌표) — drawPauseMenu 에서 동기화
  sliders: [
    { key: 'master', label: 'MASTER',  get: () => SoundManager.masterVolume, set: (v) => SoundManager.setMasterVolume(v) },
    { key: 'bgm',    label: 'BGM',     get: () => SoundManager.bgmChannel,   set: (v) => SoundManager.setBgmChannel(v)   },
    { key: 'sfx',    label: 'SFX',     get: () => SoundManager.sfxChannel,   set: (v) => SoundManager.setSfxChannel(v)   },
  ],

  // 슬라이더 트랙 (mouse hit-test) — 매 프레임 drawPauseMenu 가 갱신
  trackRects: null,

  toggle() {
    if (this.open) this.close();
    else           this.open_();
  },
  open_() {
    this.open = true;
    G.paused = true;
  },
  close() {
    this.open = false;
    G.paused = false;
    this.draggingKey = null;
    saveVolumeSettings();
  },

  // 매 프레임 호출 (paused 동안만) — 슬라이더 드래그 입력 처리
  update() {
    if (!this.open) return;
    const isDown = mouseDown.left;
    if (isDown && !this._wasMouseDown) {
      // mousedown edge — 어떤 슬라이더에 클릭됐는지 검사
      const rects = this.trackRects;
      if (rects) {
        for (const s of this.sliders) {
          const r = rects[s.key];
          if (!r) continue;
          if (mouse.x >= r.x - 6 && mouse.x <= r.x + r.w + 6 &&
              mouse.y >= r.y - 8 && mouse.y <= r.y + r.h + 8) {
            this.draggingKey = s.key;
            break;
          }
        }
      }
    }
    if (!isDown) this.draggingKey = null;

    // 드래그 중 → 값 갱신
    if (this.draggingKey) {
      const r = this.trackRects && this.trackRects[this.draggingKey];
      const s = this.sliders.find(x => x.key === this.draggingKey);
      if (r && s) {
        const k = (mouse.x - r.x) / r.w;
        s.set(Math.max(0, Math.min(1, k)));
      }
    }
    this._wasMouseDown = isDown;
  },
};

// ── 볼륨 설정 영구 저장 (sessionStorage) ──
function saveVolumeSettings() {
  try {
    sessionStorage.setItem('vol_settings', JSON.stringify({
      master: SoundManager.masterVolume,
      bgm:    SoundManager.bgmChannel,
      sfx:    SoundManager.sfxChannel,
    }));
  } catch (_) {}
}
function loadVolumeSettings() {
  try {
    const s = JSON.parse(sessionStorage.getItem('vol_settings') || 'null');
    if (s) {
      if (typeof s.master === 'number') SoundManager.masterVolume = Math.max(0, Math.min(1, s.master));
      if (typeof s.bgm    === 'number') SoundManager.bgmChannel   = Math.max(0, Math.min(1, s.bgm));
      if (typeof s.sfx    === 'number') SoundManager.sfxChannel   = Math.max(0, Math.min(1, s.sfx));
    }
  } catch (_) {}
}
loadVolumeSettings();    // 부팅 시 1회 로드

// 첫 user 입력에 SoundManager.unlock 호출 (autoplay policy 대응)
(function setupAudioUnlock() {
  const unlockOnce = () => {
    SoundManager.unlock();
    window.removeEventListener('keydown',    unlockOnce);
    window.removeEventListener('mousedown',  unlockOnce);
    window.removeEventListener('touchstart', unlockOnce);
  };
  window.addEventListener('keydown',    unlockOnce);
  window.addEventListener('mousedown',  unlockOnce);
  window.addEventListener('touchstart', unlockOnce);
})();

// ──────── 통합 SFX 프리로드 (11종, 3 카테고리) ────────
// 볼륨은 빈도와 임팩트 균형:
//   • 자주 들리는 사운드 (shoot, hit_monster) → 작게 (0.2 ~ 0.3)
//   • UI 클릭류                              → 중간 (0.4)
//   • 이펙트성 보스/폭발                      → 크게 (0.5 ~ 0.6)

// (1) UI — assets/sounds/ui/*.ogg
SoundManager.loadSFX('click',        'ui/click.ogg', 0.4);   // 큐 조작 (R pop, E hold)
SoundManager.loadSFX('merge',        'ui/merge.ogg', 0.4);   // 머지 성공
SoundManager.loadSFX('error',        'ui/error.ogg', 0.4);   // 조합 실패 / 코어 부족
SoundManager.loadSFX('buy',          'ui/buy.ogg',   0.4);   // 로비 업그레이드 구매 성공

// (2) Player — assets/sounds/player/*.ogg
SoundManager.loadSFX('shoot',        'player/shoot.ogg', 0.2);   // 매우 자주 → 작게
SoundManager.loadSFX('dash',         'player/dash.ogg',  0.5);
SoundManager.loadSFX('hit',          'player/hit.ogg',   0.5);   // 플레이어 피격

// (3) Monster — assets/sounds/monster/*.ogg
SoundManager.loadSFX('hit_monster',  'monster/hit_monster.ogg', 0.3);   // 자주 → 작게
SoundManager.loadSFX('explode',      'monster/explode.ogg',     0.6);   // 폭탄 거미 폭발
SoundManager.loadSFX('boss_dash',    'monster/boss_dash.ogg',   0.6);   // 보스 돌진 시작
SoundManager.loadSFX('boss_smash',   'monster/boss_smash.ogg',  0.6);   // 보스 내려찍기 임팩트

// ── Legacy: boss_enrage (사용 안 함, 향후 재사용 가능) ──
// SoundManager.loadSFX('boss_enrage', 'monster/boss_enrage.ogg', 0.5);

// Defensive: when the window loses focus (Alt-Tab, click outside, devtools,
// lock screen), keyup events never fire on this window — leaving a key
// "stuck" in the Set, which causes the player to keep moving in that
// direction after refocusing. Clear all held keys on blur / tab-hide.
function clearAllInput() {
  keys.clear();
  justPressed.clear();
  // mouseDown is declared later in source order, but events can only fire
  // after the IIFE finishes — so by the time this runs, mouseDown exists.
  mouseDown.left = false;
}
window.addEventListener('blur', clearAllInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearAllInput();
});

// Mouse tracking (canvas coords) — used for player aim + manual fire
const mouse = { x: W * 0.5, y: H * 0.5 };
const mouseDown = { left: false };
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  // map to internal canvas resolution (W,H) regardless of CSS scaling
  const sx = W / rect.width;
  const sy = H / rect.height;
  mouse.x = (e.clientX - rect.left) * sx;
  mouse.y = (e.clientY - rect.top)  * sy;
});
// Manual fire: left-click & hold to autofire while cooldown allows.
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    e.preventDefault();
    mouseDown.left = true;
  }
});
// Listen on window for mouseup so release outside canvas still registers
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseDown.left = false;
});
// Suppress right-click context menu over the canvas (so future RMB binds work)
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// =====================================================
//  Colors / Atoms
// =====================================================
// SINGLE SOURCE OF TRUTH for color identity strings.
// Bullets, shields, merge results, and atom lookups all reference this
// constant — guarantees no string-mismatch bugs (e.g. ' Magenta' vs 'magenta'
// vs 'MAGENTA'). All identifiers are lowercase, no whitespace.
const COLORS = Object.freeze({
  RED:     'red',
  GREEN:   'green',
  BLUE:    'blue',
  YELLOW:  'yellow',
  CYAN:    'cyan',
  MAGENTA: 'magenta',
});

const COL = {
  [COLORS.RED]:     { hex: '#ff4d4d', glow: '#ff8a8a' },
  [COLORS.GREEN]:   { hex: '#3ddc6b', glow: '#9cf7b6' },
  [COLORS.BLUE]:    { hex: '#4d9dff', glow: '#a7caff' },
  [COLORS.YELLOW]:  { hex: '#ffd34d', glow: '#fff0a0' },
  [COLORS.CYAN]:    { hex: '#4de2ff', glow: '#aef4ff' },
  [COLORS.MAGENTA]: { hex: '#ff4dd2', glow: '#ffaef0' },
};
const PRIMARIES   = [COLORS.RED,    COLORS.GREEN, COLORS.BLUE];
const SECONDARIES = [COLORS.YELLOW, COLORS.CYAN,  COLORS.MAGENTA];

// atomic composition of every color (uses COLORS.* as keys → same string identity
// as bullet.color / enemy.shield → bulletContainsShield works correctly)
const ATOMS = {
  [COLORS.RED]:     ['R'],
  [COLORS.GREEN]:   ['G'],
  [COLORS.BLUE]:    ['B'],
  [COLORS.YELLOW]:  ['R', 'G'],
  [COLORS.CYAN]:    ['G', 'B'],
  [COLORS.MAGENTA]: ['B', 'R'],
};
// "bullet contains shield" — shield atoms are a subset of bullet atoms
function bulletContainsShield(bulletColor, shieldColor) {
  const ba = ATOMS[bulletColor] || [];
  const sa = ATOMS[shieldColor] || [];
  return sa.every(a => ba.includes(a));
}
function mergeColors(a, b) {
  const s = new Set([a, b]);
  if (s.has('red') && s.has('green')) return 'yellow';
  if (s.has('green') && s.has('blue')) return 'cyan';
  if (s.has('blue') && s.has('red'))   return 'magenta';
  return null;
}

// =====================================================
//  Game State
// =====================================================
// ---- base stats (modified per-run by lobby upgrades) ----
const BASE_MOVE_SPEED = 200;
const BASE_FIRE_CD    = 0.35;
const BASE_HP         = 100;
const BASE_DASHES     = 3;
const BASE_QUEUE_MAX  = 4;
const BASE_MERGE_DELAY = 0.5;
const HP_PER_BANK     = 20;     // Memory Bank Expansion: +20 HP per level

const G = {
  state: 'loading',
  stage: 1,               // 1, 2, ... infinite
  player: null,
  enemies: [],
  bullets: [],
  drops: [],
  particles: [],
  portal: null,
  shake: { t: 0, mag: 0 },
  deathTimer: 0,
  // ---- per-run (volatile) currency + shop counts ----
  sessionBits: 0,
  shop: {
    counts: {
      register_extension: 0,
      buffer_opt: 0,
      anti_virus_shield: 0,
    },
    multiThreadBought: false,
  },
  // ---- persistent (across runs) lobby state ----
  coreBits: 0,
  lobby: {
    upgrades: {
      bus_overclock: 0,   // permanent move-speed +10% per level
      hardware_accel: 0,  // permanent fire-rate -0.05s per level (max 5)
      core_upgrade: 0,    // permanent dash stacks +1 per level (max 2)
      memory_bank: 0,     // permanent max-HP +20 per level (max 3)
    },
  },
  // boss-only firewall (mooks orbiting the boss)
  firewall: null, // { mooks: [], boss: ref }
  // cinematic camera: which world-point is displayed at screen center
  cam: { x: W / 2, y: H / 2 },
  // boss intro cinematic state
  bossIntro: null, // { phase: 'focus_boss'|'panning'|'warning', phaseT, bossX, bossY, playerX, playerY, panT, panDur }
  // physical lobby state — which zone the player is overlapping right now (for F prompt)
  lobbyOverlap: null, // { kind: 'terminal'|'portal', zone, item? }
  // deferred state transitions (set during a tick, applied at end of update)
  pendingLobby: false,
  // ---- Melee-boss attack-pattern FX ----
  telegraphs: [],   // [{ x, y, w, h, life, maxLife }] — sweep-dash warning rectangles
  webs: [],         // [{ x, y, r, life, maxLife }] — slow puddles on the floor
  shockwaves: [],   // [{ x, y, r, maxR, life, maxLife, damaged }] — expanding hit-once rings
  deadlockWalls: [],// [{ x1, y1, x2, y2, life, maxLife, color }] — 1-5 보스 Deadlock 벽
  // ---- Twin Boss (Dual Core) shared controller — set when duo encounter starts ----
  duo: null,        // { red, blue, comboCD, comboState }  null when not in a twin fight
  // ---- Run-wide stats (shown on ending screen, reset on newGame) ----
  stats: {
    playTime: 0,        // seconds elapsed during active play (excludes title)
    hitsTaken: 0,       // real HP-damaging hits (shield absorbs DON'T count)
    colorsMerged: 0,    // every successful Space merge
  },
  // ---- End-of-game cinematic state ----
  ending: null,         // { phase: 'blast'|'stats', t, deathX, deathY } | null
};

function addShake(mag, t = 0.2) {
  if (mag > G.shake.mag) G.shake.mag = mag;
  if (t   > G.shake.t)   G.shake.t   = t;
}

// =====================================================
//  Persistence (lobby/core)
// =====================================================
// ⚠ Uses sessionStorage (NOT localStorage) by design:
//   • In-tab navigation (lobby → stage 1 → repeat / die / re-enter lobby)
//     keeps coreBits + permanent upgrades intact for the WHOLE session.
//   • Closing the browser tab clears the save automatically, so the next
//     fresh launch starts at base stats (dash 3, HP 100, etc.) without
//     needing any explicit reset code in stage / newGame functions.
//   • We never reset stats inside startStage / newGame / enterLobby — the
//     session-scoped storage handles that naturally on next tab open.
const SAVE_KEY = 'cqdp_lobby_v1';

function saveLobby() {
  try {
    const data = {
      coreBits: G.coreBits | 0,
      upgrades: {
        bus_overclock:  G.lobby.upgrades.bus_overclock  | 0,
        hardware_accel: G.lobby.upgrades.hardware_accel | 0,
        core_upgrade:   G.lobby.upgrades.core_upgrade   | 0,
        memory_bank:    G.lobby.upgrades.memory_bank    | 0,
      },
    };
    sessionStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch (_) { /* file:// or quota — silently degrade */ }
}

function loadLobby() {
  try {
    const raw = sessionStorage.getItem(SAVE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.coreBits === 'number') G.coreBits = data.coreBits;
    if (data.upgrades) {
      const u = data.upgrades;
      G.lobby.upgrades.bus_overclock  = Math.max(0, u.bus_overclock  | 0);
      G.lobby.upgrades.hardware_accel = Math.min(5, Math.max(0, u.hardware_accel | 0));
      G.lobby.upgrades.core_upgrade   = Math.min(2, Math.max(0, u.core_upgrade   | 0));
      G.lobby.upgrades.memory_bank    = Math.min(3, Math.max(0, u.memory_bank    | 0));
    }
  } catch (_) { /* corrupt save: ignore */ }
}

// ease-in-out (smoothstep-like) used by boss intro camera pan
function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// =====================================================
//  Boss Intro Cinematic
// =====================================================
function startBossIntro() {
  const boss = G.enemies.find(e => e.isBoss);
  if (!boss || !G.player) {
    // safety: nothing to focus on → just play
    G.state = 'playing';
    G.cam.x = W / 2; G.cam.y = H / 2;
    return;
  }
  G.bossIntro = {
    phase: 'focus_boss',
    phaseT: 1.5,
    bossX: boss.x, bossY: boss.y,
    playerX: G.player.x, playerY: G.player.y,
    panT: 0,
    panDur: 1.1,
  };
  // camera snaps to boss immediately
  G.cam.x = boss.x;
  G.cam.y = boss.y;
  G.state = 'boss_intro';
}

function updateBossIntro(dt) {
  const bi = G.bossIntro;
  if (!bi) { G.state = 'playing'; G.cam.x = W / 2; G.cam.y = H / 2; return; }
  bi.phaseT -= dt;

  if (bi.phase === 'focus_boss') {
    // hold on boss; subtle camera breath for liveliness
    G.cam.x = bi.bossX + Math.sin(performance.now() / 350) * 3;
    G.cam.y = bi.bossY + Math.cos(performance.now() / 400) * 2;
    if (bi.phaseT <= 0) {
      bi.phase = 'panning';
      bi.phaseT = bi.panDur;
      bi.panT = 0;
    }
  } else if (bi.phase === 'panning') {
    bi.panT += dt;
    const t = easeInOutQuad(Math.min(1, bi.panT / bi.panDur));
    G.cam.x = bi.bossX + (bi.playerX - bi.bossX) * t;
    G.cam.y = bi.bossY + (bi.playerY - bi.bossY) * t;
    if (bi.phaseT <= 0) {
      bi.phase = 'warning';
      bi.phaseT = 1.0;
      addShake(10, 0.45);
    }
  } else if (bi.phase === 'warning') {
    G.cam.x = bi.playerX;
    G.cam.y = bi.playerY;
    if (bi.phaseT <= 0) {
      // reset camera to neutral and start play
      G.cam.x = W / 2; G.cam.y = H / 2;
      G.state = 'playing';
      G.bossIntro = null;
    }
  }
}

function drawWarningText() {
  const bi = G.bossIntro;
  if (!bi || bi.phase !== 'warning') return;
  const total = 1.0;
  const elapsed = total - bi.phaseT;

  // scale-in (0→0.18s) then steady, fade-out last 0.3s
  let alpha = 1, scale = 1;
  if (elapsed < 0.18) {
    const k = elapsed / 0.18;
    scale = 0.6 + k * 0.5;
    alpha = k;
  } else if (bi.phaseT < 0.3) {
    alpha = bi.phaseT / 0.3;
  }

  // pulse stroke
  const pulse = 0.8 + 0.2 * Math.sin(performance.now() / 60);

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(scale, scale);
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // dark vignette band behind text
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(-W / 2, -60, W, 120);

  // main: SYSTEM BREACH — red neon
  ctx.shadowColor = '#ff3030';
  ctx.shadowBlur = 28;
  ctx.fillStyle = '#ff4d4d';
  ctx.font = 'bold 68px monospace';
  ctx.fillText('SYSTEM BREACH', 0, 0);

  // outline
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = `rgba(255, 255, 255, ${pulse})`;
  ctx.strokeText('SYSTEM BREACH', 0, 0);

  // subtitle
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = '#ffd166';
  ctx.shadowColor = '#ff8a00';
  ctx.shadowBlur = 8;
  ctx.fillText('// ROOT_ACCESS_DETECTED — INITIATING DEFENSE', 0, 50);
  ctx.restore();
}

// =====================================================
//  Stage helpers
// =====================================================
function subStage(s) { return ((s - 1) % 5) + 1; }      // 1..5
function loopNum(s)  { return Math.floor((s - 1) / 5) + 1; }
function stageType(s) {
  const k = subStage(s);
  return ['normal','single-shield','mixed-shield','shop','boss'][k - 1];
}
function stageLabel(s) { return `STAGE ${loopNum(s)}-${subStage(s)}`; }
function loopLabel(s)  { return `LOOP ${loopNum(s)}`; }
function stageSubName(s) {
  return {
    'normal':        'Normal Wave',
    'single-shield': 'Primary Shields',
    'mixed-shield':  'Mixed Shields',
    'shop':          'Safe Zone',
    'boss':          'BOSS BATTLE',
  }[stageType(s)];
}

// Data Bit drops scaling per loop
function dropBits(loop) {
  if (loop === 1) return 1 + Math.floor(Math.random() * 2);     // 1–2
  if (loop === 2) return 3 + Math.floor(Math.random() * 3);     // 3–5
  if (loop === 3) return 8 + Math.floor(Math.random() * 5);     // 8–12
  const base = 8 + (loop - 3) * 6;
  return base + Math.floor(Math.random() * Math.max(2, base / 2));
}

// Fixed per-loop enemy count for normal/shielded stages.
// Locks the economy math (income vs shop prices) to specific spawn counts.
function enemyCountForLoop(loop) {
  // 각 루프 -1 조정: 5→4, 7→6, 9→8
  if (loop === 1) return 4;
  if (loop === 2) return 6;
  if (loop === 3) return 8;
  // Fallback for hypothetical loop ≥ 4
  return 4 + Math.floor((loop - 1) * 2);
}
function bossBits(loop) {
  if (loop === 1) return 20;
  if (loop === 2) return 50;
  if (loop === 3) return 120;
  return Math.floor(120 * Math.pow(1.7, loop - 3));
}

// =====================================================
//  Player
// =====================================================
function makePlayer() {
  // ---- apply permanent lobby upgrades to base stats ----
  const u = G.lobby.upgrades;
  const hpMax     = BASE_HP + u.memory_bank * HP_PER_BANK;
  const moveSpd   = BASE_MOVE_SPEED * (1 + u.bus_overclock * 0.10);
  const fireCdB   = Math.max(0.10, BASE_FIRE_CD - u.hardware_accel * 0.05);
  const maxDashes = BASE_DASHES + u.core_upgrade;

  return {
    x: W * 0.5, y: H * 0.5,
    r: 16,
    hp: hpMax, hpMax,
    dir: 0,
    idleTime: 0,
    fireCd: 0,
    ammo: [],
    hold: null,                // single-slot Tetris-style hold (color string or null)
    invuln: 0,
    hitAnimT: 0,               // > 0 while playing the "hit" sprite animation
    // sprite anim state machine (run / dash / hit)
    animKey: 'run',
    animT: 0,
    // mouse-aim derived sprite row (0=down, 1=right, 2=up, 3=left)
    dirRow: 0,
    // anti-virus shield charges (consumed on hit)
    shieldCount: 0,
    // upgradeable (per-run) stats
    stats: {
      queueMax: BASE_QUEUE_MAX,
      moveSpeed: moveSpd,
      fireCdBase: fireCdB,
      mergeDelay: BASE_MERGE_DELAY,
      hasMultiThread: false,
    },
    // processing lock (merge)
    processing: 0,
    processingType: '',
    // dash system (3-stack base; +1 per Core Upgrade lobby level, max +2)
    maxDashes,
    dashes: maxDashes,
    dashRechargeT: 0,
    dashRechargeDur: 1.5,
    isDashing: false,
    dashT: 0,
    dashDur: 0.15,
    dashSpeed: 900,
    dashVx: 0, dashVy: 0,
    afterimages: [],
  };
}

// magenta takes 2 queue slots, others 1
function slotCost(color) { return color === COLORS.MAGENTA ? 2 : 1; }
function ammoSlotsUsed() {
  let n = 0;
  for (const c of G.player.ammo) n += slotCost(c);
  return n;
}
function ammoCanFit(color) {
  return ammoSlotsUsed() + slotCost(color) <= G.player.stats.queueMax;
}

function ammoPush(color) {
  // slot-cost aware: magenta needs 2 free slots, others 1
  if (!ammoCanFit(color)) return false;
  G.player.ammo.push(color);
  refreshAmmoUI();
  return true;
}
function ammoShift() {
  const c = G.player.ammo.shift();
  refreshAmmoUI();
  return c;
}
// Ensure the DOM has at least `target` ammo-slot divs. New slots are appended
// to the queue panel with the same class + data-idx so existing CSS (.ammo-slot,
// .filled, .locked, NEXT label on [data-idx="0"]) keeps working transparently.
function ensureAmmoSlotCount(target) {
  const container = document.getElementById('ammo-slots');
  if (!container) return;
  let slots = container.querySelectorAll('.ammo-slot');
  while (slots.length < target) {
    const div = document.createElement('div');
    div.className = 'ammo-slot';
    div.setAttribute('data-idx', String(slots.length));
    container.appendChild(div);
    slots = container.querySelectorAll('.ammo-slot');
  }
  // Keep the cached ui.slots in sync with whatever the DOM now contains.
  ui.slots = Array.from(slots);
}

function refreshAmmoUI() {
  const qmax = (G.player && G.player.stats) ? G.player.stats.queueMax : 4;
  // Dynamically grow the slot row if queueMax has increased (e.g. Register Extension).
  ensureAmmoSlotCount(qmax);

  // Build the visual mapping: magenta occupies 2 adjacent slots
  const visual = []; // per slot: color or null
  for (const c of G.player.ammo) {
    visual.push(c);
    if (c === 'magenta') visual.push(c); // takes a second slot
  }
  const count = ui.slots.length;
  for (let i = 0; i < count; i++) {
    const slot = ui.slots[i];
    const c = visual[i];
    const within = i < qmax;
    slot.classList.toggle('locked', !within);
    slot.classList.remove('mag-left', 'mag-right');
    if (c && within) {
      slot.classList.add('filled');
      // ── Holographic Memory Register: 반투명 fill + 강한 외곽선 + 외부/내부 글로우 ──
      const hex  = COL[c].hex;
      const glow = COL[c].glow;
      // background: 30% 알파 (4D = ~30%, 헥사 컬러 + 알파 byte 형식)
      slot.style.background = hex + '4D';
      slot.style.color = glow;
      // 외부 네온 글로우 + 내부 하이라이트 (홀로그램 채움 느낌)
      slot.style.boxShadow = `0 0 12px ${glow}, inset 0 0 18px ${hex}55`;
      slot.style.borderColor = hex;
      if (c === 'magenta') {
        const prev = visual[i - 1];
        const next = visual[i + 1];
        if (prev !== 'magenta' && next === 'magenta') slot.classList.add('mag-left');
        else if (prev === 'magenta' && next !== 'magenta') slot.classList.add('mag-right');
      }
    } else {
      slot.classList.remove('filled');
      // 빈 슬롯: 거의 투명 배경 + 옅은 박스 (날카로운 빈 메모리 슬롯)
      slot.style.background = 'rgba(77, 226, 255, 0.04)';
      slot.style.color = 'transparent';
      slot.style.boxShadow = 'inset 0 0 8px rgba(77, 226, 255, 0.08)';
      slot.style.borderColor = '';   // CSS 기본값으로 복귀
    }
  }
  ui.qMaxLabel.textContent = `(${qmax})`;
  refreshHoldUI();
}

function refreshHoldUI() {
  const slot = ui.holdSlot;
  if (!slot) return;
  slot.classList.remove('filled');
  const c = G.player ? G.player.hold : null;
  if (c) {
    slot.classList.add('filled');
    // Hold 슬롯도 큐와 동일한 홀로그램 룩으로 통일
    const hex  = COL[c].hex;
    const glow = COL[c].glow;
    slot.style.background  = hex + '4D';
    slot.style.color       = glow;
    slot.style.boxShadow   = `0 0 12px ${glow}, inset 0 0 18px ${hex}55`;
    slot.style.borderColor = hex;
  } else {
    slot.style.background  = 'rgba(77, 226, 255, 0.04)';
    slot.style.color       = 'transparent';
    slot.style.boxShadow   = 'inset 0 0 8px rgba(77, 226, 255, 0.08)';
    slot.style.borderColor = '';
  }
}

// Tetris-style Hold: 1-slot stash with 4 cases
function doHoldSwap(p) {
  const queueMax = p.stats.queueMax;
  const used = ammoSlotsUsed();

  // --- Case 1: hold empty ---
  if (p.hold === null) {
    if (p.ammo.length > 0) {
      p.hold = p.ammo.shift();
      refreshAmmoUI();
      burst(p.x, p.y - 14, COL[p.hold].hex, 8, 100);
    }
    return;
  }

  // --- Case 2a: hold full, queue empty → move hold to queue ---
  if (p.ammo.length === 0) {
    p.ammo.push(p.hold);
    p.hold = null;
    refreshAmmoUI();
    burst(p.x, p.y - 14, '#ffffff', 8, 100);
    return;
  }

  const holdCost = slotCost(p.hold);
  const frontCost = slotCost(p.ammo[0]);

  // --- Case 2b: queue has room for hold (push hold to rear, then shift front to hold) ---
  if (used + holdCost <= queueMax) {
    p.ammo.push(p.hold);
    p.hold = p.ammo.shift();
    refreshAmmoUI();
    burst(p.x, p.y - 14, COL[p.hold].hex, 8, 100);
    return;
  }

  // --- Case 2c: queue full → swap hold ↔ front (guard magenta overflow) ---
  const newUsed = used - frontCost + holdCost;
  if (newUsed > queueMax) {
    // swap would overflow (e.g. magenta hold ↔ single primary in tight queue)
    spawnFloater(p.x, p.y - 26, 'HOLD: NO ROOM FOR MAGENTA', '#ff4dd2');
    burst(p.x, p.y - 20, '#ff4dd2', 6, 80);
    return;
  }
  const tmp = p.ammo[0];
  p.ammo[0] = p.hold;
  p.hold = tmp;
  refreshAmmoUI();
  burst(p.x, p.y - 14, COL[p.hold].hex, 8, 100);
}

function vecToDir(dx, dy) {
  const ang = Math.atan2(dy, dx);
  let idx = Math.round((ang / (Math.PI * 2)) * 8);
  if (idx < 0) idx += 8;
  return idx % 8;
}

// Map 2D vector → "up"|"down"|"left"|"right" (which row of the 4-row sprite sheet)
function vec4Dir(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

// Compute current animation key for an enemy based on its state.
// Bosses share the same animation rules as their regular counterparts:
//   • Melee boss (bossKind 'melee') uses Spider state-machine windup/dash → attack
//   • Ranged boss (bossKind 'ranged') uses fireCd telegraph → attack
function getEnemyAnim(e) {
  if (e.isDying)               return 'death';
  if (e.hurtT && e.hurtT > 0)  return 'hurt';
  if (e.type === 'melee' || e.bossKind === 'melee') {
    // Twin-Boss shared states (handled before pattern logic in updateBoss).
    if (e.state === 'restore_cast' || e.state === 'enrage_init') return 'attack';
    if (e.state === 'twin_stun'    || e.state === 'combo_recover') return 'walk';
    if (e.state === 'combo_dash')   return 'attack';
    // "attack" pose: ONE-SHOT expressive states (windup/cast/landing).
    // These play frame 0→last once, then freeze on the last frame — that's
    // intentional for telegraph/wind-up moments.
    if (e.state === 'windup' || e.state === 'sweep_telegraph' ||
        e.state === 'fast_dash_windup' || e.state === 'web_cast' ||
        e.state === 'web_slam') return 'attack';
    // "walk" cycle (LOOPED) — used for chasing AND fast movement (dashes).
    // Dash speed is handled by updateEnemyAnim() multiplying dt so the spider's
    // legs cycle faster instead of freezing on a single attack frame.
    //   sweep_dash / pinball_dash / fast_dash / dash → walk @ accelerated rate
    return 'walk';
  }
  if (e.type === 'ranged' || e.bossKind === 'ranged') {
    // Ranged BOSS uses its own state-machine names (not the simple fireCd path).
    // All firing/aiming states → drone Attack animation (charged-up firing pose).
    if (e.bossKind === 'ranged') {
      // Twin-Boss shared states
      if (e.state === 'restore_cast' || e.state === 'enrage_init') return 'attack';
      if (e.state === 'twin_stun'    || e.state === 'combo_recover') return 'walk';
      if (e.state === 'combo_dash')   return 'attack';
      if (e.state === 'whip_charge'    || e.state === 'whip_fire'      ||
          e.state === 'whip_pause'     || e.state === 'whip_fire_fast' ||
          e.state === 'spiral_fire'    || e.state === 'spiral_pause'   ||
          e.state === 'spiral_fire_fast' ||
          e.state === 'burst_aim'      || e.state === 'burst_fire') return 'attack';
      return 'walk';
    }
    // Regular (non-boss) ranged: legacy fireCd telegraph
    if (e.fireCd > 0 && e.fireCd < 0.5) return 'attack';
    return 'walk';
  }
  return 'walk';
}

// Tick enemy animation state machine each frame.
// ⚠ Frame index (e.anim.t) is RESET on any state transition (walk↔attack/hurt/death)
// so the new animation starts from frame 0. Otherwise carrying over a high frame
// index can index into invalid/blur cells and produce "split sprite" rendering.
//
// Dash-state acceleration: while the boss is mid-dash (sweep/pinball/fast/web_slam),
// the WALK loop ticks 2.5× faster — legs visibly cycle at a sprinting pace
// instead of freezing on a single frame (which used to happen when the dash
// state mapped to one-shot 'attack' anim).
function updateEnemyAnim(e, dt) {
  if (!e.anim) e.anim = { key: 'walk', t: 0 };
  if (e.hurtT && e.hurtT > 0) e.hurtT -= dt;
  if (e.isDying) e.deathT = (e.deathT || 0) - dt;
  const want = getEnemyAnim(e);
  if (want !== e.anim.key) {
    e.anim.key = want;
    e.anim.t = 0;            // hard reset on state change
  } else {
    const isDashLike = (e.state === 'sweep_dash' || e.state === 'pinball_dash' ||
                        e.state === 'fast_dash'  || e.state === 'dash');
    const animSpeedMul = isDashLike ? 2.5 : 1;
    e.anim.t += dt * animSpeedMul;
  }
}

// Generic sprite-sheet draw helper. Handles flip + scaling to a target px size.
function drawSpriteFrame(img, sx, sy, sw, sh, cx, cy, drawSize, flip) {
  ctx.save();
  ctx.translate(cx, cy);
  if (flip) ctx.scale(-1, 1);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, sw, sh,
                -drawSize / 2, -drawSize / 2, drawSize, drawSize);
  ctx.restore();
}

// =====================================================
//  Enemies
// =====================================================
function makeEnemy(type, x, y, opts = {}) {
  const loop = loopNum(G.stage);
  const hpMul = 1 + (loop - 1) * 0.4;
  const spdMul = 1 + (loop - 1) * 0.1;
  const base = {
    type, x, y,
    vx: 0, vy: 0,
    enrageTime: 0,
    enrageForever: false,
    slowTime: 0,
    shield: opts.shield || null,
    isGlitch: false,
    glitchTimer: 0,
    glitchColor: null,
    hitFlash: 0,
    // boss-only
    isBoss: !!opts.isBoss,
    invincible: !!opts.invincible,   // firewall mooks
    glitchSeed: Math.random() * 1000,
  };
  if (type === 'melee') {
    return Object.assign(base, {
      r: 14, hp: Math.ceil(2 * hpMul), hpMax: Math.ceil(2 * hpMul),
      speed: 90 * spdMul,
      state: 'wait', stateT: 0.6 + Math.random(),
      dashSpeed: 360 * spdMul, color: '#c98a4b',
    });
  }
  if (type === 'ranged') {
    return Object.assign(base, {
      r: 16, hp: Math.ceil(2 * hpMul), hpMax: Math.ceil(2 * hpMul),
      speed: 70 * spdMul,
      state: 'roam', stateT: 0.6, fireCd: 1.2,
      color: '#a0a8b8',
    });
  }
  // 'tanker' regular mob: REMOVED — game no longer ships heavy bullet-reflect enemies.
  if (type === 'firewall_mook') {
    return Object.assign(base, {
      r: 12, hp: 99, hpMax: 99,
      speed: 0,
      color: '#888', invincible: true,
      orbitAng: opts.orbitAng || 0,
      orbitR:   opts.orbitR || 80,
      orbitBoss: opts.orbitBoss,
    });
  }
  if (type === 'boss_melee') {
    return Object.assign(base, {
      r: 50,
      hp: Math.ceil(10 * hpMul), hpMax: Math.ceil(10 * hpMul),
      speed: 50 * spdMul,
      state: 'wait', stateT: 1.0,
      dashSpeed: 380 * spdMul, color: '#9a6cff',
      isBoss: true, bossKind: 'melee',
      phase2: false, stunT: 0, frenzyT: 0,
    });
  }
  if (type === 'boss_ranged') {
    return Object.assign(base, {
      r: 50,
      hp: Math.ceil(12 * hpMul), hpMax: Math.ceil(12 * hpMul),
      speed: 40 * spdMul,
      // ⚠ MUST start in 'wait' — updateRangedBoss's state machine ONLY recognises
      //   wait / whip_* / spiral_* / burst_* / groggy. A legacy 'roam' value left
      //   the boss frozen (no branch matched, no movement, no fire).
      state: 'wait', stateT: 1.0,
      color: '#9a6cff',
      isBoss: true, bossKind: 'ranged',
      phase2: false, stunT: 0, frenzyT: 0,
    });
  }
  // 'boss_tanker': REMOVED — the tanker boss slot is now occupied by the Twin Boss
  //                (see spawnTwinBoss). Tanker mechanics no longer exist in the game.
  return base;
}

function enrage(e, dur = 2.5) {
  if (e.enrageTime < dur) e.enrageTime = dur;
}

// =====================================================
//  Stage Setup
// =====================================================
function startStage(stage) {
  G.stage = stage;
  G.enemies.length = 0;
  G.bullets.length = 0;
  G.drops.length = 0;
  G.particles.length = 0;
  G.telegraphs.length = 0;
  G.webs.length = 0;
  G.shockwaves.length = 0;
  G.portal = null;
  G.firewall = null;

  const type = stageType(stage);
  ui.stage.textContent = `${loopLabel(stage)} · ${stageLabel(stage)}`;

  // ── BGM 분기: shop = lobby, boss = boss, 그 외 (normal/single/mixed shield) = stage ──
  if (type === 'shop')      SoundManager.playBGM('lobby');
  else if (type === 'boss') SoundManager.playBGM('boss');
  else                      SoundManager.playBGM('stage');

  if (type === 'shop') {
    openShop();
    showBannerFor(1.4, stageLabel(stage), 'SAFE ZONE');
    return;
  }

  showBannerFor(1.4, stageLabel(stage), stageSubName(stage));

  if (type === 'boss') {
    spawnBoss(stage);
    // anti-spawnkill: force player to bottom-center, well away from boss
    if (G.player) {
      G.player.x = W / 2;
      G.player.y = H - 80;
      G.player.dir = 6; // face up (toward boss)
      G.player.invuln = 0.6;
    }
    // kick off cinematic boss intro
    startBossIntro();
    return;
  }

  // normal / shielded stages
  // WaveManager 가 웨이브 분할 + 시간 제한 + 1-1 특수 처리 담당.
  // (DEBUG_SINGLE_MOB 일 땐 디버그 직접 1마리만 스폰, manager 우회)
  if (DEBUG_SINGLE_MOB) {
    WaveManager.reset();
    spawnWave(type, 1);
  } else {
    WaveManager.start(stage, type);
  }

  // seed primary drops
  G.drops.push(makeDrop('red'));
  G.drops.push(makeDrop('green'));
  G.drops.push(makeDrop('blue'));
}

function spawnWave(type, baseCount) {
  // ratio: 65% melee, 35% ranged (tanker REMOVED — used to be the final 15%).
  // Rebalanced so the missing share is absorbed by ranged mobs.
  const enemies = [];
  for (let i = 0; i < baseCount; i++) {
    const r = Math.random();
    if (r < 0.65) enemies.push('melee');
    else          enemies.push('ranged');
  }
  spawnSpecificWave(type, enemies);
}

// 명시적 타입 배열로 스폰 — WaveManager 가 1-1 같은 scripted wave 에서 사용
function spawnSpecificWave(stageType, types) {
  for (const t of types) {
    const [x, y] = randomSpawn();
    let shield = null;
    if (stageType === 'single-shield') {
      shield = PRIMARIES[Math.floor(Math.random() * 3)];
    } else if (stageType === 'mixed-shield') {
      if (Math.random() < 0.6) shield = SECONDARIES[Math.floor(Math.random() * 3)];
      else                      shield = PRIMARIES[Math.floor(Math.random() * 3)];
    }
    G.enemies.push(makeEnemy(t, x, y, { shield }));
  }
}

// =====================================================
//  WaveManager — 스테이지 웨이브 + 시간 제한 + 강제 스폰
// =====================================================
//   • 5마리 초과 시 절반 split 으로 두 웨이브 (예: 9 → 4+5, 7 → 3+4)
//   • 각 웨이브 20초 타임아웃 → 강제 다음 웨이브 추가 스폰 (난이도 ↑)
//   • 15초 시점 경고 SFX
//   • 스테이지 1-1: 특수 scripted [멜리1+원거리1, 3마리] 시간 무제한 (튜토리얼)
//   • 모든 웨이브 종료 + alive=0 → stageClear (portal 스폰)
// =====================================================
const WaveManager = {
  active:       false,
  stageType:    null,
  waves:        [],        // [{ count?, types?: [...] }] — types 우선
  currentIdx:   0,
  timer:        0,
  timerLimit:   15,        // 20 → 15초 단축
  useTimer:     false,
  warned:       false,

  start(stage, type) {
    this.active     = true;
    this.stageType  = type;
    this.currentIdx = 0;
    this.timer      = 0;
    this.warned     = false;

    // ── 웨이브 플랜 결정 ──
    if (stage === 1) {
      // 1-1: 튜토리얼. 멜리 1 + 원거리 1 먼저 → 클리어 후 2마리 추가. 시간 제한 X. (총 4마리)
      this.waves   = [{ types: ['melee', 'ranged'] }, { count: 2 }];
      this.useTimer = false;
    } else {
      // 웨이브당 최대 4마리 룰: 4 초과 시 ceil(total/4) 개 웨이브로 균등 분할
      //   total=4 → [4]
      //   total=6 → [3, 3]
      //   total=8 → [4, 4]
      //   total=10 (이론) → [4, 3, 3]
      const total = enemyCountForLoop(loopNum(stage));
      const MAX_PER_WAVE = 4;
      const numWaves = Math.max(1, Math.ceil(total / MAX_PER_WAVE));
      const baseSize = Math.floor(total / numWaves);
      const extras   = total - baseSize * numWaves;
      this.waves = [];
      for (let i = 0; i < numWaves; i++) {
        this.waves.push({ count: baseSize + (i < extras ? 1 : 0) });
      }
      this.useTimer = true;
    }

    this._spawnCurrent();
  },

  _spawnCurrent() {
    if (this.currentIdx >= this.waves.length) return;
    const w = this.waves[this.currentIdx];
    if (w.types) {
      spawnSpecificWave(this.stageType, w.types);
    } else {
      spawnWave(this.stageType, w.count);
    }
    this.timer  = 0;
    this.warned = false;
  },

  update(dt) {
    if (!this.active) return;

    // 살아있는 적 카운트 (글리치/firewall 제외)
    let alive = 0;
    for (const e of G.enemies) {
      if (!e.isGlitch && !e.invincible) alive++;
    }

    // 타이머 + 10초 시점 경고 (15초 timeout 의 5초 전)
    if (this.useTimer) {
      this.timer += dt;
      if (!this.warned && this.timer >= 10) {
        this.warned = true;
        SoundManager.playSFX('error');             // 경고 사운드 (error 재사용)
      }
    }

    // 다음 웨이브가 남았을 때만 처리. alive=0 또는 timer expired → next.
    const hasNext = (this.currentIdx + 1) < this.waves.length;

    if (alive === 0 && hasNext) {
      // 클리어 → 즉시 다음 웨이브
      this.currentIdx += 1;
      this._spawnCurrent();
      return;
    }

    if (this.useTimer && this.timer >= this.timerLimit && hasNext) {
      // 타임아웃 → 강제 다음 웨이브 추가 스폰 (alive > 0 상태에서 더 추가됨)
      this.currentIdx += 1;
      this._spawnCurrent();
      return;
    }

    // 마지막 웨이브 + alive=0 → 완료, manager 비활성화
    if (!hasNext && alive === 0) {
      this.active = false;
    }
  },

  // 외부에서 스테이지 클리어 가능 여부 — portal 조건에 사용
  isCleared() {
    if (this.active) return false;
    // active=false 라도 alive=0 이어야 진짜 클리어
    for (const e of G.enemies) {
      if (!e.isGlitch && !e.invincible) return false;
    }
    return true;
  },

  reset() {
    this.active     = false;
    this.waves      = [];
    this.currentIdx = 0;
    this.timer      = 0;
    this.warned     = false;
  },
};

function spawnBoss(stage) {
  const loop = loopNum(stage);
  const kindIdx = (loop - 1) % 3;

  // Every 3rd loop's boss stage (Stage 15, 30, 45, ...) is the TWIN BOSS encounter.
  // kindIdx 0 → melee solo, 1 → ranged solo, 2 → twin (no more boss_tanker slot).
  if (kindIdx === 2) {
    spawnTwinBoss(stage);
    return;
  }

  const kinds = ['boss_melee', 'boss_ranged'];   // kindIdx 0 or 1 only at this point
  // top-center entrance (anti-spawnkill: player is forced to bottom-center)
  const [x, y] = [W / 2, 80];
  const boss = makeEnemy(kinds[kindIdx], x, y, {
    shield: randomMixedShield(),
    isBoss: true,
  });
  // 1-5 (loop 1 / kindIdx 0 / 솔로 거미) 는 신규 패턴 세트 (Deadlock/Overflow/Leap)
  // Twin 의 Red Core 는 spawnTwinBoss 에서 별도로 생성되어 이 플래그 없음 → 기존 패턴 유지.
  if (kindIdx === 0) boss.is15Boss = true;
  G.enemies.push(boss);

  // give player some ammo to start with
  ['red', 'green', 'blue'].forEach(c => {
    G.drops.push(makeDrop(c));
    G.drops.push(makeDrop(c));
  });
}

// ──────── Twin Boss (Dual Core) — Red Core + Blue Core spawn ────────
//  Replaces the tanker boss slot. Two linked bosses share the screen with
//  individual HP, cross-restore mechanics, and a periodic combo dash.
function spawnTwinBoss(stage) {
  const loop = loopNum(stage);
  const hpMul = 1 + (loop - 1) * 0.4;

  // Red Core — melee (Spider), original RED shield. Spawns on left.
  const red = makeEnemy('boss_melee', W * 0.30, 90, {
    shield: COLORS.RED,
    isBoss: true,
  });
  red.color = '#ff4d4d';
  // Twin bosses use slightly LESS HP than solo (since there are two of them
  // and partner-revives are possible). Tunable per loop.
  red.hp     = Math.ceil(8 * hpMul);
  red.hpMax  = red.hp;
  red.isTwinBoss     = true;
  red.twinRole       = 'red';
  red.originalShield = COLORS.RED;

  // Blue Core — ranged (Drone), original BLUE shield. Spawns on right.
  const blue = makeEnemy('boss_ranged', W * 0.70, 90, {
    shield: COLORS.BLUE,
    isBoss: true,
  });
  blue.color = '#4d9dff';
  blue.hp     = Math.ceil(8 * hpMul);
  blue.hpMax  = blue.hp;
  blue.isTwinBoss     = true;
  blue.twinRole       = 'blue';
  blue.originalShield = COLORS.BLUE;

  // Cross-link partners
  red.partner  = blue;
  blue.partner = red;

  G.enemies.push(red, blue);

  // Initialize the shared duo controller (combo timer + state machine)
  G.duo = {
    red, blue,
    comboCD: 12.0,     // first combo fires 12s after spawn
    comboState: 'idle',
    interruptStunT: 0, // global stun timer when restore-interrupt triggers
    repairCD: 0,       // ← 수리 빔 내부 쿨다운 (15초). 0이면 즉시 발동 가능
  };

  // give player some ammo to start with
  ['red', 'green', 'blue'].forEach(c => {
    G.drops.push(makeDrop(c));
    G.drops.push(makeDrop(c));
  });
}

function randomMixedShield() {
  if (Math.random() < 0.5) return SECONDARIES[Math.floor(Math.random() * 3)];
  return PRIMARIES[Math.floor(Math.random() * 3)];
}

function randomSpawn() {
  const pad = 60;
  const SAFE_R = 160;             // no enemy spawns within this radius of player
  const px = G.player ? G.player.x : W / 2;
  const py = G.player ? G.player.y : H / 2;
  for (let attempt = 0; attempt < 24; attempt++) {
    const side = Math.floor(Math.random() * 4);
    let x, y;
    switch (side) {
      case 0:  x = pad + Math.random() * (W - 2 * pad); y = pad; break;
      case 1:  x = W - pad; y = pad + Math.random() * (H - 2 * pad); break;
      case 2:  x = pad + Math.random() * (W - 2 * pad); y = H - pad; break;
      default: x = pad; y = pad + Math.random() * (H - 2 * pad); break;
    }
    const d = Math.hypot(x - px, y - py);
    if (d >= SAFE_R) return [x, y];
  }
  // fallback: mirror opposite of player
  return [Math.max(pad, Math.min(W - pad, W - px)), Math.max(pad, Math.min(H - pad, H - py))];
}

// =====================================================
//  Drops
// =====================================================
function makeDrop(color) {
  return {
    x: 80 + Math.random() * (W - 160),
    y: 80 + Math.random() * (H - 160),
    r: 10, color,
    bob: Math.random() * Math.PI * 2,
  };
}
function spawnDropAt(x, y, color) {
  G.drops.push({ x, y, r: 10, color, bob: Math.random() * Math.PI * 2 });
}

// =====================================================
//  Smart Paint Drop
// =====================================================
// Picks a primary color biased toward what the player NEEDS right now —
// based on shields currently equipped on alive enemies. The atom-based pool
// guarantees the drop is useful (direct break OR merge-fuel for the matching
// secondary). Falls back to fully random when no shielded enemies exist.

// Map shield atoms (R/G/B) back to their primary color name.
const _ATOM_TO_PRIMARY = { R: COLORS.RED, G: COLORS.GREEN, B: COLORS.BLUE };

// Walk live shielded enemies and collect every useful primary into a pool.
// Each occurrence of an atom counts proportionally (3 R-shields → mostly R drops).
function pickShieldBreakerColor() {
  const pool = [];
  for (const e of G.enemies) {
    if (!e || e.isGlitch || e.isDying) continue;
    if (!e.shield) continue;
    const atoms = ATOMS[e.shield];
    if (!atoms) continue;
    for (const a of atoms) {
      const c = _ATOM_TO_PRIMARY[a];
      if (c) pool.push(c);
    }
  }
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 70% smart (shield-targeted), 30% pure random. Variety is preserved so the
// player still occasionally gets unexpected colors for creative merges.
function pickPaintDrop() {
  if (Math.random() < 0.70) {
    const smart = pickShieldBreakerColor();
    if (smart) return smart;
  }
  return PRIMARIES[Math.floor(Math.random() * 3)];
}

// =====================================================
//  Bullets
// =====================================================
function makeBullet(x, y, dx, dy, color, owner, opts = {}) {
  const speed = opts.speed || (owner === 'player' ? 460 : 240);
  const len = Math.hypot(dx, dy) || 1;
  return {
    x, y,
    vx: (dx / len) * speed,
    vy: (dy / len) * speed,
    r: opts.r || 6,
    color, owner,
    dmg: opts.dmg ?? 1,
    life: opts.life || 1.6,
    pierce: color === COLORS.MAGENTA && owner === 'player',  // pierce: keep flying after each hit (no shield bypass)
    hitSet: [],                                          // enemies already hit (for pierce)
  };
}

// =====================================================
//  Particles
// =====================================================
function burst(x, y, color, n = 14, speed = 160) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.4 + Math.random() * 0.8);
    G.particles.push({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 0.4 + Math.random() * 0.3,
      maxLife: 0.7,
      color, size: 2 + Math.random() * 3,
    });
  }
}

// =====================================================
//  Game Flow
// =====================================================
function newGame() {
  // Reset PER-RUN state only. coreBits + G.lobby.upgrades are PRESERVED.
  G.sessionBits = 0;
  G.shop.counts = {
    register_extension: 0,
    buffer_opt: 0,
    anti_virus_shield: 0,
  };
  G.shop.multiThreadBought = false;
  G.player = makePlayer();                 // re-applies permanent lobby upgrades
  G.enemies = []; G.bullets = []; G.drops = []; G.particles = [];
  G.telegraphs = []; G.webs = []; G.shockwaves = [];
  if (G.deadlockWalls) G.deadlockWalls.length = 0;   // 1-5 보스 벽 잔재 청소
  floaters.length = 0;                // 이전 런에서 남은 floating text 청소
  if (G.hpHitParticles) G.hpHitParticles.length = 0;
  G.duo = null;                       // clear any leftover Twin Boss controller
  G.portal = null;
  G.firewall = null;
  if (typeof WaveManager !== 'undefined') WaveManager.reset();   // 웨이브 상태 초기화
  G.shake.t = 0; G.shake.mag = 0;
  G.deathTimer = 0;
  G.cam.x = W / 2; G.cam.y = H / 2;
  G.bossIntro = null;
  G.pendingLobby = false;
  G.stats = { playTime: 0, hitsTaken: 0, colorsMerged: 0 };
  G.ending = null;
  refreshAmmoUI();
  updateHpUI();
  updateBitsUI();
  setGameHudVisible(true);                 // ← 타이틀에서 가렸던 HUD 복귀
  startStage(1);
  G.state = 'playing';
  hideAllOverlays();
}

function gameOver() {
  // Guard against re-entry within the same tick (multiple enemies could damage
  // the player to 0 in the same iteration of updateEnemies / updateBullets).
  if (G.pendingLobby || G.state !== 'playing') return;

  // ---- Convert leftover sessionBits → coreBits (1:1), persist ----
  const converted = G.sessionBits | 0;
  G.coreBits += converted;
  G.sessionBits = 0;
  saveLobby();
  updateBitsUI();

  // remember last run stats for lobby display
  G.lastRun = {
    stageLabel: stageLabel(G.stage),
    converted,
  };

  addShake(10, 0.3);

  // ⚠ DO NOT call enterLobby() here. We're likely deep inside a for-loop that
  // iterates G.enemies / G.bullets — mutating those mid-iteration causes a
  // TypeError on the next loop tick. Defer the transition to the end of update().
  G.pendingLobby = true;
}

// Move player to the physical lobby map (no UI overlay).
function enterLobby() {
  SoundManager.playBGM('lobby');           // 로비 BGM (사망 → 로비 진입)
  // 로비 상태 트래커 — 부팅 시퀀스 / 패럴랙스 / 터미널 SFX cooldown 등
  G.lobbyT = 0;                            // 로비 진입 후 경과 시간
  G._lastTermZone = null;                  // 마지막으로 접근한 터미널 (SFX 디바운스)
  const p = G.player;
  // full heal + reset per-run consumables/inventory
  p.hp = p.hpMax;
  p.invuln = 0.4;
  p.x = LOBBY_MAP.spawn.x;
  p.y = LOBBY_MAP.spawn.y;
  p.dir = 6;                      // face up (toward portal/terminals)
  p.isDashing = false; p.dashT = 0;
  p.dashes = p.maxDashes;
  p.hitAnimT = 0;
  p.animKey = 'run'; p.animT = 0;
  p.ammo.length = 0;
  p.hold = null;
  p.shieldCount = 0;
  p.processing = 0; p.processingType = '';
  p.afterimages.length = 0;

  // clear the active world entities
  G.enemies.length = 0;
  G.bullets.length = 0;
  G.drops.length = 0;
  G.particles.length = 0;
  G.telegraphs.length = 0;
  G.webs.length = 0;
  G.shockwaves.length = 0;
  if (G.deadlockWalls) G.deadlockWalls.length = 0;   // 1-5 보스 벽 잔재 청소
  floaters.length = 0;              // ← 인게임 잔존 floating text (SHIELD UP, RAGE 등) 청소
  if (G.hpHitParticles) G.hpHitParticles.length = 0;   // ← HP 데미지 파편도 청소
  if (typeof WaveManager !== 'undefined') WaveManager.reset();
  G.portal = null;
  G.firewall = null;
  G.bossIntro = null;
  G.duo = null;                     // ← Twin Boss controller 잔여 청소
  G.cam.x = W / 2; G.cam.y = H / 2;
  G.lobbyOverlap = null;

  refreshAmmoUI();
  updateHpUI();
  updateBitsUI();
  hideAllOverlays();              // ensure no leftover gameover/shop overlay
  G.state = 'lobby';
}

// Exit the lobby and start a fresh run. Permanent lobby upgrades persist via makePlayer().
function exitLobby() {
  burst(G.player.x, G.player.y, '#4de2ff', 30, 280);
  addShake(8, 0.25);
  newGame();
}

function clearedAndPortal() {
  G.portal = { x: W / 2, y: H / 2, r: 28, active: true, t: 0 };
}

// =====================================================
//  Lobby — physical map update + F-key interaction
// =====================================================
function rectContains(rx, ry, rw, rh, px, py, pr) {
  // circle-vs-rect overlap (treat player as a circle)
  const cx = Math.max(rx, Math.min(px, rx + rw));
  const cy = Math.max(ry, Math.min(py, ry + rh));
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= pr * pr;
}

function updateLobby(dt) {
  const p = G.player;
  if (p.invuln > 0) p.invuln -= dt;

  // 로비 진입 후 시간 누적 (부팅 시퀀스 / 스캔라인 / 글리치 효과 동기화용)
  G.lobbyT = (G.lobbyT || 0) + dt;

  // dirRow always derived from mouse position (instant, no smoothing)
  p.dirRow = astroRowFromAim(p.x, p.y, mouse.x, mouse.y);

  // ── 터미널 근접 시 '지지직' SFX (zone enter 마다 1회) ──
  let nearestZone = null;
  let nearestD2   = Infinity;
  for (const z of LOBBY_MAP.terminals) {
    const cx = z.x + z.w / 2;
    const cy = z.y + z.h / 2;
    const dx = p.x - cx, dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    // 80px 안쪽에 들어왔는지
    if (d2 < 80 * 80 && d2 < nearestD2) {
      nearestZone = z;
      nearestD2   = d2;
    }
  }
  if (nearestZone && nearestZone !== G._lastTermZone) {
    SoundManager.playSFX('click');         // 가벼운 '지지직' (click 재사용, 작게)
    G._lastTermZone = nearestZone;
  } else if (!nearestZone) {
    G._lastTermZone = null;                // 다른 zone 으로 다시 들어가면 SFX 재발동 가능
  }

  // afterimage decay (cosmetic continuity if user dashed before dying)
  for (let i = p.afterimages.length - 1; i >= 0; i--) {
    const a = p.afterimages[i]; a.t -= dt;
    if (a.t <= 0) p.afterimages.splice(i, 1);
  }

  // dash recharge keeps ticking in lobby (cosmetic; harmless)
  if (p.dashes < p.maxDashes) {
    p.dashRechargeT -= dt;
    if (p.dashRechargeT <= 0) {
      p.dashes = Math.min(p.maxDashes, p.dashes + 1);
      p.dashRechargeT = p.dashes < p.maxDashes ? p.dashRechargeDur : 0;
    }
  }

  // --- WASD movement only (no auto-fire, no merge, no hold) ---
  let dx = 0, dy = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp'))    dy -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown'))  dy += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft'))  dx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) dx += 1;
  const isMoving = (dx !== 0 || dy !== 0);
  if (isMoving) {
    const len = Math.hypot(dx, dy);
    dx /= len; dy /= len;
    p.x = Math.max(p.r, Math.min(W - p.r, p.x + dx * p.stats.moveSpeed * dt));
    p.y = Math.max(p.r, Math.min(H - p.r, p.y + dy * p.stats.moveSpeed * dt));
    p.dir = vecToDir(dx, dy);
  }

  // --- Player animation (same rule as in-game): always 'run' state in lobby ---
  if (p.animKey !== 'run') { p.animKey = 'run'; p.animT = 0; }
  if (isMoving) p.animT += dt;
  else          p.animT = 0;       // freeze on frame 0 = idle pose

  // --- Overlap detection (terminals + portal) ---
  G.lobbyOverlap = null;
  for (const z of LOBBY_MAP.terminals) {
    if (rectContains(z.x, z.y, z.w, z.h, p.x, p.y, p.r)) {
      const item = LOBBY_ITEMS.find(it => it.id === z.id);
      G.lobbyOverlap = { kind: 'terminal', zone: z, item };
      break;
    }
  }
  if (!G.lobbyOverlap) {
    const pt = LOBBY_MAP.portal;
    if (rectContains(pt.x, pt.y, pt.w, pt.h, p.x, p.y, p.r)) {
      G.lobbyOverlap = { kind: 'portal', zone: pt };
    }
  }

  // --- F key: confirm interaction ---
  if (consumeJustPressed('KeyF')) {
    const o = G.lobbyOverlap;
    if (o && o.kind === 'terminal' && o.item) {
      const ok = tryBuyLobby(o.item);
      if (ok) {
        burst(p.x, p.y - 16, o.zone.accent || '#ffd166', 18, 200);
        spawnFloater(p.x, p.y - 30, 'UPGRADED', o.zone.accent || '#ffd166');
        SoundManager.playSFX('buy');     // 로비 업그레이드 구매 성공
      } else {
        const count = G.lobby.upgrades[o.item.id] || 0;
        const maxed = count >= o.item.maxCount;
        spawnFloater(p.x, p.y - 30, maxed ? 'MAXED' : 'NOT ENOUGH CORE', '#ff4d6d');
        SoundManager.playSFX('error');   // 코어 부족 / 만렙 실패
      }
    } else if (o && o.kind === 'portal') {
      exitLobby();
    }
  }
}

function nextStage() {
  hideAllOverlays();
  startStage(G.stage + 1);
  if (G.state !== 'playing') G.state = 'playing';
}

// =====================================================
//  Update — Top Level
// =====================================================
function update(dt) {
  // ── 일시정지 — paused 면 게임 update 전부 스킵, PauseMenu 슬라이더만 갱신 ──
  if (G.paused) {
    PauseMenu.update();
    return;
  }

  if (G.shake.t > 0) {
    G.shake.t -= dt;
    if (G.shake.t <= 0) G.shake.mag = 0;
  }

  // ── Run-time stat: only tick while the game is being actively played ──
  if (G.state === 'playing' || G.state === 'lobby' ||
      G.state === 'shop'    || G.state === 'boss_intro') {
    G.stats.playTime += dt;
  }

  // ── Ending cinematic (final boss defeated at stage 3-5) ──
  // 3단계: ending_cleanse (1.5s) → ending_terminal (2.5s) → ending_stats (count-up)
  if (G.state === 'ending_cleanse' || G.state === 'ending_terminal' ||
      G.state === 'ending_blast'   || G.state === 'ending_stats') {
    updateEnding(dt);
    return;
  }

  if (G.state === 'title') {
    if (consumeJustPressed('Space')) newGame();
    return;
  }
  if (G.state === 'gameover') {
    // legacy state — should rarely be reached now that gameOver() routes to lobby
    G.deathTimer -= dt;
    if (G.deathTimer <= 0 && consumeJustPressed('Space')) newGame();
    return;
  }
  if (G.state === 'lobby') {
    updateLobby(dt);
    return;
  }
  if (G.state === 'shop') {
    // shop is fully UI-driven; only allow Space to close
    if (consumeJustPressed('Space')) {
      closeShopAndAdvance();
    }
    return;
  }
  if (G.state === 'boss_intro') {
    // freeze everything except the cinematic camera + particle decay
    updateBossIntro(dt);
    updateParticles(dt);
    // drain "just pressed" so inputs don't queue up
    justPressed.clear();
    return;
  }
  if (G.state !== 'playing') return;

  updatePlayer(dt);
  updateEnemies(dt);
  updateBullets(dt);
  updateDrops(dt);
  updateParticles(dt);
  updateHpHitParticles(dt);   // ← HP 데미지 파편 tick
  updateDeadlockWalls(dt);    // ← 1-5 보스 Deadlock 벽 tick + 데미지
  updatePortal(dt);
  updateFirewall(dt);
  updateTelegraphs(dt);
  updateWebs(dt);
  updateShockwaves(dt);
  updateTwinDuo(dt);
  WaveManager.update(dt);          // ← 웨이브 진행 / 타임아웃 / 강제 스폰

  // stage-clear logic
  if (stageType(G.stage) !== 'shop' && stageType(G.stage) !== 'boss') {
    // 일반 스테이지: 모든 웨이브 완료 + alive 0
    if (!G.portal && WaveManager.isCleared()) clearedAndPortal();
  } else if (stageType(G.stage) === 'boss') {
    if (!G.portal && G.enemies.length === 0) clearedAndPortal();
  }

  // ---- Deferred state transitions (safe spot: all iterators have finished) ----
  if (G.pendingLobby) {
    G.pendingLobby = false;
    enterLobby();
  }
}

// =====================================================
//  Player Update
// =====================================================
function updatePlayer(dt) {
  const p = G.player;
  if (p.invuln > 0) p.invuln -= dt;
  if (p.hitAnimT > 0) p.hitAnimT -= dt;

  // ===== Sprite row (4-direction): INSTANT mouse-aim → row index =====
  // Decoupled from animation timer. No lerp, no smoothing — recompute every tick.
  // Movement (WASD) direction does NOT influence this; only mouse position does.
  // Explicit x-axis comparison guarantees left/right correctness.
  p.dirRow = astroRowFromAim(p.x, p.y, mouse.x, mouse.y);

  // ===== Player animation state machine =====
  // Priority: hit > dash > run. State changes reset animT to 0 so one-shots restart.
  let wantKey = 'run';
  if (p.hitAnimT > 0)   wantKey = 'hit';
  else if (p.isDashing) wantKey = 'dash';
  if (p.animKey !== wantKey) { p.animKey = wantKey; p.animT = 0; }

  // isMoving: any WASD/arrow key held this frame
  const isMoving =
    keys.has('KeyW') || keys.has('ArrowUp')    ||
    keys.has('KeyS') || keys.has('ArrowDown')  ||
    keys.has('KeyA') || keys.has('ArrowLeft')  ||
    keys.has('KeyD') || keys.has('ArrowRight');

  // Tick rule:
  //  • dash / hit (one-shot) → always advance
  //  • run + moving           → advance (looping walk)
  //  • run + stationary       → freeze on frame 0 (idle pose)
  if (wantKey === 'run') {
    if (isMoving) p.animT += dt;
    else          p.animT = 0;
  } else {
    p.animT += dt;
  }

  // --- Dash recharge (independent of processing/dashing) ---
  if (p.dashes < p.maxDashes) {
    p.dashRechargeT -= dt;
    if (p.dashRechargeT <= 0) {
      p.dashes = Math.min(p.maxDashes, p.dashes + 1);
      p.dashRechargeT = p.dashes < p.maxDashes ? p.dashRechargeDur : 0;
    }
  }

  // --- Afterimage decay (always tick) ---
  for (let i = p.afterimages.length - 1; i >= 0; i--) {
    const a = p.afterimages[i];
    a.t -= dt;
    if (a.t <= 0) p.afterimages.splice(i, 1);
  }

  // --- Active dash: i-frames, locked direction, ignores other input ---
  if (p.isDashing) {
    p.dashT -= dt;
    p.x = Math.max(p.r, Math.min(W - p.r, p.x + p.dashVx * dt));
    p.y = Math.max(p.r, Math.min(H - p.r, p.y + p.dashVy * dt));
    // sample afterimages
    p._aiSample = (p._aiSample || 0) + dt;
    if (p._aiSample >= 0.025) {
      p._aiSample = 0;
      p.afterimages.push({ x: p.x, y: p.y, dir: p.dir, dirRow: p.dirRow, t: 0.22, maxT: 0.22 });
    }
    if (p.dashT <= 0) {
      p.isDashing = false;
      p.dashT = 0;
    }
    p.idleTime = 0;
    p.fireCd = 0.2;
    return;
  }

  // Processing lock (merge delay) — can't move/shoot/dash
  if (p.processing > 0) {
    p.processing -= dt;
    if (p.processing <= 0) {
      p.processing = 0;
      p.processingType = '';
    }
    return;
  }

  let dx = 0, dy = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp'))    dy -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown'))  dy += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft'))  dx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) dx += 1;

  // --- Dash trigger (Shift) ---
  if (consumeJustPressed('ShiftLeft') || consumeJustPressed('ShiftRight')) {
    if (p.dashes > 0) {
      let ddx = dx, ddy = dy;
      if (ddx === 0 && ddy === 0) {
        // no direction → use last facing
        const ang = (p.dir / 8) * Math.PI * 2;
        ddx = Math.cos(ang); ddy = Math.sin(ang);
      } else {
        const dl = Math.hypot(ddx, ddy) || 1;
        ddx /= dl; ddy /= dl;
      }
      p.isDashing = true;
      p.dashT = p.dashDur;
      p.dashVx = ddx * p.dashSpeed;
      p.dashVy = ddy * p.dashSpeed;
      p.dir = vecToDir(ddx, ddy);
      p.dashes -= 1;
      // start recharge timer if not already counting down
      if (p.dashRechargeT <= 0) p.dashRechargeT = p.dashRechargeDur;
      burst(p.x, p.y, '#aef4ff', 10, 220);
      // ⚠ dash SFX 비활성. 재활성 원하면:
      // SoundManager.playSFX('dash');
      return;
    }
  }

  // Fire cooldown ticks every frame regardless of movement (Run & Gun)
  if (p.fireCd > 0) p.fireCd -= dt;

  const moving = (dx !== 0 || dy !== 0);
  if (moving) {
    const len = Math.hypot(dx, dy);
    dx /= len; dy /= len;
    // Web slow: standing inside a boss-thrown web cuts speed to 40%
    const webMul = p.inWeb ? 0.4 : 1;
    p.x = Math.max(p.r, Math.min(W - p.r, p.x + dx * p.stats.moveSpeed * webMul * dt));
    p.y = Math.max(p.r, Math.min(H - p.r, p.y + dy * p.stats.moveSpeed * webMul * dt));
    p.dir = vecToDir(dx, dy);
    p.idleTime = 0;
  } else {
    p.idleTime += dt;
  }

  // R: pop front ammo
  if (consumeJustPressed('KeyR')) {
    if (p.ammo.length > 0) {
      ammoShift();
      burst(p.x, p.y, '#cccccc', 6, 80);
      SoundManager.playSFX('click');     // 큐 pop 효과음
    }
  }
  // E: Hold (Tetris-style 1-slot stash)
  if (consumeJustPressed('KeyE')) {
    doHoldSwap(p);
    SoundManager.playSFX('click');       // 홀드 스왑도 큐 조작 효과음
  }
  // Space: merge — triggers processing lock
  if (consumeJustPressed('Space')) {
    if (p.ammo.length >= 2) {
      const merged = mergeColors(p.ammo[0], p.ammo[1]);
      if (merged) {
        // Magenta needs 2 slots. After merge: used - cost(a) - cost(b) + cost(merged).
        // If merging two primaries into magenta, delta = -1 -1 + 2 = 0 → fits.
        // But guard explicitly so a future queueMax tweak can't break this.
        const futureUsed = ammoSlotsUsed() - slotCost(p.ammo[0]) - slotCost(p.ammo[1]) + slotCost(merged);
        if (futureUsed > p.stats.queueMax) {
          // not enough room for magenta (1 free slot only) → block
          spawnFloater(p.x, p.y - 26, 'MAGENTA: NEED 2 SLOTS', '#ff4dd2');
          burst(p.x, p.y - 20, '#ff4dd2', 6, 80);
          SoundManager.playSFX('error');   // 머지 차단 (큐 자리 부족)
        } else {
          p.ammo.splice(0, 2, merged);
          refreshAmmoUI();
          p.processing = p.stats.mergeDelay;
          p.processingType = 'merge';
          burst(p.x, p.y - 20, COL[merged].hex, 18, 180);
          G.stats.colorsMerged += 1;   // ← run stat: successful color merges
          SoundManager.playSFX('merge');     // 머지 성공 효과음
        }
      } else {
        // invalid merge — small flash, no lock
        burst(p.x, p.y - 20, '#ffffff', 6, 80);
        SoundManager.playSFX('error');     // 조합 실패 효과음
      }
    }
  }

  // Manual fire: while left mouse button is held (Run & Gun — works while moving).
  // Cooldown is p.stats.fireCdBase, which respects the lobby's Hardware Acceleration
  // permanent upgrade (BASE_FIRE_CD - 0.05 * hardware_accel level, floor 0.10s).
  if (mouseDown.left && p.fireCd <= 0 && p.ammo.length > 0) {
    let dxT = mouse.x - p.x, dyT = mouse.y - p.y;
    const lenT = Math.hypot(dxT, dyT);
    if (lenT < 1) {
      // mouse essentially on player → fall back to last facing dir
      const ang = (p.dir / 8) * Math.PI * 2;
      dxT = Math.cos(ang); dyT = Math.sin(ang);
    }
    const color = ammoShift();
    G.bullets.push(makeBullet(p.x, p.y, dxT, dyT, color, 'player'));
    SoundManager.playSFX('shoot');     // 발사 효과음 (overlap 가능)

    // ── Multi-Threading passive: 50% chance of a SAME-color follow-up shot ──
    // Spawned slightly BEHIND the original along the aim vector so the two
    // bullets fly in a tight tandem instead of overlapping into one sprite.
    if (p.stats.hasMultiThread && Math.random() < 0.50) {
      const len = Math.hypot(dxT, dyT) || 1;
      const nx = dxT / len, ny = dyT / len;
      const trailOffset = 18;                     // px back from main bullet
      G.bullets.push(makeBullet(
        p.x - nx * trailOffset,
        p.y - ny * trailOffset,
        dxT, dyT, color, 'player',
        // Same hitbox + damage as a regular bullet (color drives all behavior).
      ));
    }

    // face toward mouse while shooting
    p.dir = vecToDir(dxT, dyT);
    p.fireCd = p.stats.fireCdBase;     // ← Hardware Acceleration reflected here
    addShake(2, 0.05);
  }

  // Walk over glitch = free() — but skip firewall mooks (invincible).
  // ⚠ purged 상태(이미 청소됨, 페이드 중)는 재트리거 방지 위해 스킵.
  for (let i = G.enemies.length - 1; i >= 0; i--) {
    const e = G.enemies[i];
    if (e.isGlitch && e.glitchPhase !== 'purged') {
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < p.r + e.r * 0.9) {
        // ── 흰 섬광 burst (파편이 하얗게 빛나며 폭발) ──
        burst(e.x, e.y, '#ffffff', 26, 240);
        addShake(3, 0.1);
        // Boss vs regular reward split:
        //   • Twin Boss core (red OR blue): 60 each → 120 total when both cleaned
        //   • Single boss:                  bossBits(loop) — 20/50/120
        //   • Regular mob:                  dropBits(loop) — 1-2 / 3-5 / 8-12
        let drop;
        if (e.isBoss) {
          drop = e.isTwinBoss ? 60 : bossBits(loopNum(G.stage));
        } else {
          drop = dropBits(loopNum(G.stage));
        }
        G.sessionBits += drop;
        // Highlight boss drops with bigger gold floater for clarity
        const floatColor = e.isBoss ? '#ffd166' : '#4de2ff';
        spawnFloater(e.x, e.y - 14, `+${drop} bit`, floatColor);
        updateBitsUI();
        // Smart-drop: 80% chance to spawn a paint, color biased toward
        // alive shielded enemies (so the player isn't RNG-starved on color).
        if (Math.random() < 0.80) {
          spawnDropAt(e.x, e.y, pickPaintDrop());
        }

        // ── 즉시 splice 대신 'purged' 페이드 페이즈로 전환 ──
        //   파티클이 흰색으로 변하고 0.5초 페이드아웃 후 updateEnemies 가 제거.
        //   reassemble 도중에 청소되어도 fade 가 자연스럽게 처리됨.
        e.glitchPhase = 'purged';
        e.purgeT      = 0;
        if (e.glitchParticles) {
          for (const pt of e.glitchParticles) {
            pt.color = '#ffffff';
            // 현재 위치에서 살짝 바깥 방향으로 킥 — 파편이 흩어지듯
            const a = Math.atan2(pt.oy, pt.ox) ||
                      (Math.random() * Math.PI * 2);
            const kick = 60 + Math.random() * 80;
            pt.vx = Math.cos(a) * kick;
            pt.vy = Math.sin(a) * kick;
          }
        }
        // ⚠ splice 안 함. 0.5초 페이드 후 updateEnemies 가 처리.
      }
    }
  }

  // Walk into portal
  if (G.portal && G.portal.active) {
    const d = Math.hypot(G.portal.x - p.x, G.portal.y - p.y);
    if (d < p.r + G.portal.r) nextStage();
  }
}

// floating texts (e.g. +bits)
const floaters = [];
// expanding ring visual effects (yellow splash, cyan slow zone)
const ringFX = [];
function spawnRing(x, y, color, maxR = 80, life = 0.4) {
  ringFX.push({ x, y, color, maxR, life, maxLife: life });
}
function spawnFloater(x, y, text, color) {
  floaters.push({ x, y, text, color, life: 0.9, maxLife: 0.9 });
}

// =====================================================
//  Melee-boss FX: telegraphs, webs, shockwaves
// =====================================================
function spawnTelegraph(x, y, w, h, life = 0.6) {
  G.telegraphs.push({ x, y, w, h, life, maxLife: life });
}
function spawnWeb(x, y, r = 60, life = 6.0) {
  G.webs.push({ x, y, r, life, maxLife: life });
}
function spawnShockwave(x, y, maxR = 180, life = 0.55, color = '#ff6c6c') {
  G.shockwaves.push({
    x, y, r: 20, maxR, life, maxLife: life,
    damaged: false,
    color,                                  // optional ring color (default: red)
  });
}

// 1-5 보스 Deadlock 벽: 두 점 사이 굵은 라인이 일정 시간 화면에 남아 데미지 + 이동 차단
function spawnDeadlockWall(x1, y1, x2, y2, color = '#ff3060', life = 3.0) {
  G.deadlockWalls.push({
    x1, y1, x2, y2,
    life, maxLife: life,
    color,
    lastHit: -999,                          // 마지막 데미지 시각 (다중 hit 방지)
  });
}

// Point P 와 선분 AB 사이의 최소 거리
function distPointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.001) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function updateDeadlockWalls(dt) {
  if (!G.deadlockWalls || !G.deadlockWalls.length) return;
  const p = G.player;
  const HIT_THRESHOLD = 12;                  // 벽 두께
  for (const w of G.deadlockWalls) {
    w.life -= dt;
    // 플레이어 데미지 체크 (대쉬 중 i-frame 시 안전)
    if (p && !p.isDashing && p.invuln <= 0 && p.hp > 0 && !G.pendingLobby) {
      const d = distPointToSegment(p.x, p.y, w.x1, w.y1, w.x2, w.y2);
      if (d < HIT_THRESHOLD + p.r) {
        damagePlayer(10);                    // 벽 접촉 데미지
      }
    }
  }
  // dead 제거
  for (let i = G.deadlockWalls.length - 1; i >= 0; i--) {
    if (G.deadlockWalls[i].life <= 0) G.deadlockWalls.splice(i, 1);
  }
}

function drawDeadlockWalls() {
  if (!G.deadlockWalls || !G.deadlockWalls.length) return;
  for (const w of G.deadlockWalls) {
    const k = Math.max(0, w.life / w.maxLife);
    // 마지막 0.4초는 깜빡임으로 사라질 예고
    const blink = (w.life < 0.4 && Math.floor(performance.now() / 100) % 2 === 0) ? 0.5 : 1;
    ctx.save();
    ctx.globalAlpha = (0.55 + 0.4 * k) * blink;
    ctx.strokeStyle = w.color;
    ctx.shadowColor = w.color;
    ctx.shadowBlur  = 18;
    ctx.lineWidth   = 10;                    // 굵은 벽
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();
    // 안쪽 밝은 코어 라인
    ctx.globalAlpha = blink;
    ctx.shadowBlur  = 6;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();
    ctx.restore();
  }
}

// 1-5 보스 Leap (Context Switch) 중 타겟팅 경고 원 — boss 가 invisible 인 동안 노출
function drawLeapWarnings() {
  for (const e of G.enemies) {
    if (!e || !e.is15Boss || e.state !== 'leap_disappear') continue;
    const radius = e.leapRadius || 180;
    const k = 1 - (e.stateT / 1.0);           // 0 → 1 (1초 progress)
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() * 0.02);
    ctx.save();
    // outer alarm ring
    ctx.globalAlpha = (0.3 + 0.6 * k) * pulse;
    ctx.strokeStyle = '#ff3060';
    ctx.shadowColor = '#ff5577';
    ctx.shadowBlur  = 20;
    ctx.lineWidth   = 3;
    ctx.beginPath();
    ctx.arc(e.leapTargetX, e.leapTargetY, radius, 0, Math.PI * 2);
    ctx.stroke();
    // inner concentric (target reticle)
    ctx.globalAlpha = (0.2 + 0.5 * k) * pulse;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(e.leapTargetX, e.leapTargetY, radius * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    // crosshair
    ctx.lineWidth = 1.5;
    const r = radius;
    ctx.beginPath();
    ctx.moveTo(e.leapTargetX - r,         e.leapTargetY);
    ctx.lineTo(e.leapTargetX - r * 0.7,   e.leapTargetY);
    ctx.moveTo(e.leapTargetX + r * 0.7,   e.leapTargetY);
    ctx.lineTo(e.leapTargetX + r,         e.leapTargetY);
    ctx.moveTo(e.leapTargetX,             e.leapTargetY - r);
    ctx.lineTo(e.leapTargetX,             e.leapTargetY - r * 0.7);
    ctx.moveTo(e.leapTargetX,             e.leapTargetY + r * 0.7);
    ctx.lineTo(e.leapTargetX,             e.leapTargetY + r);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

function updateTelegraphs(dt) {
  for (let i = G.telegraphs.length - 1; i >= 0; i--) {
    G.telegraphs[i].life -= dt;
    if (G.telegraphs[i].life <= 0) G.telegraphs.splice(i, 1);
  }
}

function updateWebs(dt) {
  const p = G.player;
  let inAnyWeb = false;
  for (let i = G.webs.length - 1; i >= 0; i--) {
    const w = G.webs[i];
    w.life -= dt;
    if (w.life <= 0) { G.webs.splice(i, 1); continue; }
    const d = Math.hypot(p.x - w.x, p.y - w.y);
    if (d < w.r + p.r * 0.5) inAnyWeb = true;
  }
  // Player reads this in movement to apply slow
  p.inWeb = inAnyWeb;
}

function updateShockwaves(dt) {
  const p = G.player;
  for (let i = G.shockwaves.length - 1; i >= 0; i--) {
    const s = G.shockwaves[i];
    s.life -= dt;
    if (s.life <= 0) { G.shockwaves.splice(i, 1); continue; }
    // expand: r grows from initial 20 to maxR over the lifetime
    const progress = 1 - s.life / s.maxLife;
    s.r = 20 + (s.maxR - 20) * progress;
    // damage player exactly once when the ring passes through them
    if (!s.damaged && !p.isDashing && p.invuln <= 0 && !G.pendingLobby) {
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      const thickness = 18;
      if (d > s.r - thickness && d < s.r + thickness) {
        damagePlayer(14);
        s.damaged = true;
      }
    }
  }
}

function drawTelegraphs() {
  ctx.save();
  ctx.lineWidth = 2;
  for (const t of G.telegraphs) {
    const lifeFrac = Math.max(0, Math.min(1, t.life / t.maxLife));
    // fill pulses with time, fades with life remaining
    const pulse = 0.45 + 0.25 * Math.sin(performance.now() / 80);
    ctx.globalAlpha = (0.25 + 0.20 * (1 - lifeFrac)) * pulse;
    ctx.fillStyle = '#ff3030';
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.globalAlpha = 0.65 * pulse;
    ctx.strokeStyle = '#ff6c6c';
    ctx.strokeRect(t.x + 1, t.y + 1, t.w - 2, t.h - 2);
  }
  ctx.restore();
}

function drawWebs() {
  ctx.save();
  for (const w of G.webs) {
    const lifeFrac = Math.max(0, Math.min(1, w.life / w.maxLife));
    ctx.globalAlpha = 0.45 * lifeFrac;
    // sticky purple-gray puddle
    ctx.fillStyle = '#9090c8';
    ctx.beginPath(); ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2); ctx.fill();
    // crosshatch strands for "web" feel
    ctx.globalAlpha = 0.55 * lifeFrac;
    ctx.strokeStyle = '#dde0ff';
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI;
      const cx = Math.cos(ang), sx = Math.sin(ang);
      ctx.beginPath();
      ctx.moveTo(w.x - cx * w.r, w.y - sx * w.r);
      ctx.lineTo(w.x + cx * w.r, w.y + sx * w.r);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Web-drop airborne warning: a solid filled red circle sized 1.35× the spider's
// body radius. Appears almost immediately (quick 0.15s fade-in) and stays at
// full opacity for the entire 1.5s airborne window — clearly readable as a
// "do-not-stand-here" warning zone. Wobbles slightly in the final 30% to
// telegraph the imminent slam.
function drawWebDropShadow(e) {
  if (e.slamX == null || e.slamY == null) return;
  const scale = Math.max(0, Math.min(1, e.shadowScale || 0));
  if (scale <= 0) return;

  // Quick fade-in (first ~10% of airborne) so the warning pops in fast but
  // doesn't appear instantly at the start of the ascent → polished feel.
  const fadeIn = Math.min(1, scale * 10);
  // Impact-imminent wobble in last 30% of airborne
  const wobble = scale > 0.7
    ? (Math.random() - 0.5) * 5 * ((scale - 0.7) / 0.3)
    : 0;

  // Warning zone radius: 1.35× spider radius (within user's 1.2–1.5 range).
  // Boss melee r=50 → warning circle r ≈ 67 (clearly larger than the boss).
  const warningR = e.r * 1.35;

  ctx.save();
  ctx.translate(e.slamX + wobble, e.slamY + wobble);

  // Filled red warning zone (rgba(255, 0, 0, 0.4) modulated by fade-in)
  ctx.fillStyle = `rgba(255, 0, 0, ${0.4 * fadeIn})`;
  ctx.beginPath();
  ctx.arc(0, 0, warningR, 0, Math.PI * 2);
  ctx.fill();

  // Crisp outline for definition + glow in the final stretch
  ctx.strokeStyle = `rgba(255, 64, 64, ${0.85 * fadeIn})`;
  ctx.shadowColor = '#ff3030';
  ctx.shadowBlur  = scale > 0.5 ? 14 : 6;     // intensifies as drop nears
  ctx.lineWidth   = 2 + Math.min(2, scale * 2);
  ctx.beginPath();
  ctx.arc(0, 0, warningR, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

// Web-drop ascent silk: thin white line from boss's visual center up to y=0.
function drawWebDropSilk(e) {
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 4;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.moveTo(e.x, -10);
  ctx.lineTo(e.x, e.y - (e.airOffsetY || 0));
  ctx.stroke();
  ctx.restore();
}

// Color-recipe HUD: 3 rows of [color] + [color] = [color] above the queue panel.
// Pure shapes + arithmetic glyphs, no labels. Rendered in screen space.
// ─────────────────────────────────────────────────────
//  Twin Boss visuals
// ─────────────────────────────────────────────────────

// Restore beam — drawn in WORLD space (inside the camera-translated block).
// Called once per restoring boss from drawEnemies' per-enemy loop.
function drawTwinRestoreBeam(e) {
  const tgt = e.restoreTarget;
  if (!tgt) return;
  const lifeFrac = Math.max(0, Math.min(1, e.stateT / 2.0));
  const progress = 1 - lifeFrac;             // 0 → 1
  const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 60);

  ctx.save();
  // Color: cyan-ish data stream
  ctx.strokeStyle = '#aef4ff';
  ctx.shadowColor = '#4de2ff';
  ctx.shadowBlur = 14;
  ctx.lineWidth = 3 + progress * 4;          // beam thickens as restore nears
  ctx.globalAlpha = (0.6 + 0.4 * progress) * pulse;
  ctx.beginPath();
  ctx.moveTo(e.x, e.y);
  ctx.lineTo(tgt.x, tgt.y);
  ctx.stroke();

  // Pulses traveling along the beam
  const N = 5;
  for (let i = 0; i < N; i++) {
    const t = ((performance.now() / 220) + i / N) % 1;
    const px = e.x + (tgt.x - e.x) * t;
    const py = e.y + (tgt.y - e.y) * t;
    ctx.globalAlpha = 0.9 * pulse;
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(px, py, 3 + progress * 2, 0, Math.PI * 2); ctx.fill();
  }

  // Target charging ring
  ctx.globalAlpha = 0.6 * pulse;
  ctx.strokeStyle = '#aef4ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(tgt.x, tgt.y, tgt.r + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.stroke();
  ctx.restore();
}

// Combo dash trail — short magenta streaks behind each charging boss.
function drawTwinComboTrail(e) {
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#ff4dd2';
  ctx.shadowColor = '#ff4dd2';
  ctx.shadowBlur = 14;
  const len = Math.hypot(e.vx, e.vy) || 1;
  const ux = -e.vx / len, uy = -e.vy / len;
  for (let i = 1; i <= 3; i++) {
    const dist = i * 22;
    ctx.beginPath();
    ctx.arc(e.x + ux * dist, e.y + uy * dist, e.r * (0.9 - i * 0.2), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Twin HP bars — screen-space, drawn above the play area.
// Red bar top-left, Blue bar top-right. Dead → grey + striked. Enraged → magenta.
function drawTwinHPBars() {
  if (!G.duo) return;
  const { red, blue } = G.duo;
  if (!red || !blue) return;
  drawSingleTwinBar(red,  10,           48, 'L');
  drawSingleTwinBar(blue, W - 10 - 260, 48, 'R');
}

// ─────────────────────────────────────────────────────────────────────────
//  Solo Boss HP Bar (1-5 Spider / 2-5 Drone)
//  - 화면 상단 중앙 320×20, melee=red / ranged=blue
//  - Phase 2 진입 시 색이 강렬해지고 라벨 표시
//  - Frenzy 동안 글로우 펄스, Stun(firewall) 동안 라벨 표시
//  - Twin Boss 인 경우엔 drawTwinHPBars 가 따로 그리므로 G.duo 가 있으면 스킵
// ─────────────────────────────────────────────────────────────────────────
function drawSoloBossHPBar() {
  if (G.duo) return;        // Twin 인코더는 별도
  // 활성 솔로 보스 찾기 (글리치 안 된, 죽지 않은)
  let boss = null;
  for (const e of G.enemies) {
    if (e && e.isBoss && !e.isTwinBoss && !e.isGlitch) {
      boss = e;
      break;
    }
  }
  if (!boss) return;

  const w = 320, h = 20;
  const x = (W - w) / 2;     // 화면 중앙 정렬
  const y = 48;

  const isMelee  = boss.bossKind === 'melee';
  const isPhase2 = !!boss.phase2;
  const inFrenzy = (boss.frenzyT || 0) > 0;
  const inStun   = (boss.stunT   || 0) > 0;
  const isDying  = !!boss.isDying;

  // 색 결정 — Phase 2 / Frenzy 는 마젠타 강조
  let baseColor, glowColor;
  if (isPhase2 || inFrenzy) {
    baseColor = '#ff4dd2';
    glowColor = '#ff8ae0';
  } else if (isMelee) {
    baseColor = '#ff4d4d';
    glowColor = '#ff8a8a';
  } else {
    baseColor = '#4d9dff';
    glowColor = '#a7caff';
  }
  const ratio = isDying ? 0 : Math.max(0, boss.hp / boss.hpMax);

  // Frenzy 동안 글로우 펄스
  const now = performance.now();
  const pulseK = inFrenzy ? (0.7 + 0.3 * Math.sin(now * 0.02)) : 1;

  ctx.save();
  // panel bg
  ctx.globalAlpha = 0.85;
  ctx.fillStyle   = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, w, h);
  // border
  ctx.lineWidth   = 1.5;
  ctx.strokeStyle = isDying ? '#555' : baseColor;
  ctx.shadowColor = isDying ? '#000' : glowColor;
  ctx.shadowBlur  = isDying ? 0 : (inFrenzy ? 14 * pulseK : 10);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.shadowBlur  = 0;
  // fill
  if (ratio > 0) {
    const grad = ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0, baseColor);
    grad.addColorStop(1, glowColor);
    ctx.fillStyle = grad;
    ctx.fillRect(x + 2, y + 2, (w - 4) * ratio, h - 4);
  }
  // ── 라벨 (좌측: 보스 이름 + 상태) ──
  ctx.globalAlpha   = 1;
  ctx.font          = 'bold 11px monospace';
  ctx.textBaseline  = 'middle';
  ctx.textAlign     = 'left';
  ctx.fillStyle     = isDying ? '#888' : '#ffffff';
  let nameLabel = isMelee ? 'SPIDER.exe' : 'DRONE.exe';
  if (isPhase2)  nameLabel += '  [PHASE 2]';
  if (inFrenzy)  nameLabel += '  [FRENZY]';
  if (inStun)    nameLabel += '  [FIREWALL]';
  if (isDying)   nameLabel += '  [DOWN]';
  ctx.fillText(nameLabel, x + 4, y - 8);
  // ── 우측: HP 50% Phase 2 트리거 안내 (alive 일 때만) ──
  if (!isDying && !isPhase2) {
    ctx.textAlign  = 'right';
    ctx.fillStyle  = '#aab2c5';
    ctx.fillText('PHASE 2 @ 50%', x + w - 4, y - 8);
  }
  // ── 중앙: 숫자 HP ──
  ctx.textAlign  = 'center';
  ctx.fillStyle  = isDying ? '#888' : '#ffffff';
  ctx.fillText(`${Math.max(0, Math.ceil(boss.hp))} / ${boss.hpMax}`, x + w / 2, y + h / 2);
  ctx.restore();
}

function drawSingleTwinBar(boss, x, y, side) {
  const w = 260, h = 18;
  const isDead = boss.isDying || boss.hp <= 0;
  const isEnraged = boss.twinEnraged;
  const baseColor = isEnraged ? '#ff4dd2' : (boss.twinRole === 'red' ? '#ff4d4d' : '#4d9dff');
  const glowColor = isEnraged ? '#ff8ae0' : (boss.twinRole === 'red' ? '#ff8a8a' : '#a7caff');
  const ratio = isDead ? 0 : Math.max(0, boss.hp / boss.hpMax);

  ctx.save();
  // panel background
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, w, h);
  // border
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = isDead ? '#555' : baseColor;
  ctx.shadowColor = isDead ? '#000' : glowColor;
  ctx.shadowBlur = isDead ? 0 : 10;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.shadowBlur = 0;
  // fill
  if (ratio > 0) {
    const grad = ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0, baseColor);
    grad.addColorStop(1, glowColor);
    ctx.fillStyle = grad;
    ctx.fillRect(x + 2, y + 2, (w - 4) * ratio, h - 4);
  }
  // label (small text via fillText is OK in screen-space)
  ctx.globalAlpha = 1;
  ctx.font = 'bold 11px monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = isDead ? '#888' : '#ffffff';
  ctx.textAlign = side === 'L' ? 'left' : 'right';
  const label = (boss.twinRole === 'red' ? 'RED CORE' : 'BLUE CORE') +
                (isEnraged ? '  (OVERCLOCKED)' : '') +
                (isDead ? '  [DOWN]' : '');
  const lx = side === 'L' ? x + 4 : x + w - 4;
  ctx.fillText(label, lx, y - 8);
  // numeric hp
  ctx.textAlign = 'center';
  ctx.fillStyle = isDead ? '#888' : '#ffffff';
  ctx.fillText(`${Math.max(0, Math.ceil(boss.hp))} / ${boss.hpMax}`, x + w / 2, y + h / 2);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────
//  Wave Timer — 일반 스테이지 (X-1/X-2/X-3) 의 20초 카운트다운 UI
//   • 14초 이전: 시안 (안전)
//   • 14~17초: 주황 (경고 직전)
//   • 17~20초: 빨강 + 깜빡임 (타임아웃 임박)
//   • 1-1 같은 useTimer=false 스테이지엔 안 그림
// ─────────────────────────────────────────────────────────────────────────
function drawWaveTimer() {
  if (!WaveManager.active || !WaveManager.useTimer) return;
  const remain = Math.max(0, WaveManager.timerLimit - WaveManager.timer);
  const sec = Math.ceil(remain);
  const t = WaveManager.timer;

  // 위치: 우상단 (HUD 와 안 겹치게 약간 아래)
  const x = W - 14;
  const y = 110;

  // 색 단계 (15초 기준)
  //   < 10초    : 시안 (안전)
  //   10~12초   : 주황 (경고 — 5초~3초 전)
  //   ≥ 12초    : 빨강 + 깜빡임 (3초~0초)
  let color, glow;
  if (t < 10)       { color = '#4de2ff'; glow = '#7ec1ff'; }
  else if (t < 12)  { color = '#ffae42'; glow = '#ffd166'; }
  else              { color = '#ff4d6d'; glow = '#ff8a8a'; }
  // 깜빡임 (마지막 3초)
  const blink = (t >= 12 && Math.floor(t * 6) % 2 === 0) ? 0.5 : 1;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  // 라벨
  ctx.font = 'bold 11px monospace';
  ctx.shadowColor = glow;
  ctx.shadowBlur  = 6;
  ctx.fillStyle   = '#aab2c5';
  ctx.globalAlpha = 0.9 * blink;
  ctx.fillText('WAVE TIMER', x, y - 14);
  // 큰 숫자
  ctx.font = 'bold 28px monospace';
  ctx.fillStyle   = color;
  ctx.shadowColor = glow;
  ctx.shadowBlur  = 14;
  ctx.globalAlpha = blink;
  ctx.fillText(`${sec}s`, x, y + 6);
  // 웨이브 진행 (예: "WAVE 2/2")
  const total = WaveManager.waves.length;
  const cur   = Math.min(WaveManager.currentIdx + 1, total);
  ctx.font = 'bold 10px monospace';
  ctx.shadowBlur = 4;
  ctx.fillStyle = '#aab2c5';
  ctx.globalAlpha = 0.7;
  ctx.fillText(`WAVE ${cur} / ${total}`, x, y + 24);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────
//  Color Merge Guide — 사각 LED 노드 + 직관적 텍스트 + / =
//   [R] + [G] = [Y]   ← 한눈에 알아볼 수 있게 텍스트 기호 복귀, 노드만 사각형 유지
// ─────────────────────────────────────────────────────────────────────────
function drawColorRecipe() {
  const recipes = [
    ['red',   'green', 'yellow'],
    ['red',   'blue',  'magenta'],
    ['green', 'blue',  'cyan'],
  ];

  const sz      = 12;                       // 사각 노드 한 변 길이
  const half    = sz / 2;
  const gap     = 12;                       // 노드 ↔ 기호 간격
  const rowH    = 22;
  const lineW   = 6 * half + 4 * gap;       // 3노드(6 half) + 4 gap
  const rightX  = W - 14;
  const leftX   = rightX - lineW;
  const topY    = 416;

  ctx.save();
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.font         = 'bold 14px monospace';

  for (let row = 0; row < 3; row++) {
    const cy = topY + row * rowH + half;

    const cx1 = leftX + half;
    const sx1 = cx1 + half + gap;         // + 기호 위치
    const cx2 = sx1 + gap + half;
    const sx2 = cx2 + half + gap;         // = 기호 위치
    const cx3 = sx2 + gap + half;
    const recipe = recipes[row];

    // ── 네온 LED 이중 코어 노드 helper (차분한 밝기) ──
    //   (1) 베이스 원: 본 색상 풀필 + 적당한 shadowBlur (눈 아프지 않게)
    //   (2) 코어 원: 1.8px 작은 필라멘트 점 (LED 광원, 본 색 rim 충분히 보존)
    // ⚠ save/restore 로 그림자가 옆 + / = 텍스트에 새지 않게 격리
    const drawNode = (cx, cy, colorKey) => {
      const c = COL[colorKey];
      ctx.save();
      // (1) 베이스 원 — 본 색상 + 부드러운 발광
      ctx.shadowColor = c.hex;
      ctx.shadowBlur  = 10;          // 18 → 10 (밝기 ↓)
      ctx.fillStyle   = c.hex;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, half, 0, Math.PI * 2);
      ctx.fill();
      // (2) 광원 코어 — 작은 필라멘트 (반지름 1.8, 본 색 rim 두툼하게)
      ctx.shadowBlur  = 3;
      ctx.fillStyle   = '#ffffff';
      ctx.globalAlpha = 0.85;        // 흰색 강도 살짝 ↓
      ctx.beginPath();
      ctx.arc(cx, cy, 1.8, 0, Math.PI * 2);   // 작은 점만
      ctx.fill();
      ctx.restore();                 // ← 그림자/색 격리
    };

    // 노드 1 + 기호 + 노드 2 = 노드 3
    drawNode(cx1, cy, recipe[0]);

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle  = 'rgba(255,255,255,0.9)';
    ctx.fillText('+', sx1, cy);

    drawNode(cx2, cy, recipe[1]);

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle  = 'rgba(255,255,255,0.9)';
    ctx.fillText('=', sx2, cy);

    drawNode(cx3, cy, recipe[2]);
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawShockwaves() {
  ctx.save();
  for (const s of G.shockwaves) {
    const lifeFrac = Math.max(0, Math.min(1, s.life / s.maxLife));
    const col = s.color || '#ff6c6c';
    ctx.globalAlpha = 0.7 * lifeFrac;
    ctx.strokeStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 16;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.stroke();
    // inner faint glow ring
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.25 * lifeFrac;
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// =====================================================
//  Enemies Update
// =====================================================
function updateEnemies(dt) {
  const p = G.player;
  for (let i = G.enemies.length - 1; i >= 0; i--) {
    const e = G.enemies[i];

    if (e.hitFlash > 0) e.hitFlash -= dt;
    if (e.enrageTime > 0 && !e.enrageForever) e.enrageTime -= dt;
    if (e.slowTime > 0) e.slowTime -= dt;
    // sprite animation state machine (includes melee/ranged bosses)
    const usesAnim =
      e.type === 'melee'  || e.type === 'ranged' ||
      e.bossKind === 'melee' || e.bossKind === 'ranged';
    if (usesAnim) {
      updateEnemyAnim(e, dt);
      // when death anim finishes, turn into glitch (existing cleanup loop)
      if (e.isDying && e.deathT <= 0) {
        e.isDying = false;
        becomeGlitch(e, e._dyingColor || 'red');
        continue;
      }
    }

    if (e.isGlitch) {
      e.glitchTimer  -= dt;
      e.glitchSeed   = (e.glitchSeed || 0) + dt * 60;
      e.glitchPhaseT = (e.glitchPhaseT || 0) + dt;

      // ── PURGED 페이즈: 플레이어가 청소함 → 0.5초 페이드 후 splice ──
      if (e.glitchPhase === 'purged') {
        e.purgeT += dt;
        if (e.glitchParticles) {
          for (const pt of e.glitchParticles) {
            pt.ox += pt.vx * dt;
            pt.oy += pt.vy * dt;
            pt.vx *= 0.93;
            pt.vy *= 0.93;
            pt.alpha = Math.max(0, 1 - e.purgeT / 0.5);
          }
        }
        if (e.purgeT >= 0.5) G.enemies.splice(i, 1);
        continue;
      }

      // ── 페이즈 전환 ──
      //   burst 0.4초 → float (글리치 타이머 1.5초 남을 때까지) → reassemble (마지막 1.5초)
      if (e.glitchPhase === 'burst' && e.glitchPhaseT >= 0.4) {
        e.glitchPhase  = 'float';
        e.glitchPhaseT = 0;
      }
      if (e.glitchPhase === 'float' && e.glitchTimer <= 1.5) {
        e.glitchPhase  = 'reassemble';
        e.glitchPhaseT = 0;
      }

      // ── 파티클 운동: 페이즈별 ──
      if (e.glitchParticles) {
        for (const pt of e.glitchParticles) {
          if (e.glitchPhase === 'burst') {
            // 바깥으로 폭발 (드래그 0.93)
            pt.ox += pt.vx * dt;
            pt.oy += pt.vy * dt;
            pt.vx *= 0.93;
            pt.vy *= 0.93;
          } else if (e.glitchPhase === 'float') {
            // 와이어프레임 외곽 궤도로 부유 — 점진적 lerp + 회전
            const tx = Math.cos(pt.orbAng) * pt.orbR;
            const ty = Math.sin(pt.orbAng) * pt.orbR;
            pt.ox += (tx - pt.ox) * 1.8 * dt;
            pt.oy += (ty - pt.oy) * 1.8 * dt;
            pt.orbAng += pt.orbVel * dt;
          } else if (e.glitchPhase === 'reassemble') {
            // 와이어프레임 안쪽 home 좌표로 빠르게 빨려 들어감
            const k = 5.5;
            pt.ox += (pt.hx - pt.ox) * k * dt;
            pt.oy += (pt.hy - pt.oy) * k * dt;
          }
        }
      }

      if (e.glitchTimer <= 0) {
        // rebirth as enraged — 파편이 완전한 몬스터로 재조립됨
        e.isGlitch       = false;
        e.glitchParticles = null;
        e.glitchPhase    = null;
        e.hp             = Math.max(1, Math.ceil(e.hpMax * 0.5));
        e.shield         = null;
        e.enrageForever  = true;
        e.enrageTime     = 9999;
        burst(e.x, e.y, '#ffae42', 18, 220);
        addShake(4, 0.15);
      }
      continue;
    }

    if (e.invincible && e.type === 'firewall_mook') {
      // orbit boss
      const boss = e.orbitBoss;
      if (boss && !boss.isGlitch && G.enemies.includes(boss)) {
        e.orbitAng += dt * 2.4;
        e.x = boss.x + Math.cos(e.orbitAng) * e.orbitR;
        e.y = boss.y + Math.sin(e.orbitAng) * e.orbitR;
      } else {
        // boss gone → kill self
        G.enemies.splice(i, 1);
      }
      continue;
    }

    // Skip AI + contact for enemies playing the death animation
    if (e.isDying) {
      e.x = Math.max(e.r, Math.min(W - e.r, e.x));
      e.y = Math.max(e.r, Math.min(H - e.r, e.y));
      continue;
    }

    const enraged = e.enrageTime > 0;
    const speedMul = (e.slowTime > 0 ? 0.5 : 1) *
                      (enraged ? (e.type === 'melee' || e.bossKind === 'melee' ? 1.5 : 1.2) : 1);

    if (e.isBoss) {
      updateBoss(e, p, dt, enraged, speedMul);
    } else if (e.type === 'melee') {
      updateMelee(e, p, dt, enraged, speedMul);
    } else if (e.type === 'ranged') {
      updateRanged(e, p, dt, enraged, speedMul);
    }
    // tanker dispatch REMOVED — see updateTanker removal below

    // contact damage (dash grants i-frames → no collision with enemies)
    const dC = Math.hypot(e.x - p.x, e.y - p.y);
    if (!e.isGlitch && !e.isAirborne && !p.isDashing && dC < e.r + p.r) {
      const dmg = e.isBoss ? 22 : (e.type === 'melee' ? 12 : 8);
      damagePlayer(dmg);
      const nx = (e.x - p.x) / (dC || 1), ny = (e.y - p.y) / (dC || 1);
      e.x += nx * 14; e.y += ny * 14;
    }

    e.x = Math.max(e.r, Math.min(W - e.r, e.x));
    e.y = Math.max(e.r, Math.min(H - e.r, e.y));
  }
}

function updateMelee(e, p, dt, enraged, speedMul) {
  // ── 폭탄 거미 (Trojan.Dropper 자식) — 일반 melee state machine 우회 ──
  if (e.isBombSpider) {
    updateBombSpider(e, p, dt);
    return;
  }

  e.stateT -= dt;
  if (e.state === 'wait') {
    const dx = p.x - e.x, dy = p.y - e.y;
    const len = Math.hypot(dx, dy) || 1;
    e.x += (dx / len) * e.speed * speedMul * dt * 0.45;
    e.y += (dy / len) * e.speed * speedMul * dt * 0.45;
    if (e.stateT <= 0) {
      // enter telegraph (windup) — 0.5s standstill, red laser aim
      e.state = 'windup';
      e.stateT = enraged ? 0.35 : 0.5;
      e.aimX = p.x; e.aimY = p.y;
    }
  } else if (e.state === 'windup') {
    // track player so the laser sweeps toward where they're going
    e.aimX = p.x; e.aimY = p.y;
    if (e.stateT <= 0) {
      // lock direction at fire moment; dash 2.5x base speed
      const dx = e.aimX - e.x, dy = e.aimY - e.y;
      const len = Math.hypot(dx, dy) || 1;
      const charge = e.dashSpeed * 2.5 * (enraged ? 1.4 : 1);
      e.vx = (dx / len) * charge;
      e.vy = (dy / len) * charge;
      e.state = 'dash';
      e.stateT = 0.22;  // nerfed: half duration so player can react/dash
      addShake(3, 0.1);
    }
  } else if (e.state === 'dash') {
    e.x += e.vx * dt; e.y += e.vy * dt;
    // near-zero decay so it actually crosses the map
    e.vx *= 0.992; e.vy *= 0.992;
    if (e.stateT <= 0) {
      e.state = 'wait';
      e.stateT = (enraged ? 0.45 : 0.9) + Math.random() * 0.4;
    }
  }
}

function updateRanged(e, p, dt, enraged, speedMul) {
  e.fireCd -= dt;
  const dx = p.x - e.x, dy = p.y - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  const want = 220, dirX = dx / dist, dirY = dy / dist;
  if (dist > want + 20) {
    e.x += dirX * e.speed * speedMul * dt;
    e.y += dirY * e.speed * speedMul * dt;
  } else if (dist < want - 20) {
    e.x -= dirX * e.speed * speedMul * dt;
    e.y -= dirY * e.speed * speedMul * dt;
  } else {
    e.x += -dirY * e.speed * speedMul * dt * 0.4;
    e.y +=  dirX * e.speed * speedMul * dt * 0.4;
  }
  if (e.fireCd <= 0) {
    G.bullets.push(makeBullet(e.x, e.y, dirX, dirY, 'magenta', 'enemy',
      { r: 5, dmg: 10, life: 2.4, speed: 220 }));
    e.fireCd = enraged ? 0.18 : 1.2;
  }
}

// updateTanker REMOVED — tanker enemy type no longer exists.

// ===================
//  Boss AI
// ===================
// =====================================================
//  Melee Boss (Spider) — Full pattern state machine
// =====================================================
//  States:
//    wait              chasing player (default)
//    sweep_telegraph   boss at lane start, red lane shown for 0.6s
//    sweep_dash        boss dashing along current lane at high speed
//    web_cast          stationary windup → throws 3-4 sticky web puddles
//    pinball_dash      phase-2 only: high-speed bouncing 3-4 times
//    groggy            post-pattern stagger (player gets free dps window)
function updateMeleeBoss(e, p, dt, enraged, speedMul) {
  if (!e.state)  e.state  = 'wait';
  if (!e.stateT) e.stateT = 1.5;
  e.stateT -= dt;

  // Effective speed multiplier: rage(1.7) overrides enrage(1.5). Slow stacks.
  // Twin-Enrage (partner died) overrides everything else with a flat 2.0×.
  const isRaged = e.rageT && e.rageT > 0;
  const moveMul = (e.slowTime > 0 ? 0.5 : 1) *
                  (e.twinEnraged ? 2.0 :
                   (isRaged ? 1.7 : (enraged ? 1.5 : 1)));

  if (e.state === 'wait') {
    // chase the player at moderate speed (existing 0.6× speed factor)
    const dx = p.x - e.x, dy = p.y - e.y;
    const len = Math.hypot(dx, dy) || 1;
    e.x += (dx / len) * e.speed * moveMul * dt * 0.6;
    e.y += (dy / len) * e.speed * moveMul * dt * 0.6;
    if (e.stateT <= 0) {
      pickMeleeBossPattern(e, p);   // ← p 명시 전달 (fast_dash/web_drop 의 락온 좌표용)
    }
    return;
  }

  if (e.state === 'sweep_telegraph') {
    // boss is at the lane start, waiting for the warning rect to mature
    if (e.stateT <= 0) {
      const lane = e.sweep.lanes[e.sweep.laneIdx];
      const dx = lane.endX - lane.startX, dy = lane.endY - lane.startY;
      const len = Math.hypot(dx, dy) || 1;
      // dash velocity (rage adds extra). Sweep speed is a baseline.
      const sweepSpd = e.sweep.speed * moveMul;
      e.vx = (dx / len) * sweepSpd;
      e.vy = (dy / len) * sweepSpd;
      e.state = 'sweep_dash';
      e.stateT = (Math.hypot(dx, dy) / sweepSpd) + 0.05;
    }
    return;
  }

  if (e.state === 'sweep_dash') {
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    if (e.stateT <= 0) {
      e.sweep.laneIdx += 1;
      if (e.sweep.laneIdx >= e.sweep.lanes.length) {
        // sweep complete → groggy
        e.state = 'groggy';
        e.stateT = 1.6 + Math.random() * 0.4;   // 1.6–2.0s
        e.vx = 0; e.vy = 0;
      } else {
        // teleport to next lane start, telegraph that lane
        const next = e.sweep.lanes[e.sweep.laneIdx];
        e.x = next.startX; e.y = next.startY;
        spawnTelegraph(next.rectX, next.rectY, next.rectW, next.rectH, 0.6);
        e.state = 'sweep_telegraph';
        e.stateT = 0.55;
      }
    }
    return;
  }

  if (e.state === 'web_cast') {
    // boss is stationary while casting — vulnerable. fire webs once near the end.
    if (!e.webThrown && e.stateT <= 0.2) {
      e.webThrown = true;
      const n = 3 + Math.floor(Math.random() * 2);   // 3 or 4
      for (let i = 0; i < n; i++) {
        const wx = 80 + Math.random() * (W - 160);
        const wy = 80 + Math.random() * (H - 160);
        spawnWeb(wx, wy, 55 + Math.random() * 20, 6.0);
      }
      addShake(4, 0.15);
    }
    if (e.stateT <= 0) {
      e.state = 'wait';
      e.stateT = 1.0 + Math.random() * 0.4;
    }
    return;
  }

  if (e.state === 'pinball_dash') {
    // bounce off walls; spawn shockwave on each bounce; randomize angle slightly
    e.x += e.vx * dt;
    e.y += e.vy * dt;

    let bounced = false;
    let bx = e.x, by = e.y;
    if (e.x - e.r < 0)        { e.x = e.r;       e.vx = Math.abs(e.vx);  bounced = true; bx = 0; }
    else if (e.x + e.r > W)   { e.x = W - e.r;   e.vx = -Math.abs(e.vx); bounced = true; bx = W; }
    if (e.y - e.r < 0)        { e.y = e.r;       e.vy = Math.abs(e.vy);  bounced = true; by = 0; }
    else if (e.y + e.r > H)   { e.y = H - e.r;   e.vy = -Math.abs(e.vy); bounced = true; by = H; }

    if (bounced) {
      spawnShockwave(bx, by, 220, 0.55);
      addShake(7, 0.22);
      e.bounceCount = (e.bounceCount || 0) + 1;
      // slight angle randomization so trajectory isn't predictable
      const ang = Math.atan2(e.vy, e.vx) + (Math.random() - 0.5) * 0.45;
      const spd = Math.hypot(e.vx, e.vy);
      e.vx = Math.cos(ang) * spd;
      e.vy = Math.sin(ang) * spd;
    }

    if ((e.bounceCount || 0) >= (e.bounceMax || 3)) {
      e.state = 'groggy';
      e.stateT = 2.0;
      e.vx = 0; e.vy = 0;
    }
    return;
  }

  if (e.state === 'groggy') {
    // motionless → free dps window
    if (e.stateT <= 0) {
      e.state = 'wait';
      const k = (e.is15Boss && e.phase2) ? 1.5 : 1;       // 1-5 보스 폭주 시 1.5배 빠른 wait
      e.stateT = (1.0 + Math.random() * 0.5) / k;
    }
    return;
  }

  // ── Web Drop: Ascent (0.5s) ──
  // Logical X/Y don't change. Visual Y offset grows so the boss appears to
  // shoot up off the top of the screen along a white silk strand.
  if (e.state === 'web_ascent') {
    const total = 0.3;                          // 0.5 → 0.3 (순식간에 사라짐)
    const tElapsed = total - e.stateT;
    const k = Math.max(0, Math.min(1, tElapsed / total));
    // ease-in curve: starts gentle, accelerates → looks like a yank upward
    const eased = k * k;
    e.airOffsetY = eased * (e.y + e.r + 120);   // enough to vanish past y=0
    if (e.stateT <= 0) {
      // Lock target at current player position (clamped to safe area)
      const pad = e.r + 24;
      e.slamX = Math.max(pad, Math.min(W - pad, p.x));
      e.slamY = Math.max(pad, Math.min(H - pad, p.y));
      e.state = 'web_airborne';
      e.stateT = 0.5;                           // 1.5 → 0.5 (체공/타겟팅 단축)
      e.shadowScale = 0;
    }
    return;
  }

  // ── Web Drop: Airborne (0.5s) ──
  // Boss image is hidden (off-screen). Shadow at slamX/slamY grows from 0 to
  // full size, telegraphing the incoming slam. (1.5s → 0.5s)
  if (e.state === 'web_airborne') {
    const total = 0.5;                          // 1.5 → 0.5 (빠른 fade-in 텔레그래프)
    const tElapsed = total - e.stateT;
    e.shadowScale = Math.max(0, Math.min(1, tElapsed / total));
    if (e.stateT <= 0) {
      // Teleport logical position to target, drop & impact
      e.x = e.slamX;
      e.y = e.slamY;
      e.airOffsetY = 0;
      e.isAirborne = false;
      // Big shockwave at landing site (reuses phase-2 mechanic)
      spawnShockwave(e.slamX, e.slamY, 240, 0.6);
      addShake(12, 0.45);
      burst(e.slamX, e.slamY, '#ffffff', 36, 320);
      e.state = 'web_slam';
      e.stateT = 0.15;                          // 0.2 → 0.15 (벼락같은 강하 포즈)
    }
    return;
  }

  // ── Web Drop: Slam landing pose (0.15s) ──
  // Boss is visible at landing position. Counts the drop & branches:
  //   dropCount < 3  → web_link (0.2~0.25s) → 재상승
  //   dropCount === 3 → groggy (1.5~2.0s) 확정 딜타임
  // ⚠ 사이클 진행 중에는 wait 로 복귀하지 않으므로 다른 패턴 난입 불가 (state lock).
  if (e.state === 'web_slam') {
    if (e.stateT <= 0) {
      e.dropCount = (e.dropCount || 0) + 1;
      if (e.dropCount < 3) {
        // 짧은 연결 지연 후 곧바로 다음 강하
        e.state  = 'web_link';
        e.stateT = 0.20 + Math.random() * 0.05;   // 0.20~0.25s
      } else {
        // 3회 모두 완수 → 긴 그로기 (확정 딜타임)
        e.state    = 'groggy';
        e.stateT   = 1.5 + Math.random() * 0.5;   // 1.5~2.0s
        e.dropCount = 0;                          // 다음 픽 위해 리셋
      }
    }
    return;
  }

  // ── Web Drop: Link (0.20~0.25s) — 사이클 사이 짧은 지연 ──
  // 보스는 지면에 있어서 vulnerable. 끝나면 즉시 ascent 재진입.
  if (e.state === 'web_link') {
    if (e.stateT <= 0) {
      e.state       = 'web_ascent';
      e.stateT      = 0.3;
      e.isAirborne  = true;     // 다시 무적
      e.airOffsetY  = 0;
      e.shadowScale = 0;
      // slamX/slamY 는 ascent 끝날 때 다시 락온됨 (현재 플레이어 위치 추적)
    }
    return;
  }

  // ── Fast Targeted Dash: Windup (0.25s) ──
  // Very brief telegraph — a pulsing red line from boss to the locked target.
  // The line is drawn in drawEnemies based on state + e.fastTargetX/Y.
  if (e.state === 'fast_dash_windup') {
    if (e.stateT <= 0) {
      // Lock velocity toward target (target was captured when pattern picked)
      const dx = e.fastTargetX - e.x;
      const dy = e.fastTargetY - e.y;
      const len = Math.hypot(dx, dy) || 1;
      const spd = 1100 * moveMul;             // very fast: ~22× e.speed
      e.vx = (dx / len) * spd;
      e.vy = (dy / len) * spd;
      e.state = 'fast_dash';
      // duration = travel time to target + tiny overshoot (max 0.4s cap)
      e.stateT = Math.min(0.4, len / spd + 0.08);
      SoundManager.playSFX('boss_dash');   // 보스 돌진 시작 SFX
    }
    return;
  }

  // ── Fast Targeted Dash: dash (variable) ──
  // Boss slams straight at the locked target at 1100 px/s. After overshoot or
  // reaching the target → very SHORT groggy (0.5s) so the next pattern lands
  // almost immediately. This is the boss's "twitchy" high-pressure attack.
  if (e.state === 'fast_dash') {
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    // Clamp to canvas (boss can't leave the arena)
    e.x = Math.max(e.r, Math.min(W - e.r, e.x));
    e.y = Math.max(e.r, Math.min(H - e.r, e.y));
    if (e.stateT <= 0) {
      e.state = 'groggy';
      e.stateT = 0.45 + Math.random() * 0.15;  // SHORT recovery (0.45–0.6s)
      e.vx = 0; e.vy = 0;
    }
    return;
  }

  // ──────────────────────────────────────────────────────────────────
  // 1-5 솔로 보스 (SpiderBoss_1_5) 전용 상태 머신
  // ──────────────────────────────────────────────────────────────────

  // ── Deadlock Web: charge (0.6s) — 굵은 빨간 레이저 텔레그래프 ──
  if (e.state === 'deadlock_charge') {
    e.vx = 0; e.vy = 0;
    if (e.stateT <= 0) {
      // 벽 생성: 보스 → 락온 좌표로 향하는 라인, 화면 끝까지 연장
      const dx = e.deadlockX - e.x;
      const dy = e.deadlockY - e.y;
      const len = Math.hypot(dx, dy) || 1;
      const ext = Math.max(W, H) * 1.2;             // 화면 대각선보다 길게
      const nx = dx / len, ny = dy / len;
      spawnDeadlockWall(
        e.x,              e.y,
        e.x + nx * ext,   e.y + ny * ext,
        '#ff3060'
      );
      e.state  = 'deadlock_persist';
      e.stateT = 1.0;                               // 보스도 1초간 정지 (벽은 3초 유지)
    }
    return;
  }

  // ── Deadlock Web: persist — 벽이 화면에 3초간 남음. 보스는 1초 후 groggy ──
  if (e.state === 'deadlock_persist') {
    e.vx = 0; e.vy = 0;
    if (e.stateT <= 0) {
      e.state  = 'groggy';
      e.stateT = 1.2 + Math.random() * 0.3;
    }
    return;
  }

  // ── Buffer Overflow: charge (0.5s) — 핵심 차징 펄스 ──
  if (e.state === 'overflow_charge') {
    e.vx = 0; e.vy = 0;
    if (e.stateT <= 0) {
      e.state  = 'overflow_burst';
      e.stateT = 1.8;             // burst 페이즈 안전 cap
      e.overflowCount = 0;
      e.overflowTimer = 0;        // 첫 발사는 즉시
    }
    return;
  }

  // ── Buffer Overflow: 3 emissions (0.5s 간격) of 14 bullets in 360° ──
  if (e.state === 'overflow_burst') {
    e.vx = 0; e.vy = 0;
    e.overflowTimer -= dt;
    if (e.overflowTimer <= 0 && e.overflowCount < 3) {
      // 14발 균등 분포 360°
      const N = 14;
      // 매 발사마다 살짝 회전 오프셋 (이전 발사 사이로 채워지듯)
      const angOffset = (e.overflowCount % 2) * (Math.PI / N);
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + angOffset;
        G.bullets.push(makeBullet(
          e.x, e.y,
          Math.cos(a), Math.sin(a),
          'magenta', 'enemy',
          { r: 6, dmg: 12, speed: 240, life: 4.0 }
        ));
      }
      addShake(4, 0.15);
      burst(e.x, e.y, '#ff4dd2', 16, 200);
      e.overflowCount += 1;
      e.overflowTimer = 0.5;
    }
    if (e.overflowCount >= 3 && e.overflowTimer <= -0.2) {
      e.state  = 'groggy';
      e.stateT = 1.3 + Math.random() * 0.3;
    }
    return;
  }

  // ── Context Switch Leap: disappear (1s 첫번째, 0.6s 짧은 텔레그래프 후속) ──
  if (e.state === 'leap_disappear') {
    e.vx = 0; e.vy = 0;
    e.isAirborne = true;
    if (e.stateT <= 0) {
      // 락온 좌표로 텔레포트 + 충격파
      e.x = e.leapTargetX;
      e.y = e.leapTargetY;
      e.isAirborne = false;
      spawnShockwave(e.x, e.y, e.leapRadius || 180, 0.7, '#ff3060');
      addShake(14, 0.4);
      burst(e.x, e.y, '#ff4dd2', 36, 320);
      spawnRing(e.x, e.y, 'magenta', 200, 0.55);
      SoundManager.playSFX('boss_dash');         // ← 매 텔레포트마다 SFX

      // ── 360° 8발 산탄 (45° 간격) — 회피 공간 확보 ──
      // 14발(25.7°) → 8발(45°) 로 줄여 텔레포트 + 산탄 동시 회피 가능하게 조정
      const N = 8;
      const angOffset = ((e.leapCount || 0) % 2) * (Math.PI / N);  // 회당 회전 오프셋
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + angOffset;
        G.bullets.push(makeBullet(
          e.x, e.y,
          Math.cos(a), Math.sin(a),
          'magenta', 'enemy',
          { r: 6, dmg: 12, speed: 240, life: 4.0 }
        ));
      }

      e.leapCount = (e.leapCount || 0) + 1;
      const k = getEnrageMul15(e);
      if (e.leapCount < 3) {
        // 다음 텔레포트까지 짧은 연결 지연
        e.state  = 'leap_link';
        e.stateT = 0.65 / k;                     // 0.5~0.8 권장 중간값
      } else {
        // 3번 완료 → 긴 그로기 (확정 딜타임)
        e.state    = 'groggy';
        e.stateT   = (1.6 + Math.random() * 0.4) / k;
        e.leapCount = 0;
      }
    }
    return;
  }

  // ── Leap: link (다음 텔레포트 준비, 0.5~0.8s) ──
  // 보스는 지면에 있지만 곧 다시 사라짐 → 짧은 정적
  if (e.state === 'leap_link') {
    e.vx = 0; e.vy = 0;
    if (e.stateT <= 0) {
      const k = getEnrageMul15(e);
      const tgt = pickLeapTargetNearPlayer(p);
      e.leapTargetX = tgt.x;
      e.leapTargetY = tgt.y;
      // 후속 disappear 는 짧게 (0.6s) — 빠른 압박감
      e.state       = 'leap_disappear';
      e.stateT      = 0.6 / k;
      e.isAirborne  = true;
    }
    return;
  }

  // ── Trojan.Dropper: 0.8초 차징 → 폭탄 거미 ~2-3마리 (Max Cap 4) 소환 ──
  if (e.state === 'trojan_summon') {
    e.vx = 0; e.vy = 0;
    // 차징이 끝나기 직전에 한 번만 spawn
    if (!e.trojanSpawned && e.stateT <= 0.08) {
      // ▼ 살아있는 폭탄 거미 수에 따라 소환 수 제한 — 절대 Max Cap 초과 안 함
      const alive   = countAliveBombSpiders();
      const desired = 2 + Math.floor(Math.random() * 2);              // 2~3 마리
      const cap     = Math.max(0, BOMB_SPIDER_MAX_CAP - alive);       // 남은 자리
      const count   = Math.min(desired, cap);                         // 둘 중 작은 값

      for (let i = 0; i < count; i++) {
        const a = (i / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.6;
        const dist = e.r + 25;
        let bx = e.x + Math.cos(a) * dist;
        let by = e.y + Math.sin(a) * dist;
        bx = Math.max(20, Math.min(W - 20, bx));
        by = Math.max(20, Math.min(H - 20, by));
        spawnBombSpider(bx, by);
      }
      e.trojanSpawned = true;
      if (count > 0) {
        burst(e.x, e.y, '#ff4d6d', 28, 240);
        addShake(5, 0.2);
        spawnRing(e.x, e.y, 'red', 140, 0.45);
      }
    }
    if (e.stateT <= 0) {
      const k = getEnrageMul15(e);
      e.state  = 'groggy';
      e.stateT = (1.0 + Math.random() * 0.3) / k;
    }
    return;
  }
}

// ─── 폭탄 거미 (Bomb Spider) 관리 상수/헬퍼 ───
const BOMB_SPIDER_MAX_CAP = 4;     // 동시 존재 가능한 최대 마릿수

// 현재 맵에 살아있는 (폭발 처리 안 된) 폭탄 거미 수 카운트.
// _exploded 플래그로 ghost 데이터 (splice 직전 일시적 상태) 도 제외.
function countAliveBombSpiders() {
  let n = 0;
  for (const e of G.enemies) {
    if (e && e.isBombSpider && !e._exploded && !e.isGlitch && !e.isDying) n++;
  }
  return n;
}

// ─── 폭탄 거미 (Bomb Spider) — 1-5 보스 Trojan.Dropper 가 소환 ───
// ⚠ makeEnemy 는 type-specific defaults 로 opts 를 덮어쓰므로, 임의 필드는
//   반환된 객체에 직접 할당해야 함.
function spawnBombSpider(x, y) {
  const b = makeEnemy('melee', x, y);          // melee 기본형 거미 sprite
  // 폭탄 거미 전용 필드 직접 오버라이드 (makeEnemy 의 defaults 위에 덮어쓰기)
  b.isBombSpider = true;
  b.bombTimer    = 3.0;
  b.hp           = 1;
  b.hpMax        = 1;
  b.speed        = 180;                        // 일반 melee 90 대비 2배
  b.color        = '#ff4d6d';                  // 빨간색 → 위협 인지
  b.state        = 'wait';
  b.stateT       = 0;
  b.shield       = null;                       // 방어막 없음 (1피격 즉사 보장)
  G.enemies.push(b);
}

function updateBombSpider(e, p, dt) {
  if (!e || !p || p.hp <= 0) return;
  if (e._exploded) return;                       // 이미 폭발 처리됨
  e.bombTimer -= dt;

  // 플레이어 추격 (직선)
  const dx = p.x - e.x;
  const dy = p.y - e.y;
  const len = Math.hypot(dx, dy) || 1;
  const spd = e.speed || 180;
  e.x += (dx / len) * spd * dt;
  e.y += (dy / len) * spd * dt;

  // ── 폭탄 거미끼리 겹침 방지 (Soft Separation) ──
  // 다른 살아있는 BombSpider 와 너무 가까우면 반대 방향으로 밀어냄.
  // 자기만 밀어내고 (대칭은 다음 iteration 에서 자연스럽게 처리됨).
  for (const other of G.enemies) {
    if (other === e) continue;
    if (!other.isBombSpider || other._exploded || other.isGlitch || other.isDying) continue;
    const odx = e.x - other.x;
    const ody = e.y - other.y;
    const od  = Math.hypot(odx, ody);
    const minD = e.r + other.r + 2;              // 2px 버퍼
    if (od > 0.01 && od < minD) {
      const push = (minD - od);
      e.x += (odx / od) * push;
      e.y += (ody / od) * push;
    } else if (od <= 0.01) {
      // 완전히 겹친 케이스 (확률 매우 낮음) — 무작위 방향으로 살짝 분리
      const a = Math.random() * Math.PI * 2;
      e.x += Math.cos(a) * minD;
      e.y += Math.sin(a) * minD;
    }
  }

  e.x = Math.max(e.r, Math.min(W - e.r, e.x));
  e.y = Math.max(e.r, Math.min(H - e.r, e.y));

  // 타이머 막판엔 깜빡임 강화 (visual feedback)
  if (e.bombTimer < 1.0) e.hitFlash = 0.08;

  // 폭발 조건: 타이머 0 OR 플레이어 접촉
  const distP = Math.hypot(p.x - e.x, p.y - e.y);
  if (e.bombTimer <= 0 || distP < p.r + e.r) {
    explodeBombSpider(e, true);                  // doContactDamage = true
  }
}

// 폭탄 거미 폭발 처리 — 모든 사망 경로 (컨택트/타이머/총알) 에서 호출
//   doContactDamage: true 면 폭발 반경 내 플레이어에 데미지 (총알 킬은 false)
//   - r=70 충격파 + visual FX
//   - 6발 360° 적대적 탄막 (Death Effect)
//   - G.enemies 에서 즉시 제거
function explodeBombSpider(e, doContactDamage) {
  if (!e || e._exploded) return;                 // idempotent
  e._exploded = true;

  SoundManager.playSFX('explode');               // 폭탄 거미 자폭 SFX

  const expR = 70;
  spawnShockwave(e.x, e.y, expR, 0.5, '#ff4d6d');
  burst(e.x, e.y, '#ff4d6d', 30, 280);
  burst(e.x, e.y, '#ffd166', 18, 220);
  addShake(7, 0.22);
  spawnRing(e.x, e.y, 'red', expR * 1.1, 0.4);

  // 컨택트/타이머 폭발 시에만 플레이어 직접 데미지 (총알 킬은 의도된 회피)
  if (doContactDamage) {
    const p = G.player;
    if (p && p.hp > 0) {
      const distP = Math.hypot(p.x - e.x, p.y - e.y);
      if (distP < expR + p.r) damagePlayer(10);
    }
  }

  // ── 8방향 데스 탄막 — 360° 균등 45° 분포 ──
  for (let i = 0; i < 8; i++) {
    const ang = (Math.PI * 2 / 8) * i;
    G.bullets.push(makeBullet(
      e.x, e.y,
      Math.cos(ang), Math.sin(ang),
      'magenta', 'enemy',
      { r: 7, dmg: 10, speed: 280, life: 3.5 }   // 일반 적 탄막보다 살짝 굵고 강함
    ));
  }

  // 즉시 제거 (reverse iteration loop 안에서 안전)
  const idx = G.enemies.indexOf(e);
  if (idx >= 0) G.enemies.splice(idx, 1);
}

// ─── 1-5 보스 패턴 setup 함수 ───
// ⚠ enrageMul = phase2 (HP ≤ 40%) 진입 시 1.5 — 모든 charge/aim 시간 단축

function getEnrageMul15(e) {
  return (e.is15Boss && e.phase2) ? 1.5 : 1;
}

// Pattern A: Hyperdash — 0.5초 빨간 라인 텔레그래프 → 1100 px/s 장거리 돌진
function setup15Hyperdash(e, p) {
  const k = getEnrageMul15(e);
  e.fastTargetX = p.x;
  e.fastTargetY = p.y;
  e.state  = 'fast_dash_windup';                 // 기존 state 재사용 (handler 그대로)
  e.stateT = 0.5 / k;                            // 0.5s aim (폭주 시 0.33s)
}

// Pattern B: Buffer Overflow — 360° 14발 × 3연발
function setup15Overflow(e, p) {
  const k = getEnrageMul15(e);
  e.state  = 'overflow_charge';
  e.stateT = 0.5 / k;
  e.overflowCount = 0;
  e.overflowTimer = 0;
  e.vx = 0; e.vy = 0;
}

// Pattern C: Trojan.Dropper — 0.8초 차징 → 폭탄 거미 2~3마리 소환
function setup15Trojan(e, p) {
  const k = getEnrageMul15(e);
  e.state  = 'trojan_summon';
  e.stateT = 0.8 / k;
  e.trojanSpawned = false;
  e.vx = 0; e.vy = 0;
}

// Pattern D: Context Switch Leap — 3연속 텔레포트 + 매 이동 충격파
// 각 텔레포트는 플레이어 주변 30~120px 랜덤 좌표로. 3번 후 긴 그로기 (확정 딜타임).
function setup15Leap(e, p) {
  const k = getEnrageMul15(e);
  e.state        = 'leap_disappear';
  e.stateT       = 1.0 / k;
  e.leapCount    = 0;                            // 0/1/2 → 3번째 끝나면 groggy
  const tgt = pickLeapTargetNearPlayer(p);
  e.leapTargetX  = tgt.x;
  e.leapTargetY  = tgt.y;
  e.leapRadius   = 180;
  e.isAirborne   = true;
  e.vx = 0; e.vy = 0;
}

// 플레이어 주변 랜덤 좌표 (화면 밖 클램프) — Leap 3연속 사이의 위치 다양화
function pickLeapTargetNearPlayer(p) {
  if (!p) return { x: W / 2, y: H / 2 };
  const ang  = Math.random() * Math.PI * 2;
  const dist = 30 + Math.random() * 90;          // 30~120px
  return {
    x: Math.max(60, Math.min(W - 60, p.x + Math.cos(ang) * dist)),
    y: Math.max(60, Math.min(H - 60, p.y + Math.sin(ang) * dist)),
  };
}

// ─── Deprecated setup (남겨두지만 picker 에서 호출 안 됨) ───
function setup15Deadlock(e, p) {
  e.state  = 'deadlock_charge';
  e.stateT = 0.6;
  e.deadlockX = p.x;
  e.deadlockY = p.y;
  e.vx = 0; e.vy = 0;
}

// Pattern picker (per-cycle decision)
// ⚠ p (player) 가 필요함 — web_drop / fast_dash setup 에서 락온 좌표 사용.
//   이전엔 (e) 만 받아서 strict mode 에서 p.x 참조 시 ReferenceError 로
//   두 패턴이 silently fail 하던 버그가 있었음.
function pickMeleeBossPattern(e, p) {
  // ─── 1-5 솔로 보스 (SpiderBoss_1_5) 전용 패턴 세트 ───
  // ⚠ 이 분기를 phase2(pinball) 분기보다 먼저 두어서 is15Boss 는 절대 pinball 안 감.
  //   대신 phase2 진입 (HP ≤ 40%) 시엔 enrageMul=1.5 로 모든 setup 시간을 단축.
  //   B. overflow   360° 탄막 0.5초 간격 3연발
  //   C. trojan     자폭 거미 ~2-3마리 소환 (Max Cap 4, 가득 차면 SKIP)
  //   D. leap       1초 타겟팅 경고 → 충격파 텔레포트
  if (e.is15Boss && !e.isTwinBoss) {
    const opts15 = ['overflow', 'trojan', 'leap'];
    const prev15 = e.lastPattern || '';
    const filtered15 = opts15.filter(o => o !== prev15);
    let pick15 = filtered15[Math.floor(Math.random() * filtered15.length)];

    // ▼ Trojan Max Cap (4): 이미 4마리 살아있으면 trojan 패턴 스킵하고 다른 패턴 픽
    if (pick15 === 'trojan' && countAliveBombSpiders() >= BOMB_SPIDER_MAX_CAP) {
      const nonTrojan = filtered15.filter(o => o !== 'trojan');
      if (nonTrojan.length > 0) {
        pick15 = nonTrojan[Math.floor(Math.random() * nonTrojan.length)];
      }
    }
    e.lastPattern = pick15;

    if      (pick15 === 'overflow')  setup15Overflow(e, p);
    else if (pick15 === 'trojan')    setup15Trojan(e, p);
    else                             setup15Leap(e, p);
    return;
  }

  if (e.phase2) {
    // Phase 2: always pinball (1-5 외 보스만)
    e.state = 'pinball_dash';
    e.stateT = 5.0;                   // safety timeout
    e.bounceCount = 0;
    e.bounceMax = 3 + Math.floor(Math.random() * 2);  // 3 or 4
    const ang = Math.random() * Math.PI * 2;
    const spd = 520;                  // base pinball speed
    e.vx = Math.cos(ang) * spd;
    e.vy = Math.sin(ang) * spd;
    return;
  }

  // ─── Twin Red Core (3-5) 및 fallback: 기존 4 패턴 ───
  // Phase 1: randomly pick one of 4 patterns each cycle, avoiding immediate repeat.
  //   A. sweep_v     vertical sweep dash (4 lanes left→right)
  //   B. sweep_h     horizontal sweep dash (4 lanes top→bottom)
  //   C. web_drop    fake-Z silk ascent → slam landing with shockwave
  //   D. fast_dash   twitchy 1100 px/s targeted hook (short recovery)
  const opts = ['sweep_v', 'sweep_h', 'web_drop', 'fast_dash'];
  const prev = e.lastPattern || '';
  const filtered = opts.filter(o => o !== prev);
  const pick = filtered[Math.floor(Math.random() * filtered.length)];
  e.lastPattern = pick;

  if (pick === 'sweep_v' || pick === 'sweep_h') {
    setupMeleeBossSweep(e, pick === 'sweep_v' ? 'v' : 'h');
    const lane = e.sweep.lanes[0];
    e.x = lane.startX; e.y = lane.startY;
    spawnTelegraph(lane.rectX, lane.rectY, lane.rectW, lane.rectH, 0.6);
    e.state = 'sweep_telegraph';
    e.stateT = 0.95;                  // first telegraph (slightly longer for warning)
  } else if (pick === 'web_drop') {
    // Spider yanks itself up a silk thread, then slams down on the player.
    // ▼ 3연속 사이클로 개편 — dropCount 추적. ascent 0.3s → airborne 0.5s →
    //   slam 0.15s → (link 0.2~0.25s → ascent 재진입) ×3 → groggy 1.5~2.0s.
    e.dropCount = 0;                  // ← 누적 강하 횟수
    e.state = 'web_ascent';
    e.stateT = 0.3;                   // 0.5 → 0.3 (즉발 상승)
    e.isAirborne = true;              // intangible while up there
    e.airOffsetY = 0;
    e.shadowScale = 0;
    e.slamX = p.x; e.slamY = p.y;     // initial guess (locked at airborne entry)
  } else if (pick === 'fast_dash') {
    // Lock target NOW — boss commits to current player position.
    e.fastTargetX = p.x;
    e.fastTargetY = p.y;
    e.state = 'fast_dash_windup';
    e.stateT = 0.25;                  // very brief telegraph
  }
}

// Compute lane rectangles for a sweep. Each lane has a telegraph rectangle and
// the boss's start/end positions for its dash through that lane.
function setupMeleeBossSweep(e, dir) {
  const numLanes = 4;
  const lanes = [];
  if (dir === 'v') {
    const laneW = W / numLanes;
    for (let i = 0; i < numLanes; i++) {
      const cx = i * laneW + laneW / 2;
      lanes.push({
        rectX: i * laneW, rectY: 0, rectW: laneW, rectH: H,
        startX: cx, startY: -e.r - 10,
        endX:   cx, endY: H + e.r + 10,
      });
    }
  } else {
    const laneH = H / numLanes;
    for (let i = 0; i < numLanes; i++) {
      const cy = i * laneH + laneH / 2;
      lanes.push({
        rectX: 0, rectY: i * laneH, rectW: W, rectH: laneH,
        startX: -e.r - 10, startY: cy,
        endX: W + e.r + 10, endY: cy,
      });
    }
  }
  e.sweep = {
    dir,
    lanes,
    laneIdx: 0,
    speed: 900,       // sweep dash speed (px/s)
  };
}

// =====================================================
//  Ranged Boss (Drone) — Bullet-hell pattern state machine
// =====================================================
//  States:
//    wait                hover / strafe at preferred distance
//    whip_charge         lock-on, telegraph sweep arc (0.7s)
//    whip_fire           sweep-spray bullets (1.0s)
//    whip_pause          Phase 2 offbeat freeze (0.2s)
//    whip_fire_fast      Phase 2 reverse sweep at 2× rotation (0.5s)
//    spiral_fire         8-arm rotating spiral (2.0s)
//    spiral_pause        Phase 2 offbeat freeze (0.2s)
//    spiral_fire_fast    Phase 2 reverse spin at 2× rotation (1.0s)
//    burst_aim           lock-on red laser to player position (0.45s)
//    burst_fire          3 fan-shot bursts at 0.3s intervals
//    groggy              recovery window between patterns
function updateRangedBoss(e, p, dt, enraged, speedMul) {
  if (!e.state)  e.state  = 'wait';
  if (!e.stateT) e.stateT = 1.0;
  e.stateT -= dt;

  // Twin-Enrage (partner died) → flat 2.0× move + fire intensity override.
  const isRaged = e.rageT && e.rageT > 0;
  const moveMul = (e.slowTime > 0 ? 0.5 : 1) *
                  (e.twinEnraged ? 2.0 :
                   (isRaged ? 1.7 : (enraged ? 1.2 : 1)));

  // ── wait: maintain ~250px distance, strafe, pick next pattern when timer expires ──
  if (e.state === 'wait') {
    const dx = p.x - e.x, dy = p.y - e.y;
    const dist = Math.hypot(dx, dy) || 1;
    const want = 250, dirX = dx / dist, dirY = dy / dist;
    if (dist > want + 20) {
      e.x += dirX * e.speed * moveMul * dt;
      e.y += dirY * e.speed * moveMul * dt;
    } else if (dist < want - 20) {
      e.x -= dirX * e.speed * moveMul * dt;
      e.y -= dirY * e.speed * moveMul * dt;
    } else {
      e.x += -dirY * e.speed * moveMul * dt * 0.4;
      e.y +=  dirX * e.speed * moveMul * dt * 0.4;
    }
    if (e.stateT <= 0) pickRangedBossPattern(e, p);
    return;
  }

  // ──────── A. WHIP (Sweep Bullet Whip) ────────
  if (e.state === 'whip_charge') {
    // Track the player while charging (so the sweep aims where the player IS)
    const dx = p.x - e.x, dy = p.y - e.y;
    e.whipCenter = Math.atan2(dy, dx);
    if (e.stateT <= 0) {
      e.state = 'whip_fire';
      e.stateT = 1.0;
      e.whipFireCd = 0;
    }
    return;
  }
  if (e.state === 'whip_fire') {
    const total = 1.0;
    const t = (total - e.stateT) / total;            // 0 → 1
    const sweepRange = Math.PI * 2 / 3;              // 120° fan
    const ang = e.whipCenter - (sweepRange / 2) * e.whipDir + sweepRange * e.whipDir * t;
    e.whipAngle = ang;
    e.whipFireCd -= dt;
    if (e.whipFireCd <= 0) {
      const speed = 320 * (isRaged ? 1.3 : 1);
      G.bullets.push(makeBullet(e.x, e.y, Math.cos(ang), Math.sin(ang),
        'magenta', 'enemy', { r: 6, dmg: 10, speed, life: 3.5 }));
      e.whipFireCd = 0.04;                           // 25 bullets / sec
    }
    // Phase 2 offbeat fake-out: pause halfway, then reverse 2× fast
    if (e.phase2 && !e.offbeatTriggered && t > 0.55) {
      e.offbeatTriggered = true;
      e.state = 'whip_pause';
      e.stateT = 0.2;
      return;
    }
    if (e.stateT <= 0) {
      e.state = 'groggy';
      e.stateT = 1.2 + Math.random() * 0.3;
    }
    return;
  }
  if (e.state === 'whip_pause') {
    if (e.stateT <= 0) {
      e.whipDir = -e.whipDir;                        // reverse sweep direction
      e.state = 'whip_fire_fast';
      e.stateT = 0.55;
      e.whipFireCd = 0;
      // restart angle at one edge for clean visual
      e.whipCenter = Math.atan2(p.y - e.y, p.x - e.x);
    }
    return;
  }
  if (e.state === 'whip_fire_fast') {
    const total = 0.55;
    const t = (total - e.stateT) / total;
    const sweepRange = Math.PI * 2 / 3;
    const ang = e.whipCenter - (sweepRange / 2) * e.whipDir + sweepRange * e.whipDir * t;
    e.whipAngle = ang;
    e.whipFireCd -= dt;
    if (e.whipFireCd <= 0) {
      const speed = 420;                             // faster bullets
      G.bullets.push(makeBullet(e.x, e.y, Math.cos(ang), Math.sin(ang),
        'magenta', 'enemy', { r: 6, dmg: 10, speed, life: 3.5 }));
      e.whipFireCd = 0.03;                           // 33 bullets / sec
    }
    if (e.stateT <= 0) {
      e.state = 'groggy';
      e.stateT = 1.2 + Math.random() * 0.3;
    }
    return;
  }

  // ──────── B. SPIRAL (8-arm Vortex) ────────
  if (e.state === 'spiral_fire') {
    const rotSpeed = e.spiralDir * (Math.PI * 0.6) * (isRaged ? 1.3 : 1);
    e.spiralAngle = (e.spiralAngle || 0) + rotSpeed * dt;
    e.spiralFireCd -= dt;
    if (e.spiralFireCd <= 0) {
      const speed = 210 * (isRaged ? 1.3 : 1);
      const arms = 8;
      for (let i = 0; i < arms; i++) {
        const a = e.spiralAngle + (i / arms) * Math.PI * 2;
        G.bullets.push(makeBullet(e.x, e.y, Math.cos(a), Math.sin(a),
          'magenta', 'enemy', { r: 5, dmg: 9, speed, life: 4 }));
      }
      e.spiralFireCd = 0.13;
    }
    if (e.phase2 && !e.offbeatTriggered && e.stateT < 0.8) {
      e.offbeatTriggered = true;
      e.state = 'spiral_pause';
      e.stateT = 0.2;
      return;
    }
    if (e.stateT <= 0) {
      e.state = 'groggy';
      e.stateT = 1.3 + Math.random() * 0.3;
    }
    return;
  }
  if (e.state === 'spiral_pause') {
    if (e.stateT <= 0) {
      e.spiralDir = -e.spiralDir;                    // reverse rotation
      e.state = 'spiral_fire_fast';
      e.stateT = 1.0;
      e.spiralFireCd = 0;
    }
    return;
  }
  if (e.state === 'spiral_fire_fast') {
    const rotSpeed = e.spiralDir * (Math.PI * 1.2);  // 2× of normal
    e.spiralAngle += rotSpeed * dt;
    e.spiralFireCd -= dt;
    if (e.spiralFireCd <= 0) {
      const speed = 290;
      const arms = 8;
      for (let i = 0; i < arms; i++) {
        const a = e.spiralAngle + (i / arms) * Math.PI * 2;
        G.bullets.push(makeBullet(e.x, e.y, Math.cos(a), Math.sin(a),
          'magenta', 'enemy', { r: 5, dmg: 9, speed, life: 4 }));
      }
      e.spiralFireCd = 0.10;
    }
    if (e.stateT <= 0) {
      e.state = 'groggy';
      e.stateT = 1.2 + Math.random() * 0.3;
    }
    return;
  }

  // ──────── C. BURST SNIPER ────────
  if (e.state === 'burst_aim') {
    // lock on the player NOW for the next pull-trigger
    e.burstTargetX = p.x;
    e.burstTargetY = p.y;
    if (e.stateT <= 0) {
      e.state = 'burst_fire';
      e.stateT = 0.95;
      e.burstCount = 0;
      e.burstT = 0;
    }
    return;
  }
  if (e.state === 'burst_fire') {
    e.burstT -= dt;
    if (e.burstT <= 0 && e.burstCount < 3) {
      const baseAng = Math.atan2(e.burstTargetY - e.y, e.burstTargetX - e.x);
      const shots = e.phase2 ? 4 : 5;
      const spread = 0.32;
      const isRicochet = e.phase2;
      const speed = isRicochet ? 720 : 380;          // Phase 2: near-instant
      for (let i = 0; i < shots; i++) {
        const t = shots === 1 ? 0 : (i / (shots - 1) - 0.5);
        const a = baseAng + t * spread;
        G.bullets.push(makeBullet(e.x, e.y, Math.cos(a), Math.sin(a),
          'magenta', 'enemy',
          { r: 6, dmg: 12, speed, life: 2.6,
            bounceLeft: isRicochet ? 1 : 0 }));
      }
      addShake(4, 0.12);
      e.burstCount += 1;
      e.burstT = 0.3;
    }
    if (e.stateT <= 0) {
      e.state = 'groggy';
      e.stateT = 1.0 + Math.random() * 0.3;
    }
    return;
  }

  // ──────── Groggy (recovery) ────────
  if (e.state === 'groggy') {
    if (e.stateT <= 0) {
      e.state = 'wait';
      e.stateT = 0.9 + Math.random() * 0.4;
    }
    return;
  }

  // ──────── Safety net: unknown state → recover to 'wait' ────────
  // If the boss ever lands in a state name this machine doesn't recognise
  // (e.g. legacy 'roam' value from older makeEnemy code), force it back to
  // 'wait' so it immediately resumes movement + pattern picking. Without
  // this guard the boss would silently freeze (no branch matched).
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[updateRangedBoss] unknown state:', e.state, '→ reset to wait');
  }
  e.state = 'wait';
  e.stateT = 0.5;
}

// Ranged boss pattern picker — random 3-way, no immediate repeat.
function pickRangedBossPattern(e, p) {
  const opts = ['whip', 'spiral', 'burst'];
  const prev = e.lastPattern || '';
  const filtered = opts.filter(o => o !== prev);
  const pick = filtered[Math.floor(Math.random() * filtered.length)];
  e.lastPattern = pick;
  e.offbeatTriggered = false;                        // reset for each new pattern

  if (pick === 'whip') {
    e.state = 'whip_charge';
    e.stateT = 0.7;
    e.whipDir = Math.random() < 0.5 ? -1 : 1;        // L→R or R→L
    e.whipCenter = Math.atan2(p.y - e.y, p.x - e.x);
  } else if (pick === 'spiral') {
    e.state = 'spiral_fire';
    e.stateT = 2.0;
    e.spiralAngle = Math.random() * Math.PI * 2;
    e.spiralFireCd = 0;
    e.spiralDir = -1;                                // CCW default
  } else {  // burst
    e.state = 'burst_aim';
    e.stateT = 0.45;
    e.burstTargetX = p.x;
    e.burstTargetY = p.y;
  }
}

// =====================================================
//  Twin Boss (Dual Core) — shared state handlers
// =====================================================
//  All twin-specific states are co-ordinated across the two linked bosses:
//    restore_cast   one boss casts a 2s beam to rebuild the partner's shield
//    twin_stun      both bosses stunned 3.5s after a restore-interrupt
//    combo_dash     both rush to map center (invincible) every ~12s
//    combo_recover  brief stationary phase after the collision shockwave
//    enrage_init    partner just died — survivor enters 2× speed magenta mode

function startTwinRestore(restorer, target) {
  if (!restorer || restorer.isDying) return;
  restorer.state = 'restore_cast';
  restorer.stateT = 2.0;
  restorer.restoreTarget = target;
  restorer.vx = 0; restorer.vy = 0;
  spawnFloater(restorer.x, restorer.y - restorer.r - 30, 'RESTORING…', '#aef4ff');
}

function updateTwinRestoreCast(e, dt) {
  e.stateT -= dt;                            // ← critical: tick down so state can exit
  const target = e.restoreTarget;
  // Abort if target is gone / dying
  if (!target || target.isDying || target.hp <= 0) {
    e.state = 'wait';
    e.stateT = 0.5;
    e.restoreTarget = null;
    return;
  }
  if (e.stateT <= 0) {
    // Restore complete → restore partner's ORIGINAL shield color
    target.shield = target.originalShield || COLORS.MAGENTA;
    target.vulnerableHitsLeft = 0;
    spawnRing(target.x, target.y, target.shield, 120, 0.6);
    burst(target.x, target.y, COL[target.shield].hex, 30, 240);
    spawnFloater(target.x, target.y - target.r - 30, 'SHIELD RESTORED', '#aef4ff');
    addShake(4, 0.2);
    e.state = 'wait';
    e.stateT = 0.6;
    e.restoreTarget = null;
    // ▼ 수리 빔 내부 쿨다운 15초 시작 — 다음 수리가 가능해지기까지의 락
    if (G.duo) G.duo.repairCD = 15.0;
  }
}

function triggerTwinStun(a, b) {
  for (const boss of [a, b]) {
    if (!boss || boss.isDying || boss.hp <= 0) continue;
    boss.state = 'twin_stun';
    boss.stateT = 3.5;
    boss.restoreTarget = null;
    boss.vx = 0; boss.vy = 0;
    burst(boss.x, boss.y, '#ffd166', 36, 260);
    spawnRing(boss.x, boss.y, COLORS.YELLOW, 140, 0.6);
    spawnFloater(boss.x, boss.y - boss.r - 30, '!! OVERLOAD !!', '#ffd166');
  }
  addShake(12, 0.5);
  if (G.duo) {
    G.duo.comboCD = Math.max(G.duo.comboCD, 9);  // delay next combo
    G.duo.repairCD = 15.0;                       // ← 인터럽트도 수리 쿨다운 시작
  }
}

function updateTwinStun(e, dt) {
  e.stateT -= dt;                            // ← critical: tick down so state can exit
  if (e.stateT <= 0) {
    e.state = 'wait';
    e.stateT = 0.4 + Math.random() * 0.3;
  }
}

function startTwinCombo() {
  if (!G.duo) return;
  const { red, blue } = G.duo;
  if (!red || !blue) return;
  // Abort if either boss is unavailable
  for (const boss of [red, blue]) {
    if (boss.isDying || boss.hp <= 0) return;
    if (boss.state === 'twin_stun' || boss.state === 'restore_cast') return;
  }
  // ▼ 목표점: 두 보스의 위치 중간점 (이전엔 화면 중앙 W/2, H/2 였음).
  //   이렇게 하면 어떤 비대칭 위치에서든 두 보스가 동시에 그 점에 도달함.
  const cx = (red.x + blue.x) * 0.5;
  const cy = (red.y + blue.y) * 0.5;

  // 이미 충돌 거리 안이면 다음 프레임의 updateTwinComboDash collision check 가
  // 즉시 발동되므로 그대로 진행 (vx=vy=0 이라도 충돌 트리거됨).
  for (const boss of [red, blue]) {
    const dx = cx - boss.x, dy = cy - boss.y;
    const len = Math.hypot(dx, dy) || 1;
    boss.vx = (dx / len) * 700;
    boss.vy = (dy / len) * 700;
    boss.state = 'combo_dash';
    boss.stateT = 1.5;          // safety cap; collision should fire well before
    boss.isAirborne = true;     // invincible during combo dash
  }
  spawnFloater(cx, cy - 40, '◆ MAGENTA COLLISION ◆', '#ff4dd2');
  addShake(8, 0.3);
}

function updateTwinComboDash(e, dt) {
  e.stateT -= dt;                            // ← critical: safety-cap timeout
  // ▼ 합체기 중에는 다른 어떤 push 로직도 받지 않도록 isAirborne=true 유지.
  //   updateEnemies 의 contact pushback 분기는 isAirborne 가드로 이미 무시됨.
  //   몬스터-몬스터 분리(separation) 로직이 추가되더라도 이 함수에서 직접 이동
  //   계산을 하므로 외부 보정은 일체 무시한다.
  e.x += e.vx * dt;
  e.y += e.vy * dt;
  e.x = Math.max(e.r, Math.min(W - e.r, e.x));
  e.y = Math.max(e.r, Math.min(H - e.r, e.y));

  // ▼ 정확한 거리 판정: (두 보스 반지름 합 + 12px 여유)
  //   매 프레임마다 양쪽이 동시에 이 분기를 들어오지만, state 가 combo_dash 인지
  //   먼저 확인하므로 한쪽이 충돌 처리한 직후엔 다른 쪽은 combo_recover 라 들어오지 않음.
  const partner = e.partner;
  if (partner && !partner.isDying && partner.state === 'combo_dash') {
    const dx = partner.x - e.x;
    const dy = partner.y - e.y;
    const d = Math.hypot(dx, dy);
    const threshold = e.r + partner.r + 12;   // 50 + 50 + 12 = 112px
    if (d < threshold) {
      const cx = (e.x + partner.x) * 0.5;
      const cy = (e.y + partner.y) * 0.5;
      // Massive magenta shockwave (uses optional color param on spawnShockwave)
      spawnShockwave(cx, cy, 420, 0.85, '#ff4dd2');
      addShake(22, 0.7);
      burst(cx, cy, '#ff4dd2', 70, 380);
      spawnRing(cx, cy, COLORS.MAGENTA, 240, 0.7);

      // ▼ Bounce knockback — 충돌 직후 두 보스가 정확히 겹쳐 있지 않도록
      //   반대 방향으로 60px 씩 밀어낸 뒤 2초 그로기로 전환.
      //   d == 0 인 완전 겹침 케이스: 속도 벡터를 fallback 방향으로 사용.
      let nx, ny;
      if (d > 0.0001) {
        nx = dx / d;
        ny = dy / d;
      } else {
        // 속도 벡터가 살아있으면 그 방향(반대로 e 밀어내기), 아니면 수평으로 분리
        const vlen = Math.hypot(e.vx, e.vy) || 1;
        nx = -e.vx / vlen;  // e 가 가던 방향과 반대
        ny = -e.vy / vlen;
        if (Math.abs(nx) < 0.001 && Math.abs(ny) < 0.001) { nx = 1; ny = 0; }
      }
      const bounceDist = 60;
      e.x       -= nx * bounceDist;   // e 는 partner 반대 방향으로
      e.y       -= ny * bounceDist;
      partner.x += nx * bounceDist;   // partner 는 e 반대 방향으로
      partner.y += ny * bounceDist;
      // 경계 클램프 (벽에 박지 않도록)
      e.x       = Math.max(e.r, Math.min(W - e.r, e.x));
      e.y       = Math.max(e.r, Math.min(H - e.r, e.y));
      partner.x = Math.max(partner.r, Math.min(W - partner.r, partner.x));
      partner.y = Math.max(partner.r, Math.min(H - partner.r, partner.y));

      for (const boss of [e, partner]) {
        boss.state = 'combo_recover';
        boss.stateT = 2.0;          // 2초 그로기 (극딜 타임)
        boss.isAirborne = false;
        boss.vx = 0; boss.vy = 0;
      }
      return;
    }
  }
  // safety: if dash timeout without collision, recover (개별)
  if (e.stateT <= 0) {
    e.state = 'combo_recover';
    e.stateT = 1.0;
    e.isAirborne = false;
    e.vx = 0; e.vy = 0;
  }
}

function updateTwinComboRecover(e, dt) {
  e.stateT -= dt;                            // ← critical: tick down so state can exit
  if (e.stateT <= 0) {
    e.state = 'wait';
    e.stateT = 0.6;
  }
}

function triggerTwinEnrage(survivor) {
  if (!survivor || survivor.isDying || survivor.hp <= 0) return;
  // Wipe any in-flight twin state, switch to enraged init
  survivor.state = 'enrage_init';
  survivor.stateT = 1.0;
  survivor.restoreTarget = null;
  survivor.twinEnraged = true;
  survivor.shield = COLORS.MAGENTA;
  survivor.vulnerableHitsLeft = 0;
  survivor.rageT = 0;
  survivor.vx = 0; survivor.vy = 0;
  survivor.isAirborne = false;
  addShake(16, 0.7);
  burst(survivor.x, survivor.y, '#ff4dd2', 80, 420);
  spawnRing(survivor.x, survivor.y, COLORS.MAGENTA, 260, 0.85);
  spawnFloater(survivor.x, survivor.y - survivor.r - 40, '!! OVERCLOCKED !!', '#ff4dd2');
}

function updateTwinEnrageInit(e, dt) {
  e.stateT -= dt;                            // ← critical: tick down so state can exit
  if (e.stateT <= 0) {
    e.state = 'wait';
    e.stateT = 0.5;
  }
}

// Shared duo controller: ticks combo cooldown, fires combo when both ready.
function updateTwinDuo(dt) {
  if (!G.duo) return;
  const { red, blue } = G.duo;
  if (!red || !blue) return;
  // Repair cooldown decays at ALL times (including during stun/combo states)
  // so the cooldown can finish naturally even while a boss is busy elsewhere.
  if (G.duo.repairCD > 0) G.duo.repairCD -= dt;
  // If either is dying/dead, combo no longer applicable
  if (red.isDying || red.hp <= 0 || blue.isDying || blue.hp <= 0) return;
  // Pause combo cooldown while either boss is in a blocking state
  // (twin_stun / restore_cast / combo_*  / enrage_init).
  // → 마젠타 합선이 정확히 그 상태가 끝난 뒤에 발동되도록 보장.
  const blocking = (b) =>
    b.state === 'twin_stun' || b.state === 'combo_dash' ||
    b.state === 'combo_recover' || b.state === 'restore_cast' ||
    b.state === 'enrage_init';
  if (blocking(red) || blocking(blue)) return;
  G.duo.comboCD -= dt;
  if (G.duo.comboCD <= 0) {
    startTwinCombo();
    G.duo.comboCD = 11 + Math.random() * 4;  // 11–15s
  }
}

function updateBoss(e, p, dt, enraged, speedMul) {
  // Rage timer (shield-mismatch penalty — melee boss only, but harmless on others)
  if (e.rageT && e.rageT > 0) e.rageT -= dt;

  // ──────── Twin Boss shared states (handled BEFORE individual patterns) ────────
  // restore_cast / twin_stun / combo_dash / combo_recover / enrage_init are
  // co-ordinated across both bosses; they short-circuit the normal pattern loop.
  if (e.isTwinBoss) {
    if (e.state === 'restore_cast'  ) { updateTwinRestoreCast(e, dt); return; }
    if (e.state === 'twin_stun'     ) { updateTwinStun(e, dt);        return; }
    if (e.state === 'combo_dash'    ) { updateTwinComboDash(e, dt);   return; }
    if (e.state === 'combo_recover' ) { updateTwinComboRecover(e, dt);return; }
    if (e.state === 'enrage_init'   ) { updateTwinEnrageInit(e, dt);  return; }
    // any other state → fall through to normal melee/ranged pattern logic
  }

  // Phase 2 trigger — is15Boss: 40%, melee/ranged: 50%, others: 30%
  // ⚠ Skipped for Twin Bosses: their "Phase 2" is partner-death (handled in startDying).
  const phase2Threshold = e.is15Boss
    ? 0.4
    : ((e.bossKind === 'melee' || e.bossKind === 'ranged') ? 0.5 : 0.3);
  if (!e.isTwinBoss && !e.phase2 && e.hp <= e.hpMax * phase2Threshold) {
    e.phase2 = true;
    // is15Boss 는 frenzy+stun+firewall 시퀀스 스킵 (계속 4 패턴 시전, 1.5x 가속)
    if (!e.is15Boss) e.frenzyT = 3.0;
    addShake(8, 0.4);
    burst(e.x, e.y, '#ff4d6d', 40, 280);
    if (e.is15Boss) {
      // 1-5 보스: 폭주 진입 임팩트 (오버클록 안내)
      spawnFloater(e.x, e.y - e.r - 50, '!! OVERCLOCKED !!', '#ff4dd2');
      spawnRing(e.x, e.y, 'magenta', 200, 0.6);
      SoundManager.playSFX('boss_enrage');        // 1-5 보스 광폭화 진입 SFX
    }

    // ── Phase 2 last-stand → regenerate shield (melee + ranged bosses) ──
    // Player must break this NEW shield with a matching color again before
    // they can damage the remaining HP. This is the high-priority regen path
    // that overrides any in-flight vulnerable-window counter from the previous
    // (Phase 1) shield-break.
    if (e.bossKind === 'melee' || e.bossKind === 'ranged') {
      e.shield = randomMixedShield();
      e.vulnerableHitsLeft = 0;          // reset — fresh shield owns the gate now
      addShake(10, 0.5);
      burst(e.x, e.y, COL[e.shield].hex, 40, 300);
      spawnRing(e.x, e.y, e.shield, 160, 0.7);
      spawnFloater(e.x, e.y - e.r - 50, 'SHIELD REGEN', '#ff8a00');
    }
  }

  // Stun phase: spawn firewall once, freeze movement
  if (e.stunT > 0) {
    e.stunT -= dt;
    if (e.stunT <= 0) {
      // remove firewall mooks
      if (G.firewall) {
        G.firewall.mooks.forEach(m => {
          const idx = G.enemies.indexOf(m);
          if (idx >= 0) G.enemies.splice(idx, 1);
        });
        G.firewall = null;
      }
      // ⚠ Shield is NOT auto-regenerated here anymore. The only legal
      //   auto-regen point is the Phase 2 entry block above. Stun ending
      //   should leave the boss in whatever shield state it was in.
    }
    return;
  }

  // Frenzy → after timer, trigger stun + firewall
  if (e.frenzyT > 0) {
    e.frenzyT -= dt;
    // act extra aggressively while frenzy
    e.enrageTime = Math.max(e.enrageTime, 0.4);

    if (e.frenzyT <= 0) {
      // enter stun
      e.stunT = 4.0;
      spawnFirewall(e);
      addShake(10, 0.35);
      return;
    }
  }

  // Normal boss behavior
  const bk = e.bossKind;
  if (bk === 'melee') {
    updateMeleeBoss(e, p, dt, enraged, speedMul);
  }
  else if (bk === 'ranged') {
    updateRangedBoss(e, p, dt, enraged, speedMul);
  }
  // bk === 'tanker' branch REMOVED — tanker boss type no longer exists.
}

function spawnFirewall(boss) {
  const n = 6;
  const mooks = [];
  for (let i = 0; i < n; i++) {
    const m = makeEnemy('firewall_mook', boss.x, boss.y, {
      orbitAng: (i / n) * Math.PI * 2,
      orbitR: boss.r + 40,
      orbitBoss: boss,
    });
    G.enemies.push(m);
    mooks.push(m);
  }
  G.firewall = { boss, mooks };
}

function updateFirewall(dt) {
  // no-op; mooks update themselves in updateEnemies
}

// =====================================================
//  Bullets Update
// =====================================================
function updateBullets(dt) {
  for (let i = G.bullets.length - 1; i >= 0; i--) {
    const b = G.bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;

    // ── Ricochet (boss sniper Phase 2): bounce off canvas walls once ──
    // Bullets with bounceLeft > 0 reflect cleanly off the wall, decrement
    // bounceLeft, and keep flying. Once it hits 0, they exit normally.
    if (b.bounceLeft && b.bounceLeft > 0) {
      let bounced = false;
      if (b.x < b.r)           { b.x = b.r;       b.vx = Math.abs(b.vx);  bounced = true; }
      else if (b.x > W - b.r)  { b.x = W - b.r;   b.vx = -Math.abs(b.vx); bounced = true; }
      if (b.y < b.r)           { b.y = b.r;       b.vy = Math.abs(b.vy);  bounced = true; }
      else if (b.y > H - b.r)  { b.y = H - b.r;   b.vy = -Math.abs(b.vy); bounced = true; }
      if (bounced) {
        b.bounceLeft -= 1;
        burst(b.x, b.y, COL.magenta.hex, 4, 90);
      }
    }

    if (b.life <= 0 || b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) {
      G.bullets.splice(i, 1);
      continue;
    }
    if (b.owner === 'player') {
      let hit = false;
      for (let j = 0; j < G.enemies.length; j++) {
        const e = G.enemies[j];
        if (e.isGlitch) continue;
        if (b.hitSet && b.hitSet.includes(e)) continue; // pierce: skip already-hit
        const d = Math.hypot(e.x - b.x, e.y - b.y);
        if (d < e.r + b.r) {
          applyHitToEnemy(e, b);
          if (b.pierce) {
            b.hitSet.push(e);
            // continue traveling — don't break, allow hitting more
          } else {
            hit = true;
            break;
          }
        }
      }
      // magenta keeps going; remove only when life expires
      if (hit) G.bullets.splice(i, 1);
    } else {
      const p = G.player;
      // dash i-frames: projectiles pass through harmlessly
      if (p.isDashing) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < p.r + b.r) {
        damagePlayer(b.dmg);
        G.bullets.splice(i, 1);
      }
    }
  }
}

function applyHitToEnemy(e, b) {
  e.hitFlash = 0.12;
  // ⚠ hit_monster SFX 비활성 — 사격 빈도가 너무 잦아 청각적으로 거슬림.
  //   재활성 원하면 다음 라인 주석 해제:
  // SoundManager.playSFX('hit_monster');
  // brief hurt animation overlay (skipped if dying/glitched)
  if (!e.isDying && !e.isGlitch && (e.type === 'melee' || e.type === 'ranged')) {
    e.hurtT = 0.18;
  }

  // ── 폭탄 거미 (Bomb Spider) — 1 피격 즉사 + 6방향 데스 탄막 ──
  // shield / HP 로직 우회: 색 매칭이나 HP 상관없이 1발에 폭발.
  if (e.isBombSpider && !e._exploded) {
    burst(b.x, b.y, '#ffffff', 6, 100);          // 명중 시각 피드백
    explodeBombSpider(e, false);                  // 총알 킬: 컨택트 데미지 없음
    return;
  }

  // firewall mook: invincible, absorbs
  if (e.invincible) {
    burst(b.x, b.y, '#ffffff', 4, 80);
    return;
  }

  // Web-drop airborne: boss is "above the screen" → fully intangible.
  // Bullets that reach the boss's logical pos just sputter; no damage, no shield interaction.
  if (e.isAirborne) {
    burst(b.x, b.y, '#aaaaaa', 6, 100);
    return;
  }

  // ⚠ MAGENTA is NOT a shield-bypass. It still has one unique perk:
  //   • PIERCE: keeps flying after each hit (handled in updateBullets via b.pierce)
  // For SHIELD purposes magenta behaves like any other color and goes through
  // the standard bulletContainsShield() subset check below.
  //   magenta atoms = [B, R]   magenta shield atoms = [B, R] → match → break.
  // (The "reflect immune" perk is gone too — tankers no longer exist.)

  // tanker passive reflect REMOVED — tanker enemy type no longer exists.

  // ===== Unified shield / HP damage branch =====
  // shield-first: check shield presence → color match → vulnerable HP damage.
  if (e.shield) {
    // ─────────── Shielded ───────────
    if (bulletContainsShield(b.color, e.shield)) {
      // ✓ Correct color → shield breaks.
      const shieldCol = e.shield;
      e.shield = null;
      burst(e.x, e.y, COL[shieldCol].hex, 16, 200);
      spawnRing(e.x, e.y, shieldCol, 90, 0.45);

      if (e.isBoss) {
        // ── Boss: shield-only break ──
        // ⚠ HP is NOT decremented on this hit.
        if (e.isTwinBoss) {
          // ── Twin Boss path ──
          // 우선순위: (1) 본인이 수리 시전 중 → INTERRUPT
          //          (2) 파트너가 수리 가능한 상태 + repairCD <= 0 → RESTORE
          //          (3) 그 외 → vulnerableHitsLeft 2회 폴백 (자력 재생성)
          if (e.state === 'restore_cast') {
            // This boss was RESTORING partner → its own shield just broke.
            // → System overload INTERRUPT: both bosses stunned.
            triggerTwinStun(e, e.partner);
          } else {
            const partner = e.partner;
            const repairOnCooldown = !!(G.duo && G.duo.repairCD > 0);
            // 파트너가 합체기/기절/폭주init/이미 수리중 이면 수리 빔 시전 불가
            const partnerBusy = !partner
              || partner.isDying || partner.hp <= 0
              || partner.twinEnraged
              || partner.state === 'combo_dash'
              || partner.state === 'combo_recover'
              || partner.state === 'twin_stun'
              || partner.state === 'enrage_init'
              || partner.state === 'restore_cast';

            if (!repairOnCooldown && !partnerBusy) {
              // Partner alive & free, cooldown ready → partner starts the restore beam.
              startTwinRestore(partner, e);
              spawnFloater(e.x, e.y - e.r - 24, 'SHIELD DOWN', '#ffd166');
            } else {
              // Cooldown 중 OR partner busy → 자력 재생성 폴백 (2회 피격)
              e.vulnerableHitsLeft = 2;
              const tag = repairOnCooldown ? 'SHIELD DOWN  [REPAIR CD]' : 'SHIELD DOWN ×2';
              spawnFloater(e.x, e.y - e.r - 24, tag, '#ffd166');
            }
          }
        } else {
          // Standard boss → 2-hit vulnerable window before auto-regen
          e.vulnerableHitsLeft = 2;
          spawnFloater(e.x, e.y - e.r - 24, 'SHIELD DOWN ×2', '#ffd166');
        }
      } else {
        // ── Regular mob: shield break = instant death ──
        startDying(e, shieldCol);
      }
    } else {
      // ✗ Wrong color → bullet bounces off, no damage to shield or HP.
      // Melee boss: 5s RAGE mode (1.7× speed). Other shielded enemies: enrage.
      if (e.bossKind === 'melee') {
        e.rageT = 5.0;
        addShake(7, 0.35);
        burst(e.x, e.y, '#ff3030', 28, 260);
        spawnRing(e.x, e.y, 'red', 100, 0.5);
        spawnFloater(e.x, e.y - e.r - 24, 'RAGE  x1.7', '#ff3030');
      } else {
        enrage(e, 2.5);
      }
      burst(e.x, e.y, '#ffffff', 8, 100);
    }
  } else {
    // ─────────── Unshielded (vulnerable) ───────────
    // No shield → bullet color is irrelevant; HP always takes damage.
    e.hp -= b.dmg;
    if (e.hp <= 0) startDying(e, b.color);

    // ── Boss vulnerable window: consume one of the 2 allowed hits ──
    // Once 2 hits land, the boss snaps a fresh shield back on.
    // ⚠ Twin Boss 도 동일하게 동작 — 단, 파트너가 수리 가능한 상태(쿨다운 풀림 + 자유)
    //   라면 applyHitToEnemy 위쪽 분기에서 startTwinRestore 가 먼저 호출됐을 것이므로
    //   여기 들어오는 트윈 보스는 "쿨다운 중 / 파트너 사망 / 폭주" 케이스다.
    if (e.isBoss && !e.isDying && e.vulnerableHitsLeft > 0) {
      // Phase 2 priority guard (solo bosses only — twin bosses don't have Phase 2)
      const p2thr = (e.bossKind === 'melee' || e.bossKind === 'ranged') ? 0.5 : 0.3;
      const willTriggerPhase2 = !e.isTwinBoss && !e.phase2 && e.hp <= e.hpMax * p2thr;

      if (willTriggerPhase2) {
        // Phase 2 handles the regen — just clear the counter so we don't
        // accidentally trigger this branch again on the same tick.
        e.vulnerableHitsLeft = 0;
      } else {
        e.vulnerableHitsLeft -= 1;
        if (e.vulnerableHitsLeft <= 0) {
          // 2nd hit consumed → instant shield regen.
          // Twin Boss: 원래 색(originalShield)으로 복원 → 시각 일관성.
          // 그 외 보스: 새로운 랜덤 머지 색으로.
          e.shield = e.isTwinBoss
            ? (e.originalShield || randomMixedShield())
            : randomMixedShield();
          e.vulnerableHitsLeft = 0;
          addShake(5, 0.2);
          burst(e.x, e.y, COL[e.shield].hex, 24, 240);
          spawnRing(e.x, e.y, e.shield, 120, 0.5);
          spawnFloater(e.x, e.y - e.r - 24, 'SHIELD UP', '#ff8a00');
        } else {
          // 1 hit remaining → small visual cue so player knows the window is closing.
          spawnFloater(e.x, e.y - e.r - 18, '1 HIT LEFT', '#ff6c6c');
        }
      }
    }
  }

  // --- YELLOW = AOE SPLASH (ignores shields, deals 1 chip damage to all in radius) ---
  if (b.color === 'yellow') {
    spawnRing(e.x, e.y, COL.yellow.hex, 80, 0.4);
    for (const o of G.enemies) {
      if (o === e || o.isGlitch || o.invincible || o.isDying) continue;
      const dd = Math.hypot(o.x - e.x, o.y - e.y);
      if (dd < 80) {
        o.hp -= 1; o.hitFlash = 0.1;
        if (!o.isDying && (o.type === 'melee' || o.type === 'ranged')) o.hurtT = 0.18;
        if (o.hp <= 0) startDying(o, 'yellow');
      }
    }
    addShake(3, 0.12);
  }

  // --- CYAN = AOE SLOW (applies to all in radius regardless of shield) ---
  if (b.color === 'cyan') {
    spawnRing(e.x, e.y, COL.cyan.hex, 80, 0.4);
    for (const o of G.enemies) {
      if (o.isGlitch || o.invincible) continue;
      const dd = Math.hypot(o.x - e.x, o.y - e.y);
      if (dd < 80) {
        o.slowTime = Math.max(o.slowTime, 3);
      }
    }
  }
}

// reflectShot REMOVED — only the (now-removed) tanker enemy type used it.

// Start death animation. Melee/ranged enemies (including bosses) play the spider
// or drone death sheet. firewall_mook / unknown types fall back to
// immediate glitch transition.
function startDying(e, color) {
  if (e.isDying || e.isGlitch) return;
  // ── Final boss check: stage 3-5 boss → trigger ending sequence ──
  // ⚠ Twin Boss exception: the FIRST core to die at 3-5 is NOT the final kill.
  //    Partner is still alive (will enrage) — let this core go through the
  //    normal death-anim → glitch path so the player can clean it up later
  //    (clear bonus auto-collects any leftover boss glitches at ending).
  //    Only when both partners are down does the ending trigger.
  if (e.isBoss && isFinalBossStage(G.stage)) {
    const partnerStillAlive = e.isTwinBoss && e.partner
      && !e.partner.isDying && !e.partner.isGlitch && e.partner.hp > 0;
    if (!partnerStillAlive) {
      triggerFinalBossDefeat(e);
      return;
    }
    // else: fall through to becomeGlitch / normal twin death handling below
  }
  const isSpiderKind = e.type === 'melee'  || e.bossKind === 'melee';
  const isDroneKind  = e.type === 'ranged' || e.bossKind === 'ranged';
  if (!isSpiderKind && !isDroneKind) {
    becomeGlitch(e, color);
    return;
  }
  e.isDying = true;
  e._dyingColor = color;
  const cfg = isSpiderKind ? SPR_SPIDER : SPR_DRONE;
  const da = cfg.anims.death;
  e.deathT = da.count / da.fps;
  if (e.anim) { e.anim.key = 'death'; e.anim.t = 0; }
  e.vx = 0; e.vy = 0;

  // ── Twin Boss: surviving partner enters ENRAGE phase ──
  // The dying boss's data is "absorbed" by the partner → 2× speed + magenta shield.
  if (e.isTwinBoss && e.partner
      && !e.partner.isDying && e.partner.hp > 0
      && !e.partner.twinEnraged) {
    triggerTwinEnrage(e.partner);
  }
}

// Stage 3-5 is the final-boss encounter (loop 3, sub-stage 5 → stage = 15).
function isFinalBossStage(stage) {
  return loopNum(stage) === 3 && subStage(stage) === 5;
}

// Detonate the final boss, freeze the world, and start the ending sequence.
function triggerFinalBossDefeat(boss) {
  // Capture the boss's death point for the explosion center
  const dx = boss.x, dy = boss.y;

  // ── Clear Bonus auto-collect ───────────────────────────────────────────
  //  Before wiping the world, hand the player every boss reward they earned:
  //   • This boss (the killing-blow boss) — hasn't become glitch yet
  //   • Any leftover boss glitches still on the floor (e.g. the first Twin
  //     core whose body hasn't been walked over yet)
  //  Twin Boss cores award 60 each (120 total for the duo).
  //  Other bosses award bossBits(loop).
  let bonusBits = 0;
  const loop = loopNum(G.stage);
  if (boss && boss.isBoss) {
    bonusBits += boss.isTwinBoss ? 60 : bossBits(loop);
  }
  for (const ent of G.enemies) {
    if (!ent || ent === boss) continue;
    if (ent.isGlitch && ent.isBoss) {
      bonusBits += ent.isTwinBoss ? 60 : bossBits(loop);
    }
  }
  G.sessionBits += bonusBits;
  updateBitsUI();

  // ── Convert ALL remaining sessionBits → coreBits (clear bonus, 1:1) ──
  // The player gets to keep everything they earned this run, permanently.
  const clearBonusCBits = G.sessionBits | 0;
  G.coreBits += clearBonusCBits;
  G.sessionBits = 0;
  saveLobby();
  updateBitsUI();

  // Remember for the stats screen display
  G.endingClearBonus = clearBonusCBits;
  G.endingBossBonus  = bonusBits;

  // ── Clear all active entities & FX immediately (clean ending stage) ──
  G.enemies.length    = 0;
  G.bullets.length    = 0;
  G.drops.length      = 0;
  G.telegraphs.length = 0;
  G.webs.length       = 0;
  G.shockwaves.length = 0;
  if (G.deadlockWalls) G.deadlockWalls.length = 0;
  floaters.length     = 0;        // ← SHIELD UP / RAGE 등 잔존 텍스트 청소
  if (G.hpHitParticles) G.hpHitParticles.length = 0;
  G.duo               = null;
  G.firewall = null;
  G.portal   = null;

  // ── Huge "data glitch" explosion at the death point ──
  // Three concentric bursts in red / cyan / magenta for the cyberpunk feel.
  addShake(20, 0.8);
  burst(dx, dy, '#ff4d6d', 60, 480);
  burst(dx, dy, '#4de2ff', 50, 360);
  burst(dx, dy, '#ff4dd2', 40, 280);
  spawnRing(dx, dy, 'magenta', 320, 1.0);
  spawnRing(dx, dy, 'cyan',    220, 0.8);
  spawnRing(dx, dy, 'red',     140, 0.6);
  // (Keep particles/ringFX alive — they're cleaned up by their own life timers.)

  // ── Enter the ending sequence ──
  // 시네마틱 3단계: cleanse (player-centered shockwave + whiteout)
  //              → terminal (typing console + SYSTEM RESTORED)
  //              → stats (jackpot tally count-up)
  const pl = G.player || { x: W * 0.5, y: H * 0.5 };
  G.ending = {
    phase:  'cleanse',
    t:      0,
    deathX: dx,
    deathY: dy,
    playerX: pl.x,        // cleanse 충격파 epicenter
    playerY: pl.y,
    finalStats: {
      playTime:     G.stats.playTime,
      hitsTaken:    G.stats.hitsTaken,
      colorsMerged: G.stats.colorsMerged,
    },
    // ── Jackpot tally (stats 페이즈 진입 시 사용) ──
    tally:        0,
    tallyTarget:  clearBonusCBits,
    tallyDone:    false,
    tallyPulseT:  0,
  };
  G.state = 'ending_cleanse';
  G.pendingLobby = false;       // cancel any pending death→lobby route
  hideAllOverlays();
  // Hide in-game HUD so it doesn't sit on top of the SYSTEM RESTORED screen.
  setGameHudVisible(false);
}

// Toggle the persistent in-game HUD (stage/HP/bits/queue/hold). Used to hide
// these during the ending screen and restore them on reset.
function setGameHudVisible(visible) {
  const ids = ['hud-top', 'ammo-panel', 'hold-panel'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
  }
}

// =====================================================
//  Ending Sequence (final boss defeat)
// =====================================================
// 3단계 시네마틱 타이밍
const ENDING_CLEANSE_DUR  = 1.5;     // 정화 충격파 + 화이트아웃
const ENDING_TERMINAL_DUR = 10.0;    // 콘솔 타이프라이터 (4줄 + 카운트업) + SYSTEM RESTORED + 읽기 여유
const ENDING_BLAST_DUR    = 3.0;     // (legacy, ending_blast 진입 시 fallback)

// 터미널 시퀀스 타이프라이터 상수
const TERM_CHAR_DELAY  = 0.04;       // 글자 1개당 40ms
const TERM_LINE_DELAY  = 0.4;        // 라인 사이 일시정지 400ms
const TERM_INTRO_DELAY = 0.35;       // 검정 페이드 후 첫 글자까지 350ms

// 라인 정의:
//   kind: 'type'  → 평범한 타이프라이터 라인 (text)
//   kind: 'count' → prefix 타이핑 후 0~100% 무작위 카운트업 + suffix
//                   countDur(카운트 지속) / holdAfter(100% hold)
const TERM_LINES = [
  { kind: 'type',  text: '> Terminating malicious threads... [FORCE KILL]' },
  { kind: 'type',  text: '> Decrypting boot sector... [SUCCESS]' },
  { kind: 'count',
    prefix: '> Verifying system integrity... [',
    suffix: ']',
    countDur:  0.6,                  // 카운트업 0.6초간 진행
    holdAfter: 0.5 },                // [100%] 도달 후 0.5초 정적
  { kind: 'type',  text: '> OS_REBOOT_INITIATED.' },
];

function updateEnding(dt) {
  if (!G.ending) { G.state = 'title'; return; }
  G.ending.t += dt;

  // Tick particles & ring FX so the explosion still animates during the blast.
  updateParticles(dt);

  // ── Stage 1: Cleanse Shockwave (1.5s) ──
  if (G.state === 'ending_cleanse') {
    if (G.ending.t >= ENDING_CLEANSE_DUR) {
      G.state    = 'ending_terminal';
      G.ending.t = 0;
    }
    return;
  }

  // ── Stage 2: Terminal Sequence (2.5s) ──
  if (G.state === 'ending_terminal') {
    if (G.ending.t >= ENDING_TERMINAL_DUR) {
      G.state    = 'ending_stats';
      G.ending.t = 0;
    }
    return;
  }

  // ── Stage 3: Stats with Jackpot Tally (count-up) ──
  if (G.state === 'ending_stats') {
    // 카운트업: 매 프레임 (target - current) × 0.07 + 1 만큼 증가 (지수적으로 감속)
    if (!G.ending.tallyDone && G.ending.tallyTarget > 0) {
      const remaining = G.ending.tallyTarget - G.ending.tally;
      if (remaining <= 0) {
        G.ending.tallyDone   = true;
        G.ending.tallyPulseT = 0;
      } else {
        // 7%/frame + 최소 1 → 큰 숫자는 빠르게, 작은 마무리는 한 자리씩
        const inc = Math.max(1, Math.ceil(remaining * 0.07));
        G.ending.tally = Math.min(G.ending.tally + inc, G.ending.tallyTarget);
        if (G.ending.tally >= G.ending.tallyTarget) {
          G.ending.tallyDone   = true;
          G.ending.tallyPulseT = 0;
          addShake(4, 0.18);   // 마무리 임팩트
        }
      }
    } else if (G.ending.tallyDone) {
      G.ending.tallyPulseT = (G.ending.tallyPulseT || 0) + dt;
    } else {
      // tallyTarget === 0 인 케이스: 즉시 done
      G.ending.tallyDone = true;
    }

    if (consumeJustPressed('Enter')) {
      resetEverything();
    }
    return;
  }

  // ── Legacy: ending_blast (구버전 호환 — 이제 사용 안 함, fallback only) ──
  if (G.state === 'ending_blast') {
    if (G.ending.t >= ENDING_BLAST_DUR) {
      G.state    = 'ending_stats';
      G.ending.t = 0;
    }
    return;
  }
}

function drawEndingOverlay() {
  if (!G.ending) return;

  // ────────────────────────────────────────────────────────────
  //  Stage 1: CLEANSE — expanding cyan/white shockwave + whiteout
  // ────────────────────────────────────────────────────────────
  if (G.state === 'ending_cleanse') {
    const t   = G.ending.t;
    const k   = Math.min(1, t / ENDING_CLEANSE_DUR);
    const ke  = k * k;                                    // ease-in (가속 팽창)
    const maxR = Math.hypot(W, H) * 0.95;                 // 화면 대각선보다 커야 전체 덮음
    const radius = maxR * ke;
    const px = G.ending.playerX, py = G.ending.playerY;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 어두운 배경 워시 (배경 게임 잔상 위에 살짝)
    ctx.fillStyle = `rgba(0, 0, 0, ${k * 0.25})`;
    ctx.fillRect(0, 0, W, H);

    // 안쪽 시안 워시 (filled, 부드러운 빛)
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(77, 226, 255, ${0.18 + k * 0.20})`;
    ctx.beginPath();
    ctx.arc(px, py, radius * 0.92, 0, Math.PI * 2);
    ctx.fill();

    // 시안 외곽 링 (글로우)
    ctx.strokeStyle = '#4de2ff';
    ctx.shadowColor = '#4de2ff';
    ctx.shadowBlur  = 40;
    ctx.lineWidth   = 8 + k * 30;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.stroke();

    // 흰색 코어 링 (안쪽)
    ctx.strokeStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur  = 30;
    ctx.lineWidth   = 4 + k * 18;
    ctx.beginPath();
    ctx.arc(px, py, radius * 0.92, 0, Math.PI * 2);
    ctx.stroke();

    // 마지막 30% 화이트아웃 (whiteout fade)
    ctx.globalCompositeOperation = 'source-over';
    if (k > 0.7) {
      const wA = (k - 0.7) / 0.3;     // 0 → 1
      ctx.fillStyle = `rgba(255, 255, 255, ${wA})`;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
    return;
  }

  // ────────────────────────────────────────────────────────────
  //  Stage 2: TERMINAL — typing console + SYSTEM RESTORED reveal
  // ────────────────────────────────────────────────────────────
  if (G.state === 'ending_terminal') {
    const t = G.ending.t;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 첫 0.25s: 흰색 → 검정 페이드 (cleanse whiteout 에서 자연스럽게 연결)
    if (t < 0.25) {
      const fadeK = t / 0.25;
      ctx.fillStyle = `rgba(255, 255, 255, ${1 - fadeK})`;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = `rgba(0, 0, 0, ${fadeK})`;
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
    }

    // 미세 시안 그리드 (cyberpunk 백드롭)
    ctx.strokeStyle = 'rgba(77, 226, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 32) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 32) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // ── 콘솔 타이프라이터 (좌상단, 초록 console) ──
    // 각 글자 40ms, 라인 사이 400ms 딜레이, █ 커서 (타이핑 중 항상 표시 / idle 시 2Hz 깜빡)
    ctx.font         = 'bold 18px monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowColor  = '#3ddc6b';
    ctx.shadowBlur   = 8;
    ctx.fillStyle    = '#3ddc6b';

    // 각 라인의 시작/종료 시각을 누적 계산 (kind별 길이 다름)
    const lineSchedule = [];
    let cursorT = TERM_INTRO_DELAY;
    for (let i = 0; i < TERM_LINES.length; i++) {
      const line = TERM_LINES[i];
      const startT = cursorT;
      let endT;
      if (line.kind === 'count') {
        const prefixDur = line.prefix.length * TERM_CHAR_DELAY;
        endT = startT + prefixDur + line.countDur + line.holdAfter;
      } else {
        endT = startT + line.text.length * TERM_CHAR_DELAY;
      }
      lineSchedule.push({ ...line, startT, endT });
      cursorT = endT + TERM_LINE_DELAY;
    }
    const allDoneT = lineSchedule[lineSchedule.length - 1].endT;

    // 모든 라인 표시할 마지막 텍스트 (커서 깜빡임 위치 계산용)
    const lastIdx = lineSchedule.length - 1;
    const lastLine = lineSchedule[lastIdx];
    const lastDoneText = lastLine.kind === 'count'
      ? (lastLine.prefix + '100%' + lastLine.suffix)
      : lastLine.text;

    // 라인별 렌더
    let activeLineIdx = -1;
    for (let i = 0; i < lineSchedule.length; i++) {
      const line = lineSchedule[i];
      if (t < line.startT) break;
      const yPos = 36 + i * 28;
      const localT = t - line.startT;

      if (line.kind === 'type') {
        // ── 평범한 타이프라이터 ──
        const isTyping = t < line.endT;
        const chars = isTyping
          ? Math.floor(localT / TERM_CHAR_DELAY)
          : line.text.length;
        let display = line.text.slice(0, chars);
        if (isTyping) {
          display += '█';
          activeLineIdx = i;
        }
        ctx.fillText(display, 36, yPos);
      } else if (line.kind === 'count') {
        // ── prefix 타이핑 + 카운트업 + hold ──
        const prefixDur = line.prefix.length * TERM_CHAR_DELAY;

        if (localT < prefixDur) {
          // Phase A: prefix 타이핑
          const chars = Math.floor(localT / TERM_CHAR_DELAY);
          const display = line.prefix.slice(0, chars) + '█';
          ctx.fillText(display, 36, yPos);
          activeLineIdx = i;
        } else if (localT < prefixDur + line.countDur) {
          // Phase B: 카운트업 (랜덤 +3~+14, 매 프레임 증가, jitter + 알파 깜빡)
          // 카운터는 G.ending 에 저장 (프레임 사이 유지)
          if (G.ending._countNow == null) G.ending._countNow = 0;
          // 끝 0.08초 전이면 100 강제 (혹시 못 도달했을 경우 안전망)
          const countT = localT - prefixDur;
          const timeLeft = line.countDur - countT;
          if (timeLeft < 0.08) {
            G.ending._countNow = 100;
          } else if (G.ending._countNow < 100) {
            const inc = 3 + Math.floor(Math.random() * 12);  // +3 ~ +14
            G.ending._countNow = Math.min(100, G.ending._countNow + inc);
          }

          // Jitter + brightness flicker (CPU 연산 격렬한 느낌)
          const jx = (Math.random() - 0.5) * 2.4;
          const jy = (Math.random() - 0.5) * 2.0;
          const flicker = 0.55 + Math.random() * 0.45;     // alpha 0.55~1.0
          const padded = String(G.ending._countNow).padStart(2, ' ');
          const display = line.prefix + padded + '%' + line.suffix;

          ctx.save();
          ctx.globalAlpha = flicker;
          // 글로우도 살짝 증폭 (CPU 미친듯이 연산)
          ctx.shadowBlur = 12 + Math.random() * 4;
          ctx.fillText(display, 36 + jx, yPos + jy);
          ctx.restore();
          activeLineIdx = i;
        } else if (localT < prefixDur + line.countDur + line.holdAfter) {
          // Phase C: 100% hold — 흔들림 없이 깔끔하게
          G.ending._countNow = 100;
          const display = line.prefix + '100%' + line.suffix;
          ctx.fillText(display, 36, yPos);
          activeLineIdx = i;
        } else {
          // Phase D: 완료, 그대로 표시 (다음 라인 진행)
          const display = line.prefix + '100%' + line.suffix;
          ctx.fillText(display, 36, yPos);
        }
      }
    }

    // 모든 라인 타이핑 완료 → 마지막 라인 끝에 깜빡이는 커서 (2Hz)
    if (t >= allDoneT && activeLineIdx === -1) {
      const blinkOn = Math.floor((t - allDoneT) * 2) % 2 === 0;
      if (blinkOn) {
        const textW = ctx.measureText(lastDoneText).width;
        ctx.fillText('█', 36 + textW + 2, 36 + lastIdx * 28);
      }
    }

    ctx.shadowBlur = 0;

    // ── SYSTEM RESTORED 거대 텍스트 (모든 타이핑 종료 + 0.3s 후) ──
    const SYS_START = allDoneT + 0.3;
    if (t >= SYS_START) {
      const sk = Math.min(1, (t - SYS_START) / 0.5);
      ctx.globalAlpha  = sk;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.font         = 'bold 64px monospace';
      // 글로우
      ctx.shadowColor = '#4de2ff';
      ctx.shadowBlur  = 36;
      ctx.fillStyle   = '#4de2ff';
      ctx.fillText('SYSTEM RESTORED', W / 2, H * 0.50);
      // 흰색 윤곽선 펄스
      ctx.shadowBlur  = 0;
      const sysPulse  = 0.55 + 0.45 * Math.sin(t * 6);
      ctx.lineWidth   = 1.5;
      ctx.strokeStyle = `rgba(255, 255, 255, ${sysPulse * sk})`;
      ctx.strokeText('SYSTEM RESTORED', W / 2, H * 0.50);

      // 부가 서브 텍스트
      ctx.globalAlpha = sk * 0.7;
      ctx.fillStyle   = '#ff4dd2';
      ctx.shadowColor = '#ff4dd2';
      ctx.shadowBlur  = 8;
      ctx.font        = 'bold 14px monospace';
      ctx.fillText('// THREAT_NEUTRALIZED', W / 2, H * 0.58);
      ctx.shadowBlur  = 0;
      ctx.globalAlpha = 1;
    }

    ctx.restore();
    return;
  }

  // ────────────────────────────────────────────────────────────
  //  Stage 1.5 (LEGACY fallback): Blast — 구 동작 유지
  // ────────────────────────────────────────────────────────────
  if (G.state === 'ending_blast') {
    let alpha = 0;
    if (G.ending.t > 0.5) {
      alpha = Math.min(1, (G.ending.t - 0.5) / (ENDING_BLAST_DUR - 0.5));
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    return;
  }

  // ────────────────────────────────────────────────────────────
  //  Stage 3: STATS — Jackpot tally count-up
  // ────────────────────────────────────────────────────────────
  if (G.state === 'ending_stats') {
    const stats = G.ending.finalStats;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Solid black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);

    // Subtle grid backdrop for cyberpunk feel
    ctx.strokeStyle = 'rgba(77, 226, 255, 0.06)';
    ctx.lineWidth = 1;
    const step = 32;
    for (let x = 0; x < W; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Fade-in for the title text in the first 0.4s of stats phase
    const titleAlpha = Math.min(1, G.ending.t / 0.4);

    // ── Title: SYSTEM RESTORED (cyan neon) ──
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 56px monospace';
    ctx.globalAlpha = titleAlpha;
    ctx.shadowColor = '#4de2ff';
    ctx.shadowBlur  = 28;
    ctx.fillStyle   = '#4de2ff';
    ctx.fillText('SYSTEM RESTORED', W / 2, H * 0.28);
    ctx.shadowBlur  = 0;
    // White outline pulse
    const pulse = 0.55 + 0.45 * Math.sin(G.ending.t * 3);
    ctx.lineWidth   = 1.5;
    ctx.strokeStyle = `rgba(255, 255, 255, ${pulse})`;
    ctx.strokeText('SYSTEM RESTORED', W / 2, H * 0.28);

    // ── Subline divider ──
    ctx.globalAlpha = titleAlpha * 0.6;
    ctx.fillStyle = '#ff4dd2';
    ctx.font = 'bold 13px monospace';
    ctx.fillText('// PLAY  REPORT', W / 2, H * 0.36);
    // horizontal accent lines
    ctx.strokeStyle = '#ff4dd2';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(W * 0.30, H * 0.395); ctx.lineTo(W * 0.70, H * 0.395);
    ctx.stroke();

    // ── Stats rows ──
    ctx.globalAlpha = Math.min(1, Math.max(0, (G.ending.t - 0.3) / 0.5));
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'left';
    const labelX = W * 0.30;
    const valueX = W * 0.70;
    const rowH   = 44;
    let   rowY   = H * 0.48;

    // ── Jackpot tally: 0부터 G.endingClearBonus 까지 카운트업 + 완료 시 펄스 ──
    const tallyNow   = G.ending.tally | 0;
    const tallyDone  = !!G.ending.tallyDone;
    const tallyPulse = G.ending.tallyPulseT || 0;
    const bonusLabel = `${tallyNow} cBit ${tallyDone ? 'Saved!' : '...'}`;
    const rows = [
      ['CLEAR TIME',     formatPlayTime(stats.playTime), false, 'normal'],
      ['SYSTEM DAMAGE',  String(stats.hitsTaken).padStart(2, '0'), false, 'normal'],
      ['DATA MERGED',    String(stats.colorsMerged).padStart(2, '0'), false, 'normal'],
      ['CLEAR BONUS',    bonusLabel, true, 'tally'],   // 카운트업 강조 행
    ];
    for (const [k, v, highlight, kind] of rows) {
      ctx.fillStyle = highlight ? '#ff4dd2' : '#aab2c5';
      ctx.textAlign = 'left';
      ctx.fillText(k, labelX, rowY);

      // Jackpot 행 - 완료 시 1초간 펄스 (크기 + 글로우 증폭)
      let scale = 1, extraBlur = 0;
      if (kind === 'tally' && tallyDone && tallyPulse < 1.0) {
        const pk = 1 - tallyPulse;                          // 1 → 0
        scale     = 1 + 0.35 * pk * Math.cos(tallyPulse * 18); // 진동
        extraBlur = 16 * pk;
      } else if (kind === 'tally' && !tallyDone) {
        // 카운팅 중에도 살짝 떨림 (1.5px sine)
        scale = 1 + 0.04 * Math.sin(G.ending.t * 24);
      }

      ctx.fillStyle = highlight ? '#ff4dd2' : '#ffd166';
      ctx.shadowColor = highlight ? '#ff4dd2' : '#ff8a00';
      ctx.shadowBlur = (highlight ? 14 : 6) + extraBlur;
      ctx.textAlign = 'right';
      if (scale !== 1) {
        ctx.save();
        ctx.translate(valueX, rowY);
        ctx.scale(scale, scale);
        ctx.fillText(v, 0, 0);
        ctx.restore();
      } else {
        ctx.fillText(v, valueX, rowY);
      }
      ctx.shadowBlur = 0;
      rowY += rowH;
    }

    // ── Blinking [Enter] prompt ──
    ctx.globalAlpha = (Math.floor(G.ending.t * 1.6) % 2 === 0) ? 1 : 0.25;
    ctx.fillStyle = '#ff4d6d';
    ctx.shadowColor = '#ff3030';
    ctx.shadowBlur = 12;
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('[ENTER]  SYSTEM REBOOT — RETURN TO LOBBY', W / 2, H * 0.85);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

function formatPlayTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Full hard-reset on [Enter] from the ending screen.
// Wipes session save, permanent upgrades, all run state — returns to title.
function resetEverything() {
  // Wipe persistent (this-session) lobby progress
  try { sessionStorage.removeItem(SAVE_KEY); } catch (_) {}
  G.coreBits = 0;
  G.lobby.upgrades = {
    bus_overclock: 0, hardware_accel: 0,
    core_upgrade:  0, memory_bank:    0,
  };

  // Per-run state
  G.sessionBits = 0;
  G.shop.counts = { register_extension: 0, buffer_opt: 0, anti_virus_shield: 0 };
  G.shop.multiThreadBought = false;
  G.stats   = { playTime: 0, hitsTaken: 0, colorsMerged: 0 };
  G.ending  = null;
  G.endingClearBonus = 0;       // reset bonus banner so next run doesn't show stale value
  G.endingBossBonus  = 0;
  G.lastRun = null;

  // World entities
  G.enemies.length    = 0;
  G.bullets.length    = 0;
  G.drops.length      = 0;
  G.particles.length  = 0;
  G.telegraphs.length = 0;
  G.webs.length       = 0;
  G.shockwaves.length = 0;
  if (G.deadlockWalls) G.deadlockWalls.length = 0;
  floaters.length     = 0;          // ← 풀 리셋: floating text 완전 비움
  if (G.hpHitParticles) G.hpHitParticles.length = 0;
  G.duo               = null;
  G.portal   = null;
  G.firewall = null;
  G.bossIntro = null;
  G.pendingLobby = false;
  G.lobbyOverlap = null;
  G.shake.t = 0; G.shake.mag = 0;
  G.cam.x = W / 2; G.cam.y = H / 2;
  G.stage = 1;

  // Re-create the player with BASE stats (lobby upgrades are now all 0).
  G.player = makePlayer();

  // Refresh DOM HUD + show title overlay
  refreshAmmoUI();
  updateHpUI();
  updateBitsUI();
  setGameHudVisible(true);                   // restore in-game HUD
  hideAllOverlays();
  showOverlay('title');
  G.state = 'title';
}

function becomeGlitch(e, color) {
  e.isGlitch = true;
  e.glitchTimer = 3;
  e.glitchColor = color || 'red';
  e.shield = null;
  e.hp = 0;

  // ── 새 페이즈 머신: 'burst' → 'float' → 'reassemble' → ('purged') ──
  e.glitchPhase  = 'burst';
  e.glitchPhaseT = 0;
  e.purgeT       = 0;

  // ── Shell shrapnel: 몬스터 크기에 비례한 색 파티클 ──
  //   일반: 20~30개 / 보스: 60~100개
  const isBoss  = !!e.isBoss;
  const pcount  = isBoss
    ? (60 + Math.floor(Math.random() * 41))
    : (20 + Math.floor(Math.random() * 11));
  const r       = e.r;
  const cHex    = COL[color]?.hex  || '#ff4d6d';
  const cGlow   = COL[color]?.glow || '#ffd166';

  e.glitchParticles = [];
  for (let i = 0; i < pcount; i++) {
    const ang   = Math.random() * Math.PI * 2;
    const speed = 100 + Math.random() * 240;          // 100~340 px/s 초기 폭발
    // Reassemble 시 lerp 할 목표 위치(와이어프레임 안쪽 무작위 점)
    const hAng  = Math.random() * Math.PI * 2;
    const hDist = Math.random() * r * 0.7;
    // Float 페이즈에서 부유할 궤도 (와이어프레임 외곽)
    const orbR  = r * (0.95 + Math.random() * 0.7);
    e.glitchParticles.push({
      ox:    0,                                       // 와이어프레임 중심 기준 offset
      oy:    0,
      vx:    Math.cos(ang) * speed,
      vy:    Math.sin(ang) * speed,
      size:  2 + Math.floor(Math.random() * 3),       // 2~4px 픽셀
      color: Math.random() < 0.7 ? cHex : cGlow,
      hx:    Math.cos(hAng) * hDist,                  // reassemble 타겟 (안쪽)
      hy:    Math.sin(hAng) * hDist,
      orbR:  orbR,
      orbAng: ang,
      orbVel: (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.55),
      alpha: 1,
    });
  }

  burst(e.x, e.y, cHex, isBoss ? 10 : 4, 120);   // 작은 임팩트 (파편이 메인)
  addShake(isBoss ? 6 : 3, 0.15);

  // Event drop: shield-aware paint at enemy death location (80% chance)
  if (!e.invincible && Math.random() < 0.80 && G.drops.length < 6) {
    spawnDropAt(e.x, e.y, pickPaintDrop());
  }
}

function nearestEnemy(x, y) {
  let best = null, bestD = Infinity;
  for (const e of G.enemies) {
    if (e.isGlitch) continue;
    const d = (e.x - x) ** 2 + (e.y - y) ** 2;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function damagePlayer(amount) {
  const p = G.player;
  if (p.invuln > 0) return;
  // already dead in this tick — drop further damage so gameOver isn't re-fired
  if (p.hp <= 0 || G.pendingLobby) return;

  // Anti-Virus Shield: consume one charge, ignore damage
  if (p.shieldCount && p.shieldCount > 0) {
    p.shieldCount -= 1;
    p.invuln = 0.4;
    addShake(4, 0.15);
    burst(p.x, p.y, '#aef4ff', 18, 200);
    spawnRing(p.x, p.y, 'cyan', 70, 0.35);
    spawnFloater(p.x, p.y - 30, 'SHIELD ABSORBED', '#aef4ff');
    return;
  }

  p.hp -= amount;
  p.invuln = 0.6;
  p.hitAnimT = 0.45;        // play the "hit" sprite animation
  G.stats.hitsTaken += 1;   // ← run stat: damaging hits (shield absorbs above already returned)
  addShake(8, 0.25);
  burst(p.x, p.y, '#ff6c6c', 10, 160);
  updateHpUI();
  SoundManager.playSFX('hit');   // 플레이어 피격 SFX (HP 깎인 케이스만)

  // Event drop: shield-aware paint drop when the player takes a hit.
  // Helps recover from "wrong-color queue" deadlock — the very moment you
  // need ammo most, the game biases toward what breaks the threat in front of you.
  if (G.drops.length < 6 && p.hp > 0) {
    spawnDropAt(
      80 + Math.random() * (W - 160),
      80 + Math.random() * (H - 160),
      pickPaintDrop()
    );
  }

  if (p.hp <= 0) gameOver();
}

function updateDrops(dt) {
  for (let i = G.drops.length - 1; i >= 0; i--) {
    const d = G.drops[i];
    d.bob += dt * 3;
    const dd = Math.hypot(d.x - G.player.x, d.y - G.player.y);
    if (dd < d.r + G.player.r + 4) {
      if (ammoPush(d.color)) {
        burst(d.x, d.y, COL[d.color].hex, 10, 100);
        G.drops.splice(i, 1);
      }
    }
  }
  // Trickle drops — passive paint regen between kills.
  // Uses smart pick so the player isn't waiting on RNG for the right color.
  if (stageType(G.stage) !== 'boss' && stageType(G.stage) !== 'shop') {
    if (Math.random() < dt * 0.25 && G.drops.length < 4) {
      G.drops.push(makeDrop(pickPaintDrop()));
    }
  } else if (stageType(G.stage) === 'boss') {
    // Boss fights get a higher trickle. 30% chance of a direct secondary (Y/C/M)
    // so the player has a path to break secondary shields without merge gymnastics.
    if (Math.random() < dt * 0.5 && G.drops.length < 5) {
      const c = Math.random() < 0.30
        ? SECONDARIES[Math.floor(Math.random() * 3)]
        : pickPaintDrop();
      G.drops.push(makeDrop(c));
    }
  }
}

function updateParticles(dt) {
  for (let i = G.particles.length - 1; i >= 0; i--) {
    const p = G.particles[i];
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.92; p.vy *= 0.92;
    if (p.life <= 0) G.particles.splice(i, 1);
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt;
    f.y -= dt * 30;
    if (f.life <= 0) floaters.splice(i, 1);
  }
  for (let i = ringFX.length - 1; i >= 0; i--) {
    const r = ringFX[i];
    r.life -= dt;
    if (r.life <= 0) ringFX.splice(i, 1);
  }
}

function updatePortal(dt) {
  if (!G.portal) return;
  G.portal.t += dt;

  // ── Lazy-init runtime fields used by the glitch vortex renderer ──
  if (!G.portal.particles)   G.portal.particles   = [];
  if (G.portal.spawnAccum == null) G.portal.spawnAccum = 0;

  // ── Proximity 0~1: 플레이어가 가까워질수록 1에 가까워짐 (220px 안쪽부터) ──
  const p = G.player;
  let prox = 0;
  if (p) {
    const dPlayer = Math.hypot(p.x - G.portal.x, p.y - G.portal.y);
    const proxRange = 220;
    prox = Math.max(0, Math.min(1, 1 - dPlayer / proxRange));
  }
  G.portal.prox = prox;

  // ── Pixel-square particle spawn (base 6/s, +18/s 가까울수록) ──
  const spawnRate = 6 + 18 * prox;
  G.portal.spawnAccum += spawnRate * dt;
  while (G.portal.spawnAccum >= 1) {
    G.portal.spawnAccum -= 1;
    const startRadius = 70 + Math.random() * 80;       // 70~150px 밖에서 시작
    const angularDir  = Math.random() < 0.5 ? 1 : -1;  // 시계/반시계 무작위
    const palette = ['#7ec1ff', '#aef4ff', '#4de2ff', '#cfe6ff'];
    G.portal.particles.push({
      angle:      Math.random() * Math.PI * 2,
      radius:     startRadius,
      radius0:    startRadius,
      life:       1.0,
      lifeMax:    0.9 + Math.random() * 0.5,           // 0.9~1.4s
      size:       2 + Math.floor(Math.random() * 3),   // 2~4px
      angVel:     (5 + Math.random() * 4) * angularDir,
      pull:       100 + Math.random() * 90,            // 100~190 px/s 안쪽으로
      color:      palette[(Math.random() * palette.length) | 0],
    });
  }

  // ── Tick particles: 빨려 들어가는 나선 운동 ──
  const ps = G.portal.particles;
  for (const pt of ps) {
    pt.life   -= dt;
    pt.angle  += pt.angVel * dt;
    pt.radius -= pt.pull   * dt;
    if (pt.radius < 4) pt.life = 0;     // 중심 도달 → 사라짐
  }
  // GC dead particles
  for (let i = ps.length - 1; i >= 0; i--) {
    if (ps[i].life <= 0) ps.splice(i, 1);
  }
}

// =====================================================
//  Shop
// =====================================================
// ---- Safe Zone (Stage X-4) shop items — VOLATILE, reset every run ----
const SHOP_ITEMS = [
  {
    id: 'defrag', name: 'Defrag.exe', tag: 'CONSUMABLE',
    desc: '최대 HP의 50% 즉시 회복.',
    base: 3, inflate: false,                 // 8 → 3 (Defrag.exe)
    canBuy: () => G.player.hp < G.player.hpMax,
    maxed:  () => false,
    apply: () => {
      G.player.hp = Math.min(G.player.hpMax,
                              G.player.hp + Math.ceil(G.player.hpMax * 0.5));
      updateHpUI();
    },
  },
  {
    id: 'register_extension', name: 'Register Extension', tag: 'UTIL',
    desc: 'Queue 최대 길이 +1. (1회 한정 구매)',
    base: 10, inflate: true, maxCount: 1,    // 15 → 10 (Register Extension, 1회 한정)
    canBuy: () => (G.shop.counts.register_extension || 0) < 1,
    maxed:  () => (G.shop.counts.register_extension || 0) >= 1,
    apply: () => {
      G.player.stats.queueMax = Math.min(6, G.player.stats.queueMax + 1);
      refreshAmmoUI();
    },
  },
  {
    id: 'buffer_opt', name: 'Buffer Optimization', tag: 'UTIL',
    desc: 'Merge 처리 락 −0.1초. (최대 3회 구매)',
    base: 5, inflate: true, maxCount: 3,     // 10 → 5 (Buffer Optimization)
    canBuy: () => (G.shop.counts.buffer_opt || 0) < 3,
    maxed:  () => (G.shop.counts.buffer_opt || 0) >= 3,
    apply: () => {
      G.player.stats.mergeDelay = Math.max(0.10, G.player.stats.mergeDelay - 0.10);
    },
  },
  {
    id: 'multi_threading', name: 'Multi-Threading', tag: 'LEGENDARY',
    desc: '사격 시 50% 확률로 동일 색상의 총알 1발 추가 발사. (게임당 1회 한정)',
    base: 40, inflate: false, special: true,  // 45 → 40 (Multi-Threading, 게임당 1회)
    canBuy: () => !G.shop.multiThreadBought,
    maxed:  () => G.shop.multiThreadBought,
    apply: () => {
      G.player.stats.hasMultiThread = true;
      G.shop.multiThreadBought = true;
    },
  },
  {
    id: 'anti_virus_shield', name: 'Anti-Virus Shield', tag: 'CONSUMABLE',
    desc: '다음 피격 1회를 무효화하는 보호막 충전.',
    base: 5, inflate: true,                  // 10 → 5 (Anti-Virus Shield)
    canBuy: () => true,
    maxed:  () => false,
    apply: () => {
      G.player.shieldCount = (G.player.shieldCount || 0) + 1;
    },
  },
];

// ---- Physical lobby map: spawn / portal / 4 terminal zones ----
//  Coords are world-space. Tile size 16. Map covers full canvas (960x608).
const LOBBY_MAP = {
  spawn:  { x: W / 2, y: H - 80 },
  // top-of-map portal (exit zone) — F to reboot/restart
  portal: { x: W / 2 - 60, y: 40, w: 120, h: 64,
            label: 'REBOOT PORTAL', subLabel: 'F to restart Stage 1' },
  // 4 upgrade terminals laid out in a row across the middle
  terminals: [
    { id: 'bus_overclock',  x: 120, y: 280, w: 90, h: 90,
      accent: '#4de2ff', icon: '↯' },
    { id: 'hardware_accel', x: 290, y: 280, w: 90, h: 90,
      accent: '#aef4ff', icon: '⚡' },
    { id: 'core_upgrade',   x: 580, y: 280, w: 90, h: 90,
      accent: '#ff4dd2', icon: '◆' },
    { id: 'memory_bank',    x: 750, y: 280, w: 90, h: 90,
      accent: '#3ddc6b', icon: '▤' },
  ],
};

// ---- Lobby (game-over) permanent upgrades — consume coreBits, survive runs ----
const LOBBY_ITEMS = [
  {
    id: 'bus_overclock', name: 'Bus Overclock', tag: 'STAT',
    desc: '기본 이동 속도 +10% (영구, 제한 없음)',
    base: 5, growth: 10,                     // 10 → 5 (Bus Overclock, growth 유지)
    maxCount: Infinity,
  },
  {
    id: 'hardware_accel', name: 'Hardware Acceleration', tag: 'STAT',
    desc: '기본 사격 간격 −0.05초 (영구, 최대 5회)',
    base: 10, growth: 15, maxCount: 5,       // 15 → 10 (Hardware Acceleration, growth 유지)
  },
  {
    id: 'core_upgrade', name: 'Core Upgrade', tag: 'STAT',
    desc: '기본 대쉬 스택 +1 (영구, 최대 2회)',
    base: 30, growth: 35, maxCount: 2,        // 35 → 30 (Core Upgrade, growth 유지)
  },
  {
    id: 'memory_bank', name: 'Memory Bank Expansion', tag: 'STAT',
    desc: '기본 최대 체력 +20 (영구, 최대 3회)',
    base: 15, growth: 20, maxCount: 3,        // 20 → 15 (Memory Bank, growth 유지)
  },
];

function itemPrice(item) {
  if (DEBUG_CHEAP_PRICES) return 1;            // debug: flat 1-bit for all items
  if (!item.inflate) return item.base;
  const c = G.shop.counts[item.id] || 0;
  return Math.round(item.base * (1 + c * 0.5));
}

function tryBuy(item) {
  if (item.maxed()) return false;
  if (!item.canBuy()) return false;
  const price = itemPrice(item);
  if (G.sessionBits < price) return false;
  G.sessionBits -= price;
  item.apply();
  if (item.inflate) {
    G.shop.counts[item.id] = (G.shop.counts[item.id] || 0) + 1;
  }
  updateBitsUI();
  renderShop();
  return true;
}

function openShop() {
  G.state = 'shop';
  renderShop();
  showOverlay('shop');
}

function closeShopAndAdvance() {
  G.state = 'playing';
  hideAllOverlays();
  startStage(G.stage + 1);
}

function renderShop() {
  ui.shopBits.textContent = G.sessionBits;
  ui.shopGrid.innerHTML = '';
  SHOP_ITEMS.forEach((item, i) => {
    const price = itemPrice(item);
    const maxed = item.maxed();
    const canAfford = G.sessionBits >= price;
    const ok = !maxed && item.canBuy() && canAfford;

    const card = document.createElement('div');
    card.className = 'shop-card' + (maxed ? ' maxed' : '') +
                     (!ok && !maxed ? ' disabled' : '') +
                     (item.special ? ' special' : '');
    const tagClass = item.tag === 'CONSUMABLE' ? 'consumable'
                  : item.tag === 'SPECIAL' ? 'special' : '';
    const statText = item.inflate
      ? `Owned: ${G.shop.counts[item.id] || 0}`
      : (item.special ? (G.shop.multiThreadBought ? 'INSTALLED' : 'Available') : '');
    card.innerHTML = `
      <div class="card-title">
        <span class="card-name">${item.name}</span>
        <span class="card-tag ${tagClass}">${item.tag}</span>
      </div>
      <div class="card-desc">${item.desc}</div>
      <div class="card-stat">${statText}</div>
      <div class="card-foot">
        <span class="card-price"><span class="price-icon">◈</span>${maxed ? 'MAX' : price}</span>
        <span class="card-key">[${i + 1}]</span>
      </div>
    `;
    card.addEventListener('click', () => tryBuy(item));
    ui.shopGrid.appendChild(card);
  });
}

// hotkeys 1..N inside shop (only valid indices)
function shopHotkeys() {
  if (G.state !== 'shop') return;
  const codes = ['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6'];
  for (let i = 0; i < SHOP_ITEMS.length && i < codes.length; i++) {
    if (consumeJustPressed(codes[i])) {
      tryBuy(SHOP_ITEMS[i]);
    }
  }
}

ui.shopContinue.addEventListener('click', closeShopAndAdvance);

// =====================================================
//  Lobby (game-over terminal) — permanent upgrades
// =====================================================
function lobbyItemPrice(item) {
  if (DEBUG_CHEAP_PRICES) return 1;            // debug: flat 1-bit for all items
  const c = G.lobby.upgrades[item.id] || 0;
  return item.base + item.growth * c;
}

function tryBuyLobby(item) {
  const count = G.lobby.upgrades[item.id] || 0;
  if (count >= item.maxCount) return false;
  const price = lobbyItemPrice(item);
  if (G.coreBits < price) return false;
  G.coreBits -= price;
  G.lobby.upgrades[item.id] = count + 1;
  saveLobby();
  renderLobby();
  return true;
}

function renderLobby() {
  if (!ui.lobbyGrid) return;
  if (ui.lobbyCore) ui.lobbyCore.textContent = G.coreBits;
  ui.lobbyGrid.innerHTML = '';
  LOBBY_ITEMS.forEach((item) => {
    const count = G.lobby.upgrades[item.id] || 0;
    const maxed = count >= item.maxCount;
    const price = lobbyItemPrice(item);
    const canAfford = G.coreBits >= price;
    const ok = !maxed && canAfford;

    const card = document.createElement('div');
    card.className = 'lobby-card' + (maxed ? ' maxed' : '') + (!ok && !maxed ? ' disabled' : '');
    const maxLabel = item.maxCount === Infinity ? '∞' : item.maxCount;
    card.innerHTML = `
      <div class="card-title">
        <span class="card-name">${item.name}</span>
        <span class="card-stat">${count}/${maxLabel}</span>
      </div>
      <div class="card-desc">${item.desc}</div>
      <div class="card-foot">
        <span class="card-price">${maxed ? 'MAX' : '◆ ' + price}</span>
        <span class="card-count">${item.tag}</span>
      </div>
    `;
    card.addEventListener('click', () => tryBuyLobby(item));
    ui.lobbyGrid.appendChild(card);
  });
}

if (ui.rebootBtn) {
  ui.rebootBtn.addEventListener('click', () => {
    if (G.state === 'gameover' && G.deathTimer <= 0) newGame();
  });
}

// =====================================================
//  HUD helpers
// =====================================================
function updateHpUI() {
  const p = G.player;
  if (!p) return;
  const pct = Math.max(0, p.hp) / p.hpMax;

  // ── 솔리드 그라데이션 막대로 복귀 (segmented 제거) ──
  ui.hpFill.style.width = (pct * 100).toFixed(1) + '%';
  ui.hpFill.style.background = 'linear-gradient(to right, #ff5a4d, #ff8a4d)';
  ui.hpFill.style.borderRadius = '0';

  const hpBarEl = ui.hpFill.parentElement;
  if (hpBarEl) {
    hpBarEl.style.background   = 'rgba(255, 90, 77, 0.10)';
    hpBarEl.style.border       = '1px solid rgba(255, 90, 77, 0.5)';
    hpBarEl.style.borderRadius = '0';
    hpBarEl.style.boxShadow    = '0 0 8px rgba(255, 90, 77, 0.35)';
    hpBarEl.style.fontFamily   = "'Courier New', monospace";
  }
  ui.hpText.textContent = `${Math.max(0, p.hp)} / ${p.hpMax}`;
  ui.hpText.style.fontFamily = "'Courier New', monospace";

  // ── 데미지 받을 때 파편 파티클 ──
  //   이전 HP 보다 줄어든 경우, hp-fill 의 우측 끝 좌표(canvas 공간)에서
  //   픽셀 파편을 아래로 떨어트림.
  if (ui.hpFill._prevHp == null) ui.hpFill._prevHp = p.hp;
  if (p.hp < ui.hpFill._prevHp) {
    spawnHpHitParticles();
  }
  ui.hpFill._prevHp = p.hp;
}

// HP 바 우측 끝(현재 깎인 경계)에서 픽셀 파편 떨어뜨리기
function spawnHpHitParticles() {
  if (!G.hpHitParticles) G.hpHitParticles = [];
  const canvas = document.getElementById('game');
  if (!canvas) return;
  const cRect = canvas.getBoundingClientRect();
  const fRect = ui.hpFill.getBoundingClientRect();
  if (cRect.width === 0 || fRect.width === 0) return;

  // hp-fill 의 우측 끝 (브라우저 좌표) → 캔버스 내부 좌표로 변환
  const scaleX = canvas.width  / cRect.width;
  const scaleY = canvas.height / cRect.height;
  const px = (fRect.left + fRect.width - cRect.left) * scaleX;
  const py = (fRect.top  + fRect.height * 0.5 - cRect.top)  * scaleY;

  // 8~14 개의 픽셀 파편 — 약간 좌상향으로 튀고 중력 적용
  const count = 8 + Math.floor(Math.random() * 7);
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI * 0.5 + (Math.random() - 0.5) * 1.6;   // 위쪽 ±45°
    const speed = 80 + Math.random() * 140;
    G.hpHitParticles.push({
      x:     px + (Math.random() - 0.5) * 4,
      y:     py + (Math.random() - 0.5) * 2,
      vx:    Math.cos(angle) * speed,
      vy:    Math.sin(angle) * speed,
      size:  1 + Math.floor(Math.random() * 3),
      life:  0.7 + Math.random() * 0.4,
      lifeMax: 1.1,
      color: Math.random() < 0.6 ? '#ff5a4d' : '#ff8a4d',
    });
  }
}

// 매 프레임 tick + render — render() 의 dt 가 필요하므로 별도 함수 두 개로 분리
function updateHpHitParticles(dt) {
  if (!G.hpHitParticles || !G.hpHitParticles.length) return;
  const gravity = 480;
  for (const pt of G.hpHitParticles) {
    pt.vy += gravity * dt;
    pt.x  += pt.vx * dt;
    pt.y  += pt.vy * dt;
    pt.vx *= 0.96;
    pt.life -= dt;
  }
  // dead 제거
  for (let i = G.hpHitParticles.length - 1; i >= 0; i--) {
    if (G.hpHitParticles[i].life <= 0) G.hpHitParticles.splice(i, 1);
  }
}

function drawHpHitParticles() {
  if (!G.hpHitParticles || !G.hpHitParticles.length) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  for (const pt of G.hpHitParticles) {
    const a = Math.max(0, pt.life / pt.lifeMax);
    ctx.globalAlpha = a;
    ctx.shadowColor = pt.color;
    ctx.shadowBlur  = 6;
    ctx.fillStyle   = pt.color;
    ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.restore();
}
function updateBitsUI() {
  ui.bits.textContent = G.sessionBits;
  if (ui.shopBits) ui.shopBits.textContent = G.sessionBits;
  applyHardcoreHudStyle();
}
function updateKillUI() {
  const alive = G.enemies.filter(e => !e.isGlitch && !e.invincible).length;
  const glitches = G.enemies.filter(e => e.isGlitch).length;
  const wall = G.enemies.filter(e => e.invincible).length;
  let text = `남은 적: ${alive}`;
  if (glitches) text += `  · Glitch: ${glitches}`;
  if (wall)     text += `  · 🔥: ${wall}`;
  ui.kill.textContent = text;
  applyHardcoreHudStyle();
}

// ─────────────────────────────────────────────────────────────────────────
//  Hardcore HUD Style — 직각 + 모노스페이스 + 미세 글로우
//  반복 호출되어도 idempotent (한 번 적용된 inline style 은 그대로 유지)
// ─────────────────────────────────────────────────────────────────────────
function applyHardcoreHudStyle() {
  // 한 번만 적용하면 충분 — 플래그로 가드
  if (applyHardcoreHudStyle._done) return;
  const mono = "'Courier New', 'Consolas', monospace";

  // Stage indicator (LOOP X · STAGE X-Y)
  const stage = document.getElementById('stage-indicator');
  if (stage) {
    stage.style.fontFamily    = mono;
    stage.style.borderRadius  = '0';
    stage.style.border        = '1px solid rgba(255, 209, 102, 0.5)';
    stage.style.boxShadow     = '0 0 8px rgba(255, 209, 102, 0.25)';
    stage.style.letterSpacing = '0.5px';
  }

  // Data Bit counter
  const db = document.getElementById('data-bits');
  if (db) {
    db.style.fontFamily   = mono;
    db.style.borderRadius = '0';
    db.style.border       = '1px solid rgba(77, 226, 255, 0.5)';
    db.style.boxShadow    = '0 0 8px rgba(77, 226, 255, 0.3)';
  }

  // Kill counter (남은 적)
  const kc = document.getElementById('kill-counter');
  if (kc) {
    kc.style.fontFamily   = mono;
    kc.style.borderRadius = '0';
    kc.style.border       = '1px solid rgba(174, 244, 255, 0.35)';
    kc.style.boxShadow    = '0 0 6px rgba(174, 244, 255, 0.15)';
  }

  // HUD top container
  const hud = document.getElementById('hud-top');
  if (hud) {
    hud.style.fontFamily = mono;
  }

  applyHardcoreHudStyle._done = true;
}

// =====================================================
//  Render
// =====================================================
function render() {
  // === Lobby scene takes over the whole canvas ===
  if (G.state === 'lobby') { drawLobbyScene(); return; }

  let ox = 0, oy = 0;
  if (G.shake.mag > 0 && G.shake.t > 0) {
    const m = G.shake.mag * Math.min(1, G.shake.t / 0.25);
    ox = (Math.random() - 0.5) * m * 2;
    oy = (Math.random() - 0.5) * m * 2;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#14182a';
  ctx.fillRect(0, 0, W, H);
  drawGrid();

  // camera offset: which world-point sits at screen center
  const camOX = W / 2 - G.cam.x;
  const camOY = H / 2 - G.cam.y;

  ctx.save();
  ctx.translate(ox + camOX, oy + camOY);

  drawDrops();
  drawPortal();
  // Boss melee FX UNDER enemies/player (telegraph + web are floor decals)
  drawTelegraphs();
  drawDeadlockWalls();          // 1-5 보스 Deadlock 벽 (telegraphs 와 같은 floor 레이어)
  drawLeapWarnings();           // 1-5 보스 Context Switch Leap 타겟팅 경고 원
  drawWebs();
  drawGlitches();
  drawEnemies();
  drawBullets();
  drawRingFX();
  if (G.state === 'playing' || G.state === 'gameover' || G.state === 'boss_intro') drawPlayer();
  // Shockwave rings render ON TOP of player so they're clearly visible
  drawShockwaves();
  drawParticles();
  // ⚠ floaters 는 인게임 진행 중에만 그림. lobby/title/ending 에서는 잔여 텍스트 차단.
  if (G.state === 'playing' || G.state === 'boss_intro') drawFloaters();

  ctx.restore();

  // screen-space overlays (NOT affected by camera/shake)
  if (G.state === 'boss_intro') drawWarningText();

  // Color-recipe HUD above the queue panel (only during active play)
  if (G.state === 'playing' || G.state === 'boss_intro') drawColorRecipe();

  // Twin Boss HP bars (only while a duo encounter is active)
  if (G.duo && (G.state === 'playing' || G.state === 'boss_intro')) drawTwinHPBars();

  // Solo Boss HP bar (1-5 Spider / 2-5 Drone) — twin 인 경우 내부에서 스킵
  if (!G.duo && (G.state === 'playing' || G.state === 'boss_intro')) drawSoloBossHPBar();

  // WaveManager 타이머 — 일반 스테이지에서만 노출
  if (G.state === 'playing') drawWaveTimer();

  // 디버그 메시지 — 모든 state 에서 같은 위치에 노출
  drawDebugMessage();

  // 일시정지 메뉴 — 최상위 (모든 UI 위에 덮음)
  drawPauseMenu();

  // Final-boss ending overlay (fade-out + stats screen)
  if (G.state === 'ending_cleanse' || G.state === 'ending_terminal' ||
      G.state === 'ending_blast'   || G.state === 'ending_stats') drawEndingOverlay();

  // ── Title screen canvas polish (pulse / jitter / scanlines / vignette) ──
  // HTML overlay 는 잠시 가리고 canvas 가 시각을 전담. state 머신/DOM 구조는 그대로.
  if (G.state === 'title') drawTitleScreen();

  // HP 데미지 파편 — screen-space, 모든 게임 요소 위에 그림 (HUD 와 같은 레이어)
  drawHpHitParticles();

  if (G.state === 'playing') updateKillUI();
}

function drawGrid() {
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  const step = 32;
  for (let x = 0; x <= W; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y <= H; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Title Screen — canvas-side polish (효과만 추가, state machine/UI 구조 무변경)
//  - Color Queue: 고정 RGB split + 5% 확률 violent jitter
//  - Desktop Panic + 컨트롤 안내 + [Space] 시작 (pulse)
//  - CRT scanlines + radial vignette
// ─────────────────────────────────────────────────────────────────────────
function drawTitleScreen() {
  // ── HTML 타이틀 오버레이는 잠깐 가림 (DOM 자체는 보존) ──
  if (ui && ui.overlays && ui.overlays.title) {
    ui.overlays.title.classList.add('hidden');
  }
  // ── 인게임 HUD (상단 스테이지/HP/Data Bit, 우측하단 Queue / Hold) 도 가림 ──
  // ⚠ 데이터/상태값은 그대로. style.display 토글만 사용 → newGame() 에서 다시 표시.
  if (typeof setGameHudVisible === 'function') setGameHudVisible(false);

  const t = Date.now() / 1000;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // ── (1) Color Queue — RGB split + 5% 확률 violent jitter ──
  const titleX = W / 2;
  const titleY = H * 0.30;

  // 기본 chromatic aberration 오프셋 (잔잔히 흐르도록 sine 사용)
  let caX = 4 + Math.sin(t * 1.3) * 1.2;
  let caY = Math.cos(t * 1.7) * 0.8;
  let jx = 0, jy = 0;
  let blurExtra = 0;

  // 5% 확률 → violent jitter (큰 오프셋 튐)
  if (Math.random() < 0.05) {
    jx       = (Math.random() - 0.5) * 16;
    jy       = (Math.random() - 0.5) * 10;
    caX      = 6 + Math.random() * 10;
    caY      = (Math.random() - 0.5) * 8;
    blurExtra = 6;
  }

  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.font         = 'bold 72px monospace';

  // 빨강 채널 (오프셋 +caX, +caY)
  ctx.globalAlpha  = 0.85;
  ctx.fillStyle    = '#ff3060';
  ctx.shadowColor  = '#ff3060';
  ctx.shadowBlur   = 18 + blurExtra;
  ctx.fillText('Color Queue', titleX + caX + jx, titleY + caY + jy);

  // 시안 채널 (오프셋 -caX, -caY)
  ctx.fillStyle    = '#4de2ff';
  ctx.shadowColor  = '#4de2ff';
  ctx.shadowBlur   = 18 + blurExtra;
  ctx.fillText('Color Queue', titleX - caX + jx, titleY - caY + jy);

  // 흰색 중심 — 가장 밝게
  ctx.globalAlpha  = 1;
  ctx.fillStyle    = '#ffffff';
  ctx.shadowColor  = '#ffffff';
  ctx.shadowBlur   = 8 + blurExtra;
  ctx.fillText('Color Queue', titleX + jx, titleY + jy);

  ctx.shadowBlur = 0;

  // ── (2) Desktop Panic 서브타이틀 ──
  ctx.font         = 'bold 26px monospace';
  ctx.fillStyle    = '#ff4dd2';
  ctx.shadowColor  = '#ff4dd2';
  ctx.shadowBlur   = 12;
  ctx.fillText('Desktop Panic', W / 2, titleY + 64);
  ctx.shadowBlur   = 0;

  // ── (3) Body — 컨트롤 안내 ──
  ctx.font      = '14px monospace';
  ctx.fillStyle = '#aab2c5';
  const bodyLines = [
    'WASD 이동  ·  좌클릭 사격 (이동 중 사격 가능)',
    'Shift 대쉬 (3스택, i-frame)  ·  Space merge  ·  R pop  ·  E hold',
    '적이 깨지면 Glitch 로 남는다. 직접 밟아 free() 하라.',
    '5스테이지마다 보스  ·  매 4스테이지는 Safe Zone (Shop)',
  ];
  let by = H * 0.56;
  for (const line of bodyLines) {
    ctx.fillText(line, W / 2, by);
    by += 24;
  }

  // ── (4) [Space] 시작 — pulse (alpha 0.3 ↔ 1.0, sine 기반) ──
  // Date.now() / 1000 * 3 → 약 2.1초 주기로 부드럽게 깜빡
  const pulseAlpha = 0.3 + 0.35 * (Math.sin(t * 3) + 1);   // 0.30 ~ 1.00
  ctx.globalAlpha  = pulseAlpha;
  ctx.font         = 'bold 22px monospace';
  ctx.fillStyle    = '#4de2ff';
  ctx.shadowColor  = '#4de2ff';
  ctx.shadowBlur   = 18;
  ctx.fillText('[Space] 시작', W / 2, H * 0.82);
  ctx.shadowBlur   = 0;
  ctx.globalAlpha  = 1;

  // ── (5) CRT Scanlines — 3px 간격, 1px 두께 반투명 검정 ──
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  for (let y = 0; y < H; y += 3) {
    ctx.fillRect(0, y, W, 1);
  }

  // ── (6) Radial vignette — 중앙 투명 → 가장자리 검정 ──
  const vignette = ctx.createRadialGradient(
    W / 2, H / 2, 0,
    W / 2, H / 2, Math.hypot(W, H) * 0.55
  );
  vignette.addColorStop(0,    'rgba(0, 0, 0, 0.00)');
  vignette.addColorStop(0.55, 'rgba(0, 0, 0, 0.00)');
  vignette.addColorStop(1,    'rgba(0, 0, 0, 0.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  ctx.restore();
}

// ── Data Bits — Pulsing Dual Core ──
//   중심: 3px 풀필 + 강한 네온 글로우 (안정적인 데이터 노드)
//   외곽: 1.5px stroke 링이 주기적으로 4→8 팽창 + alpha 페이드 (불안정한 에너지 파동)
//   상태 격리: save/restore + shadowBlur/globalAlpha 정리로 외부 렌더 오염 방지
function drawDrops() {
  const tNow = Date.now() / 1000;
  for (const d of G.drops) {
    const hex  = COL[d.color].hex;
    const glow = COL[d.color].glow;

    // 부유 — y bob (drop별 위상차로 단조롭지 않게)
    const yo = Math.sin(tNow * 2.2 + d.bob) * 2.5;

    ctx.save();
    ctx.translate(d.x, d.y + yo);

    // ──────── (1) Inner Core (3px 풀필 + 강한 네온 글로우) ────────
    ctx.shadowColor = glow;
    ctx.shadowBlur  = 18;
    ctx.fillStyle   = hex;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fill();

    // 코어 안쪽 더 밝은 필라멘트 1.4px
    ctx.shadowBlur  = 8;
    ctx.fillStyle   = glow;
    ctx.beginPath();
    ctx.arc(0, 0, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // ──────── (2) Pulsing Outer Ring (반지름 4→8, alpha 1→0 부드러운 페이드) ────────
    const period = 1.4;                                // 1.4초 주기 (심장 박동)
    const phase  = (tNow + d.bob) % period;
    const k      = phase / period;                     // 0 → 1
    const ringR  = 4 + k * 4;                          // 4 → 8 팽창
    const ringA  = (1 - k) * 0.85;                     // 0.85 → 0 페이드

    ctx.globalAlpha = ringA;
    ctx.strokeStyle = hex;
    ctx.shadowColor = glow;
    ctx.shadowBlur  = 10;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, ringR, 0, Math.PI * 2);
    ctx.stroke();

    // ──────── 정리: 다른 객체 오염 방지 ────────
    ctx.shadowBlur  = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Glitch Vortex Portal
//  - 끊어진 호(arc) 4개가 각자 다른 반지름/속도/방향으로 회전
//  - RGB 채널 분리(Chromatic Aberration) — 빨강/파랑 호를 미세 오프셋해 겹쳐 그림
//  - 매 프레임 jitter (각도/굵기 흔들림) + 무작위 violent glitch
//  - 픽셀 파티클이 나선 궤도로 중앙 블랙홀에 빨려 들어감
//  - 플레이어가 가까울수록 회전·jitter·파티클 스폰 강도 ↑ (G.portal.prox)
// ─────────────────────────────────────────────────────────────────────────
const PORTAL_ARCS = [
  // radius mul, thickness, angular speed (rad/s), gap (rad), arc count, base color
  { rMul: 1.00, thick: 4.0, speed:  1.2, gap: 0.65, count: 2, color: '#7ec1ff' },
  { rMul: 1.45, thick: 3.0, speed: -0.85, gap: 0.45, count: 3, color: '#4de2ff' },
  { rMul: 1.85, thick: 2.0, speed:  2.1, gap: 0.55, count: 2, color: '#aef4ff' },
  { rMul: 0.65, thick: 5.0, speed: -1.7, gap: 0.85, count: 1, color: '#7ec1ff' },
];

function drawPortal() {
  if (!G.portal) return;
  const { x, y, r, t, particles } = G.portal;
  const prox = G.portal.prox || 0;

  // 강도 곱셈자 — 플레이어가 가까울수록 모든 효과가 증폭
  const speedMul  = 1 + prox * 1.6;     // 회전: 1.0 ~ 2.6x
  const jitterMul = 0.4 + prox * 2.4;   // jitter: 0.4 ~ 2.8x
  const caBase    = 1.4 + jitterMul * 1.4;  // RGB split offset

  ctx.save();
  ctx.translate(x, y);

  // ── (1) Spiraling pixel particles — 호 뒤에 깔리도록 먼저 ──
  if (particles && particles.length) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const pt of particles) {
      const px = Math.cos(pt.angle) * pt.radius;
      const py = Math.sin(pt.angle) * pt.radius;
      const sz = pt.size;
      const alpha = Math.min(1, pt.life / pt.lifeMax) *
                    Math.min(1, pt.radius / pt.radius0);  // 중심 다가올수록 살짝 사라짐
      ctx.globalAlpha = alpha * 0.9;
      ctx.shadowColor = pt.color;
      ctx.shadowBlur  = 8;
      ctx.fillStyle   = pt.color;
      ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur  = 0;
    ctx.restore();
  }

  // ── (2) Central dark core (blackhole) ──
  // 호 뒤 / 파티클 앞에 깔아서 빨려 들어가는 느낌
  const coreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.05);
  coreGrad.addColorStop(0,    'rgba(0, 0, 0, 1.0)');
  coreGrad.addColorStop(0.55, 'rgba(8, 14, 32, 0.85)');
  coreGrad.addColorStop(1,    'rgba(40, 80, 140, 0.0)');
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.05, 0, Math.PI * 2);
  ctx.fill();

  // 미세 회오리 (코어 안쪽 흐름) — 'lighter' 로 살짝 빛나게
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.18 + prox * 0.18;
  ctx.fillStyle   = '#1a3a66';
  ctx.beginPath();
  ctx.arc(0, 0, r * (0.55 + Math.sin(t * 5) * 0.03), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ── (3) Arc layers + Chromatic Aberration (RGB split) ──
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';   // additive — 색이 겹치면 더 밝아짐

  for (const arc of PORTAL_ARCS) {
    const radius   = r * arc.rMul;
    const rot      = t * arc.speed * speedMul;
    const sweep    = (Math.PI * 2 / arc.count) - arc.gap;
    const angJit   = (Math.random() - 0.5) * 0.08 * jitterMul;
    const thickJit = Math.max(0.5, arc.thick + (Math.random() - 0.5) * 1.2 * jitterMul);

    // CA offset 방향도 매 프레임 미세 흔들기
    const caAng = t * 6 + Math.random() * 0.6;
    const caX   = Math.cos(caAng) * caBase;
    const caY   = Math.sin(caAng) * caBase;

    for (let i = 0; i < arc.count; i++) {
      const start = rot + (i / arc.count) * Math.PI * 2 + angJit;
      const end   = start + sweep;

      // ── Red channel (오프셋 +caX, +caY) ──
      ctx.strokeStyle = 'rgba(255, 48, 96, 0.75)';
      ctx.shadowColor = '#ff3060';
      ctx.shadowBlur  = 6;
      ctx.lineWidth   = thickJit;
      ctx.beginPath();
      ctx.arc(caX, caY, radius, start, end);
      ctx.stroke();

      // ── Blue channel (오프셋 −caX, −caY) ──
      ctx.strokeStyle = 'rgba(64, 96, 255, 0.75)';
      ctx.shadowColor = '#4060ff';
      ctx.shadowBlur  = 6;
      ctx.beginPath();
      ctx.arc(-caX, -caY, radius, start, end);
      ctx.stroke();

      // ── Main (cyan) channel — 가장 밝게 ──
      ctx.strokeStyle = arc.color;
      ctx.shadowColor = arc.color;
      ctx.shadowBlur  = 14;
      ctx.lineWidth   = thickJit + 0.6;
      ctx.beginPath();
      ctx.arc(0, 0, radius, start, end);
      ctx.stroke();
    }
  }

  // ── (4) Violent jitter shard — 매 프레임 일정 확률로 자글거리는 마젠타 호 추가 ──
  if (Math.random() < 0.18 + prox * 0.32) {
    const xOff = (Math.random() - 0.5) * 5 * jitterMul;
    const yOff = (Math.random() - 0.5) * 5 * jitterMul;
    ctx.translate(xOff, yOff);
    const sa = t * 4.5 + Math.random() * Math.PI * 2;
    const sweep = 0.25 + Math.random() * 0.55;
    const sr = r * (0.95 + Math.random() * 0.9);
    ctx.strokeStyle = 'rgba(255, 77, 210, 0.85)';
    ctx.shadowColor = '#ff4dd2';
    ctx.shadowBlur  = 12;
    ctx.lineWidth   = 1.2 + Math.random() * 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, sr, sa, sa + sweep);
    ctx.stroke();
    ctx.translate(-xOff, -yOff);
  }

  ctx.restore();    // restore from globalCompositeOperation = 'lighter'

  // ── (5) Outer halo pulse (gentle breathing glow) ──
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const haloAlpha = 0.10 + 0.06 * Math.sin(t * 4) + prox * 0.12;
  ctx.globalAlpha = haloAlpha;
  ctx.fillStyle   = '#4de2ff';
  ctx.beginPath();
  ctx.arc(0, 0, r * 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();    // outer save (translate)
}

// ─────────────────────────────────────────────────────────────────────────
//  Glitch Quarantine Renderer
//   - 와이어프레임 격리: 원본 크기 그대로의 시안 외곽선 + 크로스헤어 + 안쪽 동심원
//   - 홀로그램 스캔라인 + 불규칙 알파 깜빡임
//   - 마지막 1.5초 (reassemble) → 빨강 강한 펄스 + 파티클 안쪽 lerp
//   - purged: 와이어프레임 찢어지듯 회전하며 흰색 페이드아웃
// ─────────────────────────────────────────────────────────────────────────
function drawGlitches() {
  const now = performance.now();
  for (const e of G.enemies) {
    if (!e.isGlitch) continue;
    const c     = COL[e.glitchColor] || COL.red;
    const r     = e.r;
    const phase = e.glitchPhase || 'burst';
    const lifeFrac = Math.max(0, e.glitchTimer / 3);

    ctx.save();
    ctx.translate(e.x, e.y);

    // ──────── (1) Particles — 호 뒤에 깔리도록 먼저 ────────
    if (e.glitchParticles && e.glitchParticles.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const pt of e.glitchParticles) {
        const a = (pt.alpha != null ? pt.alpha : 1);
        ctx.globalAlpha = a * (0.7 + Math.random() * 0.3);
        ctx.shadowColor = pt.color;
        ctx.shadowBlur  = 6;
        ctx.fillStyle   = pt.color;
        ctx.fillRect(pt.ox - pt.size / 2, pt.oy - pt.size / 2, pt.size, pt.size);
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur  = 0;
      ctx.restore();
    }

    if (phase === 'purged') {
      // ──────── (P) PURGED: 와이어프레임이 찢어지듯 회전하며 페이드 ────────
      const t        = e.purgeT || 0;
      const fadeA    = Math.max(0, 1 - t / 0.5);
      const expand   = 1 + t * 0.8;                 // 살짝 부풀며
      const rot      = t * 8;                       // 빠르게 회전
      ctx.save();
      ctx.rotate(rot);
      ctx.globalAlpha = fadeA * 0.85;
      ctx.strokeStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur  = 14;
      ctx.lineWidth   = 1.5;
      // 3개의 끊어진 호로 깨진 와이어프레임 표현
      for (let i = 0; i < 3; i++) {
        const start = (i / 3) * Math.PI * 2 + Math.random() * 0.15;
        const sweep = 0.6 + Math.random() * 0.4;
        ctx.beginPath();
        ctx.arc(0, 0, r * expand, start, start + sweep);
        ctx.stroke();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.shadowBlur  = 0;
      ctx.restore();
      continue;
    }

    // ──────── (2) Wireframe skeleton (격리된 홀로그램) ────────
    // 색 결정: reassemble 페이즈는 빨강 펄스, 그 외엔 시안 톤
    const isReassemble = (phase === 'reassemble');
    let pulseT = 0;
    if (isReassemble) {
      const k = Math.min(1, e.glitchPhaseT / 1.5);   // 0→1 over 1.5s
      pulseT = 0.4 + 0.6 * Math.sin(now * 0.025) * (0.5 + k * 0.5);
    }
    const wireColor   = isReassemble ? '#ff3060' : (c.hex || '#aef4ff');
    const wireShadow  = isReassemble ? '#ff5577' : '#4de2ff';

    // 홀로그램 깜빡임 — 알파 sine + 무작위 dropout
    let wfAlpha = 0.55 + 0.30 * Math.sin(now * 0.011);
    if (Math.random() < 0.08) wfAlpha *= 0.35;
    if (isReassemble) wfAlpha = Math.max(wfAlpha, 0.55 + 0.4 * pulseT);

    ctx.save();
    ctx.globalAlpha = wfAlpha;
    ctx.strokeStyle = wireColor;
    ctx.shadowColor = wireShadow;
    ctx.shadowBlur  = isReassemble ? (10 + 14 * pulseT) : 8;
    ctx.lineWidth   = isReassemble ? (1.6 + 1.4 * pulseT) : 1.4;

    // 메인 외곽 원
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    // 안쪽 동심원 (target reticle 느낌)
    ctx.globalAlpha = wfAlpha * 0.55;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();

    // 크로스헤어 (4방향 짧은 선)
    ctx.beginPath();
    ctx.moveTo(-r,        0);        ctx.lineTo(-r * 0.7, 0);
    ctx.moveTo( r * 0.7,  0);        ctx.lineTo( r,       0);
    ctx.moveTo( 0, -r);              ctx.lineTo( 0, -r * 0.7);
    ctx.moveTo( 0,  r * 0.7);        ctx.lineTo( 0,  r);
    ctx.stroke();

    // 모서리 브래킷 (UI selection bracket 느낌, 보스에만)
    if (e.isBoss) {
      const br = r * 1.08;
      const bl = r * 0.20;
      ctx.beginPath();
      // 4 코너 ⌐ ¬ ⌙ ⌐ 모양
      ctx.moveTo(-br + bl, -br); ctx.lineTo(-br, -br); ctx.lineTo(-br, -br + bl);
      ctx.moveTo( br - bl, -br); ctx.lineTo( br, -br); ctx.lineTo( br, -br + bl);
      ctx.moveTo(-br + bl,  br); ctx.lineTo(-br,  br); ctx.lineTo(-br,  br - bl);
      ctx.moveTo( br - bl,  br); ctx.lineTo( br,  br); ctx.lineTo( br,  br - bl);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();

    // ──────── (3) Horizontal scanline noise (hologram) ────────
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const seed = e.glitchSeed || 0;
    const scanCount = e.isBoss ? 6 : 4;
    for (let i = 0; i < scanCount; i++) {
      // 가로 띠 위치는 sine + seed 로 위/아래로 천천히 이동
      const yy = Math.sin(now * 0.006 + i * 1.3 + seed * 0.01) * r * 0.95;
      // 일부 프레임만 그려서 깜빡임
      if (Math.random() < 0.55) continue;
      ctx.globalAlpha = 0.22 + Math.random() * 0.20;
      ctx.fillStyle   = wireColor;
      ctx.fillRect(-r, yy, r * 2, 1 + Math.random() * 1.5);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // ──────── (4) Timer ring (외곽) ────────
    ctx.save();
    ctx.strokeStyle = isReassemble ? '#ff5577' : '#ffffff';
    ctx.shadowColor = isReassemble ? '#ff3060' : '#ffffff';
    ctx.shadowBlur  = isReassemble ? 8 : 4;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r + 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * lifeFrac);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();

    // ──────── (5) Reassemble 경고: 가운데 "!" 텍스트 펄스 (보스만) ────────
    if (isReassemble && e.isBoss && pulseT > 0.5) {
      ctx.save();
      ctx.fillStyle   = '#ff3060';
      ctx.shadowColor = '#ff5577';
      ctx.shadowBlur  = 12;
      ctx.globalAlpha = (pulseT - 0.5) * 2;
      ctx.font        = 'bold 28px monospace';
      ctx.textAlign   = 'center';
      ctx.textBaseline= 'middle';
      ctx.fillText('!', 0, 0);
      ctx.restore();
    }

    ctx.restore();
  }
}

function drawEnemies() {
  // === Melee windup telegraph (red laser) — drawn first so enemy sprite is on top ===
  for (const e of G.enemies) {
    if (e.isGlitch) continue;
    if (e.type !== 'melee' || e.state !== 'windup') continue;
    const ax = e.aimX, ay = e.aimY;
    if (ax == null) continue;
    const dx = ax - e.x, dy = ay - e.y;
    const len = Math.hypot(dx, dy) || 1;
    // extend the laser well past the player to show the dash trajectory
    const tx = e.x + (dx / len) * (len + 360);
    const ty = e.y + (dy / len) * (len + 360);
    const total = (e.enrageTime > 0 ? 0.35 : 0.5);
    const t = 1 - Math.max(0, Math.min(1, e.stateT / total)); // 0→1 progress
    // pulsing alpha for tension; ramps higher near fire moment
    const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 60);
    ctx.save();
    ctx.globalAlpha = (0.35 + 0.5 * t) * pulse;
    ctx.strokeStyle = '#ff3030';
    ctx.shadowColor = '#ff6c6c';
    ctx.shadowBlur = 12;
    ctx.lineWidth = 2 + t * 3;
    ctx.beginPath();
    ctx.moveTo(e.x, e.y);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    // small target reticle on player position
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ax, ay, 10 + 4 * Math.sin(performance.now() / 80), 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  for (const e of G.enemies) {
    if (e.isGlitch) continue;

    // === Web Drop pattern (melee boss only) — special rendering ===
    // Airborne: boss image is hidden, only the growing target shadow is drawn.
    if (e.bossKind === 'melee' && e.state === 'web_airborne') {
      drawWebDropShadow(e);
      continue;   // skip ALL body/shield/hp rendering for this enemy
    }
    // Ascent: draw the silk thread before the body so the boss sits on top.
    if (e.bossKind === 'melee' && e.state === 'web_ascent') {
      drawWebDropSilk(e);
    }
    // Fast-dash windup: pulsing red aim line from boss → locked target.
    if (e.bossKind === 'melee' && e.state === 'fast_dash_windup'
        && e.fastTargetX != null && e.fastTargetY != null) {
      ctx.save();
      const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 50);
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = '#ff3030';
      ctx.shadowColor = '#ff6c6c';
      ctx.shadowBlur = 12;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(e.fastTargetX, e.fastTargetY);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(e.fastTargetX, e.fastTargetY,
              10 + 4 * Math.sin(performance.now() / 80), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Ranged Boss — WHIP charge telegraph: fan/arc indicator showing sweep range.
    if (e.bossKind === 'ranged' && e.state === 'whip_charge' && e.whipCenter != null) {
      ctx.save();
      ctx.translate(e.x, e.y);
      const sweepRange = Math.PI * 2 / 3;
      const startA = e.whipCenter - sweepRange / 2;
      const endA   = e.whipCenter + sweepRange / 2;
      const reach  = 600;
      const pulse  = 0.45 + 0.30 * Math.sin(performance.now() / 80);
      // Two boundary lines + filled wedge
      ctx.globalAlpha = 0.18 * pulse;
      ctx.fillStyle = '#ff3030';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, reach, startA, endA);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.85 * pulse;
      ctx.strokeStyle = '#ff6c6c';
      ctx.shadowColor = '#ff3030';
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(Math.cos(startA) * reach, Math.sin(startA) * reach);
      ctx.moveTo(0, 0); ctx.lineTo(Math.cos(endA)   * reach, Math.sin(endA)   * reach);
      ctx.stroke();
      ctx.restore();
    }

    // Ranged Boss — BURST aim: red laser line from boss → locked target.
    if (e.bossKind === 'ranged' && e.state === 'burst_aim'
        && e.burstTargetX != null && e.burstTargetY != null) {
      ctx.save();
      const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 50);
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = '#ff3030';
      ctx.shadowColor = '#ff6c6c';
      ctx.shadowBlur = 12;
      ctx.lineWidth = 3;
      // extend past the target so the player sees the full kill line
      const dx = e.burstTargetX - e.x, dy = e.burstTargetY - e.y;
      const len = Math.hypot(dx, dy) || 1;
      const ex = e.x + (dx / len) * (len + 250);
      const ey = e.y + (dy / len) * (len + 250);
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(e.burstTargetX, e.burstTargetY,
              10 + 4 * Math.sin(performance.now() / 80), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // ── Twin Boss: restore-cast beam (drawn before bodies so beam sits under sprites) ──
    if (e.isTwinBoss && e.state === 'restore_cast') {
      drawTwinRestoreBeam(e);
    }
    // ── Twin Boss: combo-dash magenta trail ──
    if (e.isTwinBoss && e.state === 'combo_dash') {
      drawTwinComboTrail(e);
    }

    ctx.save();
    // Visual Y-offset only applies during ascent. Slam restores it to 0 so the
    // body renders at the logical (teleported) position.
    const visYOffset = (e.bossKind === 'melee' && e.state === 'web_ascent')
                       ? (e.airOffsetY || 0) : 0;
    ctx.translate(e.x, e.y - visYOffset);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, e.r * 0.85, e.r * 0.9, e.r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    const enraged = e.enrageTime > 0;

    // firewall mook: invincible cube
    if (e.invincible && e.type === 'firewall_mook') {
      ctx.fillStyle = '#ff5a4d';
      ctx.shadowColor = '#ffae42';
      ctx.shadowBlur = 14;
      ctx.fillRect(-e.r, -e.r, e.r * 2, e.r * 2);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.strokeRect(-e.r, -e.r, e.r * 2, e.r * 2);
      // small lock icon
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('🔒', 0, 4);
      ctx.restore();
      continue;
    }

    let body = e.color;
    if (e.hitFlash > 0) body = '#ffffff';
    else if (enraged || (e.isBoss && e.phase2)) body = mixHex(e.color, '#ff3030', 0.45);

    // ----- Sprite-based render for melee / ranged (including their bosses) -----
    const useSpider = (e.type === 'melee'  || e.bossKind === 'melee')  && ASSETS.spider;
    const useDrone  = (e.type === 'ranged' || e.bossKind === 'ranged') && ASSETS.drone;
    if (useSpider || useDrone) {
      const cfg = useSpider ? SPR_SPIDER : SPR_DRONE;
      const sprImg = useSpider ? ASSETS.spider : ASSETS.drone;
      const animKey = (e.anim && e.anim.key) || 'walk';
      const anim = cfg.anims[animKey] || cfg.anims.walk;
      const at = (e.anim && e.anim.t) || 0;
      const frameIdx = anim.loop
        ? Math.floor(at * anim.fps) % anim.count
        : Math.min(Math.floor(at * anim.fps), anim.count - 1);

      // --- Source rect: exactly ONE frame from the sheet ---
      const sx = frameIdx * cfg.fw;
      const sy = anim.row * cfg.fh;
      const sw = cfg.fw;
      const sh = cfg.fh;

      // --- Destination size: width = 4 × collision radius, aspect preserved ---
      // Regular spider/drone r=14/16 → 56/64 px.
      // Boss melee/ranged r=50 → 200 px (renders huge, matching the boss hitbox).
      const dw = e.r * 4;
      const dh = dw * (cfg.fh / cfg.fw);   // preserve aspect (Spider 1:1, Drone 1:1)

      // Skip render if size went corrupt (NaN, 0, negative) — never silently fail
      // to invisible; this guard makes such bugs obvious as a missing sprite.
      const sizeOK = isFinite(dw) && isFinite(dh) && dw > 0 && dh > 0;

      // Flip horizontally when enemy is to the RIGHT of the player
      const flip = e.x > G.player.x;

      // Hard isolation: ctx.scale(-1,1) here MUST NOT leak to other entities
      // (especially the player rendered afterwards). save/restore guarantees it.
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      // ⚠ Force globalAlpha = 1 BEFORE any conditional alpha changes.
      // This prevents the boss from going fully transparent if alpha was somehow
      // polluted earlier in the frame (e.g., from a phase-transition burst FX
      // sharing canvas state, or any future code that forgets to reset).
      ctx.globalAlpha = 1;
      if (flip) ctx.scale(-1, 1);
      // hit-flash white tint
      if (e.hitFlash > 0) {
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 12;
      }
      // fade out near end of death anim (only legal alpha modulation)
      if (e.isDying) {
        const da = cfg.anims.death;
        const total = da.count / da.fps;
        const remain = Math.max(0, e.deathT || 0);
        ctx.globalAlpha = Math.max(0.25, remain / total);
      }
      if (sizeOK) {
        ctx.drawImage(sprImg,
                      sx, sy, sw, sh,
                      -dw / 2, -dh / 2, dw, dh);
      }
      ctx.restore();
    }
    // ----- Procedural fallback (boss or when sprite asset not loaded) -----
    // (Tanker branch removed — tanker enemy type no longer exists.)
    else {
      ctx.fillStyle = body;
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = 2;
      if (e.isBoss) {
        ctx.beginPath(); ctx.arc(0, 0, e.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#000';
        ctx.fillRect(-e.r * 0.4, -e.r * 0.2, 8, 8);
        ctx.fillRect( e.r * 0.3, -e.r * 0.2, 8, 8);
      } else if (e.type === 'ranged') {
        ctx.beginPath(); ctx.arc(0, 0, e.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#222';
        ctx.fillRect(-e.r * 0.5, -e.r * 0.2, 5, 5);
        ctx.fillRect( e.r * 0.3, -e.r * 0.2, 5, 5);
      } else {
        ctx.beginPath(); ctx.arc(0, 0, e.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.moveTo(-e.r * 0.5, -e.r * 0.6);
        ctx.lineTo(-e.r * 0.1, -e.r * 1.3);
        ctx.lineTo(-e.r * 0.05, -e.r * 0.5); ctx.closePath(); ctx.fill();
        ctx.beginPath();
        ctx.moveTo( e.r * 0.5, -e.r * 0.6);
        ctx.lineTo( e.r * 0.1, -e.r * 1.3);
        ctx.lineTo( e.r * 0.05, -e.r * 0.5); ctx.closePath(); ctx.fill();
      }
    }

    // ── shield — SF Hexagon Hologram Dome ──
    //   (1) Circle clip → 이후 모든 그리기는 원 안에서만
    //   (2) Scrolling hex grid (육각형 타일이 위→아래로 천천히 흐름)
    //   (3) Fresnel radial gradient (중심 투명 → 가장자리 강하게 빛남)
    //   (4) clip 해제 후 outer rim 실선 (얇은 밝은 외곽선)
    if (e.shield) {
      const sc = COL[e.shield];
      const tNow = Date.now();

      // hex → rgba 헬퍼
      const hexStr = sc.hex.replace('#', '');
      const cR = parseInt(hexStr.substr(0, 2), 16);
      const cG = parseInt(hexStr.substr(2, 2), 16);
      const cB = parseInt(hexStr.substr(4, 2), 16);
      const rgba = (a) => `rgba(${cR}, ${cG}, ${cB}, ${a})`;

      // 반경 — 기존 공식 유지
      const isSpriteKind = (e.type === 'melee'  || e.bossKind === 'melee' ||
                            e.type === 'ranged' || e.bossKind === 'ranged');
      const spriteFactor = e.isBoss ? 3.0 : 4.0;
      const visualW = isSpriteKind ? e.r * spriteFactor : e.r * 2;
      const padding = e.isBoss ? 8 : 6;
      const shieldRadius = visualW / 2 + padding;

      // 중심 보정 (Spider body offset)
      const isMeleeKind = (e.type === 'melee' || e.bossKind === 'melee');
      const bodyCenterX = isMeleeKind ?  e.r * 0.10 : 0;
      const bodyCenterY = isMeleeKind ?  e.r * 0.20 : 0;

      // ──────── 외곽 wrap: body 중심으로 이동 ────────
      ctx.save();
      ctx.translate(bodyCenterX, bodyCenterY);

      // ──────── (1) Circle Clip ────────
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, shieldRadius, 0, Math.PI * 2);
      ctx.clip();

      // 안쪽 배경 — 매우 옅은 색 채움 (안개 느낌)
      ctx.fillStyle = rgba(0.06);
      ctx.fillRect(-shieldRadius, -shieldRadius, shieldRadius * 2, shieldRadius * 2);

      // ──────── (2) Scrolling Hex Grid ────────
      // Point-up hexagon, 한 변 = s
      const s = 12;
      const dxHex = Math.sqrt(3) * s;             // 가로 간격
      const dyHex = 1.5 * s;                      // 세로 간격
      const scrollY = ((tNow * 0.022) % dyHex);   // 천천히 위→아래

      ctx.strokeStyle = rgba(0.4);
      ctx.shadowColor = sc.glow;
      ctx.shadowBlur  = 0;                        // grid 자체는 글로우 없음 (선명한 라인)
      ctx.lineWidth   = 1;

      const R = shieldRadius;
      const rows = Math.ceil((R * 2) / dyHex) + 2;
      const cols = Math.ceil((R * 2) / dxHex) + 2;

      for (let row = -1; row < rows; row++) {
        const yy = -R + row * dyHex + scrollY;
        const xOffset = (row % 2 === 0 ? 0 : dxHex * 0.5);
        for (let col = -1; col < cols; col++) {
          const xx = -R + col * dxHex + xOffset;
          // 각 육각형 stroke
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = Math.PI / 6 + (Math.PI / 3) * i;   // point-up
            const px = xx + Math.cos(a) * s;
            const py = yy + Math.sin(a) * s;
            if (i === 0) ctx.moveTo(px, py);
            else         ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }

      // ──────── (3) Fresnel Gradient Overlay ────────
      // 중심 투명 → 가장자리 alpha 0.85
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, shieldRadius);
      grad.addColorStop(0,    rgba(0));
      grad.addColorStop(0.5,  rgba(0));
      grad.addColorStop(0.8,  rgba(0.20));
      grad.addColorStop(1,    rgba(0.85));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, shieldRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();                              // ← (1) clip 해제

      // ──────── (4) Outer Rim — clip 밖, 밝은 실선 외곽선 ────────
      ctx.save();
      ctx.strokeStyle = sc.hex;
      ctx.shadowColor = sc.glow;
      ctx.shadowBlur  = 14;                       // 외곽 글로우
      ctx.lineWidth   = 1.5;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(0, 0, shieldRadius, 0, Math.PI * 2);
      ctx.stroke();
      // 아주 얇은 내부 보조 라인 (-1px) 으로 두께감
      ctx.shadowBlur  = 6;
      ctx.lineWidth   = 0.8;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.arc(0, 0, shieldRadius - 1.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur  = 0;
      ctx.globalAlpha = 1;
      ctx.restore();

      ctx.restore();                              // ← 외곽 wrap (body 중심 보정) 해제
    }

    // hp bar
    if (e.hp < e.hpMax) {
      const w = e.r * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(-w / 2, -e.r - 12, w, 4);
      ctx.fillStyle = '#ff5a4d';
      ctx.fillRect(-w / 2, -e.r - 12, w * (e.hp / e.hpMax), 4);
    }

    // enrage mark
    if (enraged) {
      ctx.fillStyle = '#ff3030';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('💢', 0, -e.r - 18);
    }
    // slow mark (cyan effect)
    if (e.slowTime > 0 && !enraged) {
      ctx.fillStyle = '#4de2ff';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('❄', 0, -e.r - 18);
    }
    // stun mark (boss)
    if (e.isBoss && e.stunT > 0) {
      ctx.fillStyle = '#ffd166';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('💤', 0, -e.r - 18);
    }

    ctx.restore();
  }
}

// roundRect REMOVED — only the (now-removed) tanker procedural body used it.

function mixHex(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bl = Math.round(ca.b + (cb.b - ca.b) * t);
  return `rgb(${r},${g},${bl})`;
}

function hexToRgb(h) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
  if (!m) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

function drawBullets() {
  for (const b of G.bullets) {
    const c = COL[b.color] || { hex: '#ffffff', glow: '#ffffff' };
    ctx.save();
    if (b.pierce) {
      // elongated ellipse along velocity for magenta pierce
      const ang = Math.atan2(b.vy, b.vx);
      ctx.translate(b.x, b.y);
      ctx.rotate(ang);
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 14;
      ctx.fillStyle = c.hex;
      ctx.beginPath();
      ctx.ellipse(0, 0, b.r * 2.4, b.r * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      // bright core
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(0, 0, b.r * 1.1, b.r * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 10;
      ctx.fillStyle = c.hex;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawPlayer() {
  const p = G.player;

  // animKey/animT/dirRow are managed by updatePlayer / updateLobby — read only here.
  // dirRow is recomputed every update tick from mouse aim, so it's always fresh
  // and changes INSTANTLY when the cursor crosses a quadrant boundary.
  const wantKey = p.animKey || 'run';
  const dirRow  = p.dirRow ?? 0;

  // Sprite sheet config + image
  const sprCfg = SPR_ASTRO[wantKey] || SPR_ASTRO.run;
  const sprImg = ASSETS[wantKey === 'run' ? 'astroRun' :
                        wantKey === 'dash' ? 'astroDash' : 'astroHit'];

  // Animation frame index
  let frameIdx;
  if (sprCfg.loop) {
    frameIdx = Math.floor(p.animT * sprCfg.fps) % sprCfg.cols;
  } else {
    frameIdx = Math.min(Math.floor(p.animT * sprCfg.fps), sprCfg.cols - 1);
  }

  // Aspect-preserving destination size. Anchor on height = 72,
  // then derive width so the 140×100 Astro frame keeps its 1.4:1 ratio.
  const dh = 72;
  const dw = dh * (sprCfg.fw / sprCfg.fh);   // e.g. 72 × 1.4 = 100.8

  // ----- Afterimages (drawn before main sprite for dash trail) -----
  if (p.afterimages && p.afterimages.length && sprImg) {
    for (const a of p.afterimages) {
      const lifeT = Math.max(0, a.t / a.maxT);
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.globalAlpha = 0.3 * lifeT;
      ctx.imageSmoothingEnabled = false;
      const aFrame = a.frameIdx ?? frameIdx;
      const aDir   = a.dirRow   ?? dirRow;
      // ⚠ Never use ctx.scale on the player — direction is row-driven only.
      // The enclosing ctx.save()/ctx.restore() here isolates this draw from
      // any prior enemy-render scale leak.
      ctx.drawImage(sprImg,
                    aFrame * sprCfg.fw, aDir * sprCfg.fh,
                    sprCfg.fw, sprCfg.fh,
                    -dw / 2, -dh / 2 - 6, dw, dh);
      ctx.restore();
    }
  } else if (p.afterimages && p.afterimages.length) {
    // procedural fallback trail
    for (const a of p.afterimages) {
      const lifeT = Math.max(0, a.t / a.maxT);
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.globalAlpha = 0.3 * lifeT;
      ctx.fillStyle = '#aef4ff';
      ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  ctx.save();
  ctx.translate(p.x, p.y);

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(0, p.r * 0.8, p.r, p.r * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();

  // Main sprite (or procedural fallback)
  if (sprImg) {
    // Hard-isolate this drawImage with its own save/restore so any prior
    // ctx.scale(-1,1) from enemy rendering CANNOT leak in. The player itself
    // NEVER uses scale flipping — direction is purely a function of the row
    // index (4 separate rows = 4 directions, no mirroring).
    ctx.save();
    const blinking = p.invuln > 0 && Math.floor(performance.now() / 80) % 2 === 0;
    ctx.globalAlpha = blinking ? 0.55 : 1;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sprImg,
                  frameIdx * sprCfg.fw, dirRow * sprCfg.fh,
                  sprCfg.fw, sprCfg.fh,
                  -dw / 2, -dh / 2 - 6, dw, dh);
    ctx.restore();
  } else {
    ctx.fillStyle = '#ffd166';
    ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill();
  }

  // subtle hitbox ring (debug-readable but not loud)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.stroke();

  // Dash i-frame visual: cyan glow ring while dashing
  if (p.isDashing) {
    ctx.strokeStyle = '#4de2ff';
    ctx.shadowColor = '#aef4ff';
    ctx.shadowBlur = 16;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, p.r + 6, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Anti-Virus Shield: pulsing hex-like aura while charges remain
  if (p.shieldCount && p.shieldCount > 0) {
    const pulse = 0.55 + 0.25 * Math.sin(performance.now() / 200);
    const baseR = p.r + 10;
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = '#aef4ff';
    ctx.shadowColor = '#4de2ff';
    ctx.shadowBlur = 14;
    ctx.lineWidth = 2;
    // outer rotating ring
    ctx.beginPath();
    const rot = performance.now() / 600;
    for (let i = 0; i < 6; i++) {
      const a = rot + i * Math.PI / 3;
      const x = Math.cos(a) * baseR;
      const y = Math.sin(a) * baseR;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    // charge count badge
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#aef4ff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`x${p.shieldCount}`, baseR + 10, -baseR + 4);
    ctx.restore();
  }

  // Processing lock indicator (hourglass + spinner)
  if (p.processing > 0) {
    const total = p.stats.mergeDelay;
    const remain = p.processing;
    const pct = 1 - remain / total;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(0, 0, p.r + 12, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#4de2ff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, p.r + 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('⏳', 0, -p.r - 16);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('MERGE', 0, p.r + 26);
  }
  // (idle "charging" ring removed — fire is now manual via mouse click)

  // ----- Dash stack indicator (above head) -----
  {
    const max = p.maxDashes;
    const have = p.dashes;
    const iconW = 9, gap = 4;
    const totalW = max * iconW + (max - 1) * gap;
    const baseX = -totalW / 2;
    const y = -p.r - 32;
    for (let i = 0; i < max; i++) {
      const filled = i < have;
      const isNextRefill = (i === have && have < max);
      const pct = isNextRefill
        ? 1 - (p.dashRechargeT / p.dashRechargeDur)
        : (filled ? 1 : 0);
      const cx = baseX + i * (iconW + gap) + iconW / 2;
      // ▼ 이전: 번개 뒤에 어두운 사각형 배경(rgba(0,0,0,0.55) 9×16) 을 그렸음.
      //   → 시각적으로 어색해서 제거. 대신 모든 상태(채움/충전중/빈)에
      //   shadowBlur 글로우를 줘 어두운 배경 위에서도 번개가 잘 보이게 유지.
      ctx.save();
      ctx.translate(cx, y);
      ctx.beginPath();
      ctx.moveTo(-3, -7);
      ctx.lineTo(2, -1);
      ctx.lineTo(-1, -1);
      ctx.lineTo(3, 7);
      ctx.lineTo(-2, 1);
      ctx.lineTo(1, 1);
      ctx.closePath();
      if (filled) {
        // 채워진 스택 — 진한 시안 + 강한 글로우
        ctx.shadowColor = '#aef4ff';
        ctx.shadowBlur  = 10;
        ctx.fillStyle   = '#4de2ff';
        ctx.fill();
        ctx.shadowBlur  = 0;
      } else if (isNextRefill) {
        // 충전 중 슬롯 — 외곽선 + 아래에서 위로 차오르는 필
        ctx.shadowColor = '#4de2ff';
        ctx.shadowBlur  = 6;
        ctx.strokeStyle = '#4de2ff';
        ctx.lineWidth   = 1;
        ctx.stroke();
        ctx.shadowBlur  = 0;
        ctx.save();
        ctx.beginPath();
        ctx.rect(-iconW/2, 7 - 14 * pct, iconW, 14 * pct);
        ctx.clip();
        ctx.beginPath();
        ctx.moveTo(-3, -7); ctx.lineTo(2, -1); ctx.lineTo(-1, -1);
        ctx.lineTo(3, 7); ctx.lineTo(-2, 1); ctx.lineTo(1, 1); ctx.closePath();
        ctx.shadowColor = '#aef4ff';
        ctx.shadowBlur  = 8;
        ctx.fillStyle   = 'rgba(77, 226, 255, 0.55)';
        ctx.fill();
        ctx.shadowBlur  = 0;
        ctx.restore();
      } else {
        // 빈 슬롯 — 옅은 외곽선 + 미세 글로우
        ctx.shadowColor = '#4de2ff';
        ctx.shadowBlur  = 4;
        ctx.strokeStyle = 'rgba(77, 226, 255, 0.45)';
        ctx.lineWidth   = 1;
        ctx.stroke();
        ctx.shadowBlur  = 0;
      }
      ctx.restore();
    }
  }

  ctx.restore();
}

function drawParticles() {
  for (const p of G.particles) {
    const a = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = a;
    ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
  }
  ctx.globalAlpha = 1;
}

function drawRingFX() {
  for (const r of ringFX) {
    const a = Math.max(0, r.life / r.maxLife);
    const radius = r.maxR * (1 - r.life / r.maxLife);
    const c = COL[r.color] || { hex: '#ffffff', glow: '#ffffff' };
    ctx.save();
    ctx.globalAlpha = a * 0.7;
    ctx.strokeStyle = c.hex;
    ctx.shadowColor = c.glow;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// =====================================================
//  Lobby Scene Rendering (canvas-based, no DOM overlay)
// =====================================================
function drawLobbyScene() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // dark vignette background with violet hue (lobby ambience)
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0c0f20');
  grad.addColorStop(1, '#1a0e22');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // ── Parallax grid — 플레이어 위치 따라 미세하게 시프트 ──
  drawLobbyParallaxGrid();

  // soft scanline overlay (computer aesthetic)
  ctx.fillStyle = 'rgba(77, 226, 255, 0.04)';
  for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);

  // top-of-map header
  drawLobbyHeader();

  // portal at top
  drawLobbyPortal(LOBBY_MAP.portal);

  // 4 terminals — 부팅 시퀀스 (i × 0.18s) 적용
  const terminals = LOBBY_MAP.terminals;
  // y 좌표 오름차순 정렬 (위 → 아래 순차) — 원본 배열은 건드리지 않음
  const ordered = terminals.slice().sort((a, b) => (a.y - b.y));
  for (let i = 0; i < ordered.length; i++) {
    drawLobbyTerminal(ordered[i], i);
  }

  // 시스템 대시보드 — 우상단 코너에 system status
  drawLobbyDashboard();

  // particles + floaters
  drawParticles();
  drawPlayer();
  drawFloaters();

  // contextual tooltip near player when overlapping a zone
  if (G.lobbyOverlap) drawLobbyTooltip();

  // footer hint
  drawLobbyFooter();

  // 디버그 메시지 — 로비 씬에도 동일하게
  drawDebugMessage();
  // 일시정지 메뉴 — 로비에서도 ESC 가능
  drawPauseMenu();
}

// Parallax grid — 플레이어 위치를 기준으로 격자가 미세하게 반대 방향 시프트
function drawLobbyParallaxGrid() {
  const p = G.player;
  // 플레이어가 화면 중심에서 얼마나 떨어졌는지 → -1 ~ +1 정규화 후 px 단위로
  const offX = p ? -(p.x - W / 2) * 0.04 : 0;     // 4% 따라 움직임
  const offY = p ? -(p.y - H / 2) * 0.04 : 0;

  ctx.save();
  ctx.translate(offX, offY);
  ctx.strokeStyle = 'rgba(77, 226, 255, 0.05)';
  ctx.lineWidth = 1;
  const step = 32;
  // 격자가 시프트되어도 화면을 덮도록 여유 -step ~ W+step
  for (let x = -step; x <= W + step; x += step) {
    ctx.beginPath(); ctx.moveTo(x, -step); ctx.lineTo(x, H + step); ctx.stroke();
  }
  for (let y = -step; y <= H + step; y += step) {
    ctx.beginPath(); ctx.moveTo(-step, y); ctx.lineTo(W + step, y); ctx.stroke();
  }
  ctx.restore();
}

// System Dashboard — 우상단 코너에 SYSTEM STATUS 텍스트 + 가끔 글리치
function drawLobbyDashboard() {
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 11px monospace';

  const t = G.lobbyT || 0;
  // 매 4초마다 0.2초씩 글리치 (jitter + 색 변화)
  const glitchActive = (t % 4) < 0.2;
  const jx = glitchActive ? (Math.random() - 0.5) * 4 : 0;
  const jy = glitchActive ? (Math.random() - 0.5) * 3 : 0;

  // 라인 1: SYSTEM STATUS
  const statusColor = glitchActive ? '#ff4d6d' : '#3ddc6b';
  ctx.fillStyle    = statusColor;
  ctx.shadowColor  = statusColor;
  ctx.shadowBlur   = 6;
  ctx.fillText('SYSTEM STATUS: STABLE', W - 14 + jx, 70 + jy);

  // 라인 2: GLITCH INDEX (랜덤 노이즈 값)
  const glitchIdx = Math.floor((Math.sin(t * 0.6) * 1.5 + 1.5));  // 0~3
  ctx.fillStyle    = '#aef4ff';
  ctx.shadowColor  = '#4de2ff';
  ctx.shadowBlur   = 4;
  ctx.fillText(`GLITCH INDEX: ${glitchIdx}`, W - 14 + jx * 0.5, 86 + jy * 0.5);

  // 라인 3: UPTIME
  const sec = Math.floor(t);
  const mm = Math.floor(sec / 60).toString().padStart(2, '0');
  const ss = (sec % 60).toString().padStart(2, '0');
  ctx.fillStyle    = '#aab2c5';
  ctx.shadowColor  = '#7ec1ff';
  ctx.shadowBlur   = 3;
  ctx.fillText(`UPTIME: ${mm}:${ss}`, W - 14, 102);

  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawLobbyHeader() {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ff4d6d';
  ctx.shadowColor = '#ff4d6d';
  ctx.shadowBlur = 14;
  ctx.font = 'bold 22px monospace';
  ctx.fillText('// SYSTEM REBOOT TERMINAL', W / 2, 28);
  ctx.shadowBlur = 0;

  // last run summary + Core balance
  ctx.font = 'bold 12px monospace';
  ctx.fillStyle = '#ffd166';
  const last = G.lastRun;
  const summary = last
    ? `LAST RUN: ${last.stageLabel}  ·  +${last.converted} CORE EARNED`
    : `WELCOME, OPERATOR`;
  ctx.fillText(summary, W / 2, 50);

  ctx.fillStyle = '#aef4ff';
  ctx.font = 'bold 13px monospace';
  ctx.fillText(`◆  CORE BIT: ${G.coreBits}`, W / 2, H - 28);
  ctx.restore();
}

function drawLobbyFooter() {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(170, 178, 197, 0.7)';
  ctx.font = 'bold 10px monospace';
  ctx.fillText('WASD 이동 · F 상호작용 (터미널 강화 / 포탈 재시작)', W / 2, H - 12);
  ctx.restore();
}

function drawLobbyPortal(z) {
  const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
  const tNow = performance.now() / 1000;
  const t = tNow * 1.25;                          // 기존 swirling 호환

  // ── 플레이어 근접 감지 → 색 lerp (분홍 → 시안 네온) ──
  const isNear = !!(G.lobbyOverlap && G.lobbyOverlap.kind === 'portal');
  // 부드러운 lerp 진행도 (0 → 1)
  G._portalNearK = G._portalNearK || 0;
  const target = isNear ? 1 : 0;
  G._portalNearK += (target - G._portalNearK) * 0.08;    // 80ms 응답
  const k = G._portalNearK;

  // 색 보간: 분홍 #ff4d6d → 시안 #4de2ff
  const r = Math.round(0xff + (0x4d - 0xff) * k);
  const g = Math.round(0x4d + (0xe2 - 0x4d) * k);
  const b = Math.round(0x6d + (0xff - 0x6d) * k);
  const mainColor = `rgb(${r}, ${g}, ${b})`;
  const glowColor = `rgba(${r}, ${g}, ${b}, 0.8)`;

  // ── 1초 주기 미세 글리치 (10% 구간만) ──
  const glitchActive = (tNow % 1) < 0.1;
  const jx = glitchActive ? (Math.random() - 0.5) * 3 : 0;
  const jy = glitchActive ? (Math.random() - 0.5) * 2 : 0;

  ctx.save();
  ctx.translate(jx, jy);

  // ── 옥타곤 반지름 (z.w / z.h 작은 쪽 기준) ──
  const R = Math.min(z.w, z.h) / 2 - 2;

  // ── (1) 베이스 어두운 옥타곤 fill ──
  drawOctagonPath(cx, cy, R);
  ctx.fillStyle = 'rgba(20, 24, 42, 0.92)';
  ctx.fill();

  // ── (2) Spinning Glow — 회전하는 밝은 호 (에너지 응축) ──
  // 옥타곤 외곽 위에 한 변씩 강조하면서 빙글빙글 도는 효과
  const spinAng = t * 1.5;                       // 회전 속도
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(spinAng);
  ctx.strokeStyle = mainColor;
  ctx.shadowColor = glowColor;
  ctx.shadowBlur  = 18 + (isNear ? 8 : 0);
  ctx.lineWidth   = 3;
  ctx.globalAlpha = 0.85;
  // 옥타곤의 한 변 + 다음 변까지 강하게 그림 (나머지는 약하게)
  ctx.beginPath();
  for (let i = 0; i < 2; i++) {
    const a1 = (Math.PI / 4) * i + Math.PI / 8;
    const a2 = (Math.PI / 4) * (i + 1) + Math.PI / 8;
    const x1 = Math.cos(a1) * R, y1 = Math.sin(a1) * R;
    const x2 = Math.cos(a2) * R, y2 = Math.sin(a2) * R;
    if (i === 0) ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
  ctx.restore();

  // ── (3) 정적 옥타곤 외곽선 (베이스 ring) ──
  drawOctagonPath(cx, cy, R);
  ctx.strokeStyle = mainColor;
  ctx.shadowColor = glowColor;
  ctx.shadowBlur  = 10;
  ctx.lineWidth   = 2;
  ctx.globalAlpha = 0.7 + 0.3 * k;                // 가까울수록 밝아짐
  ctx.stroke();
  ctx.shadowBlur  = 0;
  ctx.globalAlpha = 1;

  // ── (4) 안쪽 작은 옥타곤 (코어 표시) ──
  drawOctagonPath(cx, cy, R * 0.45);
  ctx.strokeStyle = mainColor;
  ctx.shadowColor = glowColor;
  ctx.shadowBlur  = 8;
  ctx.lineWidth   = 1;
  ctx.globalAlpha = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(tNow * 3));   // 호흡
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.shadowBlur  = 0;

  // ── (5) Spiral 흡입 파티클 — 16개가 매번 외곽 → 중앙으로 빨려 들어감 ──
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 16; i++) {
    const cycle = 0.85;                          // 한 사이클 0.85초
    const phase = i / 16;
    const ct = ((tNow + phase * cycle) % cycle) / cycle;   // 0 → 1
    const startR = R + 18 + (i % 3) * 8;         // 외곽 시작 위치 R+18~R+34
    const pr = startR * (1 - ct);                // 안쪽으로 빨림
    const ang = i * 0.785 + tNow * (1.2 + (i % 4) * 0.15) + ct * 0.6;  // 약간 나선
    const px = cx + Math.cos(ang) * pr;
    const py = cy + Math.sin(ang) * pr;
    const alpha = (1 - ct) * 0.9;
    const sz = 1 + (i % 3);                      // 1~3px 픽셀
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = mainColor;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur  = 6;
    ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur  = 0;
  ctx.restore();

  // ── (6) 라벨 — 색도 같이 변함 ──
  ctx.textAlign = 'center';
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = mainColor;
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = isNear ? 10 : 4;
  ctx.fillText(isNear ? '▲ READY TO REBOOT ▲' : '▲ REBOOT PORTAL ▲', cx, z.y + z.h + 14);
  ctx.shadowBlur = 0;

  ctx.restore();   // translate(jx, jy)
}

// 옥타곤 path helper — 22.5° 회전하여 flat-top 형태
function drawOctagonPath(cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i + Math.PI / 8;   // π/8 = 22.5° offset
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawLobbyTerminal(z, orderIdx = 0) {
  const item = LOBBY_ITEMS.find(it => it.id === z.id);
  if (!item) return;
  const count = G.lobby.upgrades[z.id] || 0;
  const maxed = count >= item.maxCount;
  const price = lobbyItemPrice(item);
  const canAfford = G.coreBits >= price;
  const purchasable = !maxed && canAfford;
  const t = performance.now() / 600;

  // ── 부팅 시퀀스 — orderIdx × 0.25s 마다 위에서 아래로 reveal ──
  const lobbyT  = G.lobbyT || 0;
  const reveal  = Math.max(0, Math.min(1, (lobbyT - orderIdx * 0.25) / 0.35));
  if (reveal <= 0) return;                       // 아직 부팅 안 됨 → 그리지 않음

  // ── 플레이어 근접 hover 상태 ──
  const p = G.player;
  const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
  const hoverD2 = p ? ((p.x - cx) ** 2 + (p.y - cy) ** 2) : Infinity;
  const isHover = hoverD2 < 90 * 90;             // 90px 안쪽

  ctx.save();
  ctx.globalAlpha = reveal;

  // ── pedestal 배경 + 회로 hex 패턴 (alpha 0.20) ──
  ctx.fillStyle = 'rgba(20, 24, 42, 0.92)';
  ctx.fillRect(z.x, z.y, z.w, z.h);

  // 회로 hex 패턴 (clip 후 hex grid 그림)
  ctx.save();
  ctx.beginPath();
  ctx.rect(z.x, z.y, z.w, z.h);
  ctx.clip();
  const hexSize = 9;
  const hexDx   = Math.sqrt(3) * hexSize;
  const hexDy   = 1.5 * hexSize;
  ctx.strokeStyle = z.accent;
  ctx.globalAlpha = reveal * 0.20;               // 20% 투명 회로 패턴
  ctx.lineWidth   = 1;
  for (let row = 0; row * hexDy < z.h + hexDy; row++) {
    const yy = z.y + row * hexDy + (lobbyT * 4) % hexDy;   // 천천히 위→아래 흐름
    const xOff = (row % 2) * (hexDx * 0.5);
    for (let col = -1; col * hexDx < z.w + hexDx; col++) {
      const xx = z.x + col * hexDx + xOff;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (Math.PI / 3) * i;
        const px = xx + Math.cos(a) * hexSize;
        const py = yy + Math.sin(a) * hexSize;
        if (i === 0) ctx.moveTo(px, py);
        else         ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();

  // ── glow border (구매 가능 시만 펄스 강조) ──
  ctx.globalAlpha = reveal * (0.55 + 0.25 * Math.sin(t + (z.x * 0.01)));
  ctx.strokeStyle = maxed ? '#4de2ff' : z.accent;
  ctx.shadowColor = maxed ? '#4de2ff' : z.accent;
  ctx.shadowBlur  = purchasable ? 14 : (maxed ? 8 : 6);
  ctx.lineWidth   = 2;
  ctx.strokeRect(z.x + 0.5, z.y + 0.5, z.w - 1, z.h - 1);
  ctx.shadowBlur  = 0;

  // ── 아이콘 + 상태별 색/노이즈 ──
  ctx.globalAlpha = reveal;
  ctx.textAlign   = 'center';
  ctx.font        = 'bold 36px monospace';
  if (purchasable) {
    // 구매 가능 — 미세 펄스 글로우
    const glowPulse = 0.7 + 0.3 * Math.sin(performance.now() * 0.005 + (z.x * 0.01));
    ctx.fillStyle   = z.accent;
    ctx.shadowColor = z.accent;
    ctx.shadowBlur  = 10 * glowPulse;
    ctx.fillText(z.icon, cx, cy + 4);
    ctx.shadowBlur  = 0;
  } else {
    // 구매 불가 / maxed — 회색 + 글리치 노이즈
    ctx.fillStyle = maxed ? '#6f7a8e' : '#5a626e';
    ctx.fillText(z.icon, cx, cy + 4);
    // 글리치 노이즈: 작은 픽셀 사각형 무작위 위치
    if (!maxed) {
      ctx.fillStyle = z.accent;
      ctx.globalAlpha = reveal * 0.35;
      for (let i = 0; i < 6; i++) {
        if (Math.random() < 0.5) continue;
        const nx = z.x + 6 + Math.random() * (z.w - 12);
        const ny = z.y + 6 + Math.random() * (z.h - 12);
        ctx.fillRect(nx, ny, 2 + Math.random() * 2, 1 + Math.random() * 2);
      }
      ctx.globalAlpha = reveal;
    }
  }

  // ── 스캔라인 (2초 주기) — 위→아래 한 번 통과 ──
  const scanCycle = 2.0;
  const scanT = (lobbyT % scanCycle) / scanCycle;     // 0 → 1
  if (scanT < 0.5) {                                  // cycle 의 앞쪽 절반만 보임
    const scanY = z.y + scanT * 2 * z.h;
    ctx.save();
    ctx.beginPath();
    ctx.rect(z.x, z.y, z.w, z.h);
    ctx.clip();
    const grad = ctx.createLinearGradient(0, scanY - 8, 0, scanY + 8);
    grad.addColorStop(0,   'rgba(174, 244, 255, 0.0)');
    grad.addColorStop(0.5, 'rgba(174, 244, 255, 0.45)');
    grad.addColorStop(1,   'rgba(174, 244, 255, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(z.x, scanY - 8, z.w, 16);
    ctx.restore();
  }

  // ── 이름 / 카운트 / 가격 ──
  ctx.font      = 'bold 11px monospace';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(item.name.toUpperCase(), cx, z.y + z.h + 14);

  ctx.font = 'bold 10px monospace';
  const maxLabel = item.maxCount === Infinity ? '∞' : item.maxCount;
  ctx.fillStyle = maxed ? '#4de2ff' : (canAfford ? '#ffd166' : '#ff6c6c');
  const right = maxed ? 'MAXED' : `◆${price}`;
  ctx.fillText(`${count}/${maxLabel}  ·  ${right}`, cx, z.y + z.h + 28);

  // ── Hover frame — 플레이어 근접 시 데이터 프레임 + 작은 사양 ──
  if (isHover && reveal >= 0.9) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#aef4ff';
    ctx.shadowColor = '#4de2ff';
    ctx.shadowBlur  = 10;
    ctx.lineWidth   = 1.2;
    // 외곽 프레임 (테두리 바깥 +6px)
    const fx = z.x - 6, fy = z.y - 6, fw = z.w + 12, fh = z.h + 12;
    // 4 모서리 corner brackets 만 그림 (data-frame look)
    const cl = 10;
    ctx.beginPath();
    ctx.moveTo(fx,       fy + cl); ctx.lineTo(fx,       fy);       ctx.lineTo(fx + cl, fy);
    ctx.moveTo(fx + fw - cl, fy);       ctx.lineTo(fx + fw, fy);       ctx.lineTo(fx + fw, fy + cl);
    ctx.moveTo(fx,       fy + fh - cl); ctx.lineTo(fx,       fy + fh); ctx.lineTo(fx + cl, fy + fh);
    ctx.moveTo(fx + fw - cl, fy + fh); ctx.lineTo(fx + fw, fy + fh); ctx.lineTo(fx + fw, fy + fh - cl);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // 작은 spec 안내 (level + 다음 가격)
    ctx.font      = 'bold 9px monospace';
    ctx.fillStyle = '#aef4ff';
    ctx.textAlign = 'left';
    ctx.fillText(`LV ${count}/${maxLabel}`, fx + 2, fy - 3);
    ctx.textAlign = 'right';
    ctx.fillText(maxed ? 'MAX' : `${price} cBit`, fx + fw - 2, fy - 3);
  }

  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.restore();
}

// Compute detail strings for each terminal: long-form summary + numeric preview
function getTerminalDetail(item, count) {
  if (item.id === 'bus_overclock') {
    const cur = BASE_MOVE_SPEED * (1 + count * 0.10);
    const nxt = BASE_MOVE_SPEED * (1 + (count + 1) * 0.10);
    return {
      summary: '기본 이동 속도를 영구히 10% 올립니다.',
      hint:    '회피 거리와 맵 장악력이 직접 늘어납니다. 무한 강화 가능.',
      current: `${cur.toFixed(0)} px/s`,
      after:   `${nxt.toFixed(0)} px/s  (+10%)`,
    };
  }
  if (item.id === 'hardware_accel') {
    const cur = Math.max(0.10, BASE_FIRE_CD - count * 0.05);
    const nxt = Math.max(0.10, BASE_FIRE_CD - (count + 1) * 0.05);
    return {
      summary: '기본 사격 간격을 영구히 0.05초 단축합니다.',
      hint:    '초당 발사 수가 늘어 DPS가 직접 상승합니다. 만렙 0.10초.',
      current: `${cur.toFixed(2)}초 간격  (${(1 / cur).toFixed(1)} 발/초)`,
      after:   `${nxt.toFixed(2)}초 간격  (${(1 / nxt).toFixed(1)} 발/초)`,
    };
  }
  if (item.id === 'core_upgrade') {
    return {
      summary: '대쉬 최대 스택을 영구히 1 증가시킵니다.',
      hint:    '연속 회피 가능 횟수가 늘어납니다. 가장 비싸지만 가장 강한 안전장치.',
      current: `${BASE_DASHES + count} 스택`,
      after:   `${BASE_DASHES + count + 1} 스택`,
    };
  }
  if (item.id === 'memory_bank') {
    return {
      summary: '최대 체력을 영구히 20 증가시킵니다.',
      hint:    '보스 접촉 데미지 22 기준, 한 번 더 맞고 버틸 수 있게 됩니다.',
      current: `${BASE_HP + count * HP_PER_BANK} HP`,
      after:   `${BASE_HP + (count + 1) * HP_PER_BANK} HP`,
    };
  }
  return { summary: item.desc, hint: '', current: '-', after: '-' };
}

function drawLobbyTooltip() {
  const o = G.lobbyOverlap;
  const p = G.player;
  if (o.kind === 'terminal' && o.item) {
    drawLobbyTerminalTooltip(o.item, p);
  } else if (o.kind === 'portal') {
    drawLobbyPortalTooltip(p);
  }
}

function drawLobbyTerminalTooltip(item, p) {
  const count = G.lobby.upgrades[item.id] || 0;
  const maxed = count >= item.maxCount;
  const price = lobbyItemPrice(item);
  const canAfford = G.coreBits >= price;
  const accent = maxed ? '#4de2ff' : (canAfford ? '#ffd166' : '#ff6c6c');
  const detail = getTerminalDetail(item, count);
  const maxLabel = item.maxCount === Infinity ? '∞' : item.maxCount;

  // Panel sizing & placement: prefer above player, fall back to below if cramped
  const w = 520;
  const h = 170;
  let left = p.x - w / 2;
  let top  = p.y - p.r - 18 - h;
  if (top < 12) top = p.y + p.r + 18;            // not enough room above → put below
  left = Math.max(12, Math.min(W - 12 - w, left));
  top  = Math.max(12, Math.min(H - 12 - h, top));

  ctx.save();

  // panel background
  ctx.fillStyle = 'rgba(8, 10, 20, 0.92)';
  ctx.fillRect(left, top, w, h);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 14;
  ctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);
  ctx.shadowBlur = 0;

  // top header strip
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.12;
  ctx.fillRect(left, top, w, 38);
  ctx.globalAlpha = 1;

  // — title (item name) —
  ctx.textAlign = 'left';
  ctx.fillStyle = accent;
  ctx.font = 'bold 20px monospace';
  ctx.fillText(item.name.toUpperCase(), left + 18, top + 26);

  // — level badge (top-right) —
  ctx.textAlign = 'right';
  ctx.fillStyle = '#aab2c5';
  ctx.font = 'bold 12px monospace';
  ctx.fillText(`Lv. ${count} / ${maxLabel}`, left + w - 18, top + 26);

  // — long summary —
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 13px monospace';
  ctx.fillText(detail.summary, left + 18, top + 60);

  // — flavor hint —
  ctx.fillStyle = '#aab2c5';
  ctx.font = '12px monospace';
  ctx.fillText(detail.hint, left + 18, top + 80);

  // — preview block: current → after —
  if (!maxed) {
    ctx.fillStyle = '#88c4d8';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('현재 :', left + 18, top + 108);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(detail.current, left + 80, top + 108);

    ctx.fillStyle = '#88c4d8';
    ctx.fillText('구매 후 :', left + 18, top + 128);
    ctx.fillStyle = accent;
    ctx.fillText(detail.after, left + 100, top + 128);
  } else {
    ctx.fillStyle = '#4de2ff';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('이 강화는 최대치에 도달했습니다.', left + 18, top + 110);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`현재 값 : ${detail.current}`, left + 18, top + 130);
  }

  // — footer: price + F prompt —
  const footY = top + h - 14;
  ctx.textAlign = 'left';
  ctx.font = 'bold 16px monospace';
  if (maxed) {
    ctx.fillStyle = '#4de2ff';
    ctx.fillText('★ MAXED ★', left + 18, footY);
  } else {
    ctx.fillStyle = canAfford ? '#ffd166' : '#ff6c6c';
    ctx.fillText(`◆ ${price} CORE`, left + 18, footY);
  }

  ctx.textAlign = 'right';
  ctx.font = 'bold 14px monospace';
  if (maxed) {
    // nothing
  } else if (canAfford) {
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 8;
    ctx.fillText('[F] 구매', left + w - 18, footY);
    ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = '#ff6c6c';
    ctx.fillText('NOT ENOUGH CORE', left + w - 18, footY);
  }
  ctx.restore();
}

function drawLobbyPortalTooltip(p) {
  const accent = '#ff8aa0';
  const w = 520, h = 120;
  let left = p.x - w / 2;
  let top  = p.y + p.r + 18;                // portal is at top → show panel BELOW player
  left = Math.max(12, Math.min(W - 12 - w, left));
  top  = Math.max(12, Math.min(H - 12 - h, top));

  ctx.save();
  ctx.fillStyle = 'rgba(8, 10, 20, 0.92)';
  ctx.fillRect(left, top, w, h);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 14;
  ctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);
  ctx.shadowBlur = 0;

  // header strip
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.15;
  ctx.fillRect(left, top, w, 38);
  ctx.globalAlpha = 1;

  ctx.textAlign = 'left';
  ctx.fillStyle = accent;
  ctx.font = 'bold 20px monospace';
  ctx.fillText('REBOOT PORTAL', left + 18, top + 26);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 13px monospace';
  ctx.fillText('영구 강화된 스탯이 적용된 상태로 새 런을 시작합니다.', left + 18, top + 60);

  ctx.fillStyle = '#aab2c5';
  ctx.font = '12px monospace';
  ctx.fillText('• 스테이지 1-1부터 시작 · sessionBits 와 상점 효과는 0으로 초기화', left + 18, top + 80);

  ctx.textAlign = 'right';
  ctx.fillStyle = accent;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 8;
  ctx.font = 'bold 16px monospace';
  ctx.fillText('[F] REBOOT', left + w - 18, top + h - 14);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawFloaters() {
  for (const f of floaters) {
    const a = Math.max(0, f.life / f.maxLife);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = f.color || '#ffffff';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(f.text, f.x, f.y);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// =====================================================
//  Main Loop
// =====================================================
let lastT = 0;
function loop(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000 || 0);
  lastT = now;

  // Safety net: even if a tick throws, keep the next frame scheduled so the
  // game doesn't silently freeze. Errors will surface in DevTools console.
  try {
    update(dt);
    shopHotkeys();
    render();
  } catch (err) {
    console.error('[loop tick error]', err);
  }
  justPressed.clear();

  requestAnimationFrame(loop);
}

// =====================================================
//  Boot
// =====================================================
async function boot() {
  if (DEBUG_SINGLE_MOB) {
    console.warn('[DEBUG] DEBUG_SINGLE_MOB is ON — non-boss waves spawn only 1 mob. ' +
                 'Set DEBUG_SINGLE_MOB = false at the top of main.js to restore.');
  }
  if (DEBUG_CHEAP_PRICES) {
    console.warn('[DEBUG] DEBUG_CHEAP_PRICES is ON — every shop & lobby item costs 1 bit. ' +
                 'Set DEBUG_CHEAP_PRICES = false at the top of main.js to restore.');
  }
  // One-shot migration: previous builds saved to localStorage. Clean it up so
  // it doesn't accumulate stale data forever (we use sessionStorage now).
  try { localStorage.removeItem(SAVE_KEY); } catch (_) {}

  showOverlay('loading');
  // Load lobby state (coreBits + permanent upgrades) BEFORE makePlayer.
  // Uses sessionStorage → only restores stats from THIS tab session;
  // a fresh tab starts at base stats (dash 3, HP 100, fireCd 0.35, etc.).
  loadLobby();
  await preloadAssets();
  showOverlay('title');
  G.state = 'title';
  G.player = makePlayer();
  refreshAmmoUI();
  updateHpUI();
  updateBitsUI();
  requestAnimationFrame(loop);
}

boot().catch(err => {
  console.error(err);
  ui.overlays.loading.querySelector('.overlay-hint').textContent = '에셋 로딩 실패: ' + err.message;
});

})();
