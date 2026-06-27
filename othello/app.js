import { OthelloEngine } from './othello-engine.js';
import { loadSettings, saveSettings, levelMs, resolveColor, LEVELS } from './config.js';

const engine = new OthelloEngine();

// ---- DOM ----
const boardEl = document.getElementById('board');
const announcerEl = document.getElementById('sr-announcer');
const statusEl = document.getElementById('status');
const bannerEl = document.getElementById('banner');
const blackNum = document.getElementById('black-num');
const whiteNum = document.getElementById('white-num');
const blackScore = document.getElementById('black-score');
const whiteScore = document.getElementById('white-score');
const movesEl = document.getElementById('moves');
const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const hintBtn = document.getElementById('hint');
const newBtn = document.getElementById('new-game');
const levelSel = document.getElementById('level');
const colorSel = document.getElementById('color');

// ---- helpers ----
// Treat bitboards as unsigned 64-bit; a signed (negative) BigInt would make
// popcount loop forever.
const U64 = (bb) => BigInt.asUintN(64, bb);
const bitAt = (bb, sq) => (U64(bb) >> BigInt(sq)) & 1n;
const popcount = (bb) => { bb = U64(bb); let n = 0; while (bb) { bb &= bb - 1n; n++; } return n; };
const sqName = (sq) => sq < 0 ? 'pass' : String.fromCharCode(97 + (sq % 8)) + (Math.floor(sq / 8) + 1);
const spokenSqName = (sq) => sq < 0 ? 'pass' : `column ${String.fromCharCode(97 + (sq % 8))}, row ${Math.floor(sq / 8) + 1}`;
const sideName = (blackToMove) => blackToMove ? 'Black' : 'White';
const colorName = (color) => color === 'black' ? 'Black' : 'White';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PLACE_DURATION_MS = 180;
const FLIP_DELAY_MS = 220;
const FLIP_STAGGER_MS = 420;
const FLIP_DURATION_MS = 320;
const TURN_SOUND_GAP_MS = 1000;
const PLACE_SOUND_START_MS = 30;
const BONGO_HIT_DURATION_MS = 240;
const STEEL_HIT_DURATION_MS = 390;
const SOUND_FINISH_PAD_MS = 120;

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

function animationsEnabled() {
  return settings.animate && !reduceMotion?.matches;
}

function firstBit(bb) {
  for (let sq = 0; sq < 64; sq++) {
    if (bitAt(bb, sq)) return sq;
  }
  return -1;
}

function discAt(state, sq) {
  if (bitAt(state.black, sq)) return 'black';
  if (bitAt(state.white, sq)) return 'white';
  return null;
}

function scoreText(black, white) {
  return `Score: Black ${popcount(black)}, White ${popcount(white)}.`;
}

function applySettingsToBody() {
  document.body.classList.toggle('no-anim', !animationsEnabled());
}

// ---- build accessible grid once ----
const cells = [];
let focusedSq = 0;

for (let row = 0; row < 8; row++) {
  const rowEl = document.createElement('div');
  rowEl.className = 'board-row';
  rowEl.setAttribute('role', 'row');
  rowEl.setAttribute('aria-rowindex', String(row + 1));

  for (let col = 0; col < 8; col++) {
    const sq = row * 8 + col;
    const cell = document.createElement('div');
    cell.id = `sq-${sqName(sq)}`;
    cell.className = 'cell';
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-rowindex', String(row + 1));
    cell.setAttribute('aria-colindex', String(col + 1));
    cell.tabIndex = sq === focusedSq ? 0 : -1;
    cell.addEventListener('click', () => onCellClick(sq));
    cell.addEventListener('keydown', (e) => onCellKeydown(e, sq));
    rowEl.appendChild(cell);
    cells.push(cell);
  }

  boardEl.appendChild(rowEl);
}

function updateTabStops() {
  for (let sq = 0; sq < 64; sq++) {
    cells[sq].tabIndex = sq === focusedSq ? 0 : -1;
  }
}

function focusSquare(sq) {
  focusedSq = Math.max(0, Math.min(63, sq));
  updateTabStops();
  cells[focusedSq]?.focus({ preventScroll: true });
}

function onCellKeydown(e, sq) {
  const row = Math.floor(sq / 8);
  const col = sq % 8;
  let next = sq;

  switch (e.key) {
    case 'ArrowUp': next = row > 0 ? sq - 8 : sq; break;
    case 'ArrowDown': next = row < 7 ? sq + 8 : sq; break;
    case 'ArrowLeft': next = col > 0 ? sq - 1 : sq; break;
    case 'ArrowRight': next = col < 7 ? sq + 1 : sq; break;
    case 'Home': next = e.ctrlKey || e.metaKey ? 0 : row * 8; break;
    case 'End': next = e.ctrlKey || e.metaKey ? 63 : row * 8 + 7; break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      onCellClick(sq);
      return;
    default:
      return;
  }

  e.preventDefault();
  focusSquare(next);
}

// ---- game state ----
let settings = loadSettings();
let humanIsBlack = true;
let history = [];   // [{ black, white, blackToMove, lastMove }]
let cursor = 0;
let busy = false;
let gameOver = false;
let gen = 0;        // bumps on New Game to cancel stale async work
let currentLegalMoves = 0n;
let pendingHumanMove = null;

const cur = () => history[cursor];
const atHead = () => cursor === history.length - 1;
const isHumanTurn = () => history.length > 0 && cur().blackToMove === humanIsBlack;
const canHumanMoveNow = () => history.length > 0 && !gameOver && !busy && atHead() && isHumanTurn();

function pushPly(black, white, blackToMove, lastMove) {
  history = history.slice(0, cursor + 1);
  history.push({ black, white, blackToMove, lastMove });
  cursor = history.length - 1;
}

async function newGame() {
  const myGen = ++gen;
  busy = true; gameOver = false; currentLegalMoves = 0n;
  pendingHumanMove = null;
  settings = loadSettings();
  applySettingsToBody();
  syncControls();
  humanIsBlack = resolveColor(settings.color) === 'black';
  bannerEl.hidden = true;
  setStatus('Loading engine...', true);

  const { black, white } = await engine.initial();
  if (myGen !== gen) return;
  history = [{ black, white, blackToMove: true, lastMove: -1 }];
  cursor = 0;
  focusedSq = 0;
  busy = false;
  render(0n);
  announce(`New game. You are playing ${humanIsBlack ? 'Black' : 'White'}. Black moves first.`);
  tick({ quietStatus: true });
}

async function tick({ quietStatus = false } = {}) {
  const myGen = gen;
  if (gameOver) return;
  const s = cur();
  const myMoves = await engine.legalMoves(s.black, s.white, s.blackToMove);
  if (myGen !== gen) return;

  if (myMoves === 0n) {
    const oppMoves = await engine.legalMoves(s.black, s.white, !s.blackToMove);
    if (myGen !== gen) return;
    if (oppMoves === 0n) { endGame(); return; }
    if (atHead()) {                         // forced pass - only advance live
      setStatus(`${sideName(s.blackToMove)} has no legal move; passing.`, false, !quietStatus);
      announcePass(s.blackToMove);
      pushPly(s.black, s.white, !s.blackToMove, -1);
      render(0n);
      setTimeout(() => tick({ quietStatus: true }), 700);
    } else {
      render(0n);
      setStatus('Reviewing previous moves. Redo to continue.');
    }
    return;
  }

  if (isHumanTurn()) {
    render(myMoves);
    setStatus(`Your move as ${sideName(s.blackToMove)}. ${plural(popcount(myMoves), 'legal move')}.`, false, !quietStatus);
  } else if (atHead()) {
    busy = true;
    setStatus(`${sideName(s.blackToMove)} engine thinking...`, true, !quietStatus);
    render(0n);
    const sq = await engine.bestMove(s.black, s.white, s.blackToMove,
                                     { depth: 24, timeMs: levelMs(settings.level) });
    if (myGen !== gen) return;
    if (sq < 0) { busy = false; tick(); return; }
    const after = await engine.apply(s.black, s.white, s.blackToMove, sq);
    if (myGen !== gen) return;
    const move = buildMove(s, after, sq, s.blackToMove);
    pushPly(after.black, after.white, !s.blackToMove, sq);
    render(0n, { move });
    await playMoveSoundAndAnimation(move);
    if (myGen !== gen) return;
    announceComputerMove(move);
    busy = false;
    tick({ quietStatus: true });
  } else {
    render(0n);
    setStatus('Reviewing previous moves. Redo to continue.');
  }
}

async function onCellClick(sq) {
  focusedSq = sq;
  updateTabStops();
  if (document.activeElement !== cells[sq]) cells[sq].focus({ preventScroll: true });

  if (gameOver || busy || !atHead() || !isHumanTurn()) {
    announce(unavailableMessage(sq, currentLegalMoves), 'assertive');
    return;
  }

  const myGen = gen;
  const s = cur();
  const moves = await engine.legalMoves(s.black, s.white, s.blackToMove);
  if (myGen !== gen) return;
  render(moves);

  if (!bitAt(moves, sq)) {
    announce(unavailableMessage(sq, moves), 'assertive');
    return;
  }

  busy = true;
  const after = await engine.apply(s.black, s.white, s.blackToMove, sq);
  if (myGen !== gen) return;
  const move = buildMove(s, after, sq, s.blackToMove);
  pushPly(after.black, after.white, !s.blackToMove, sq);
  render(0n, { move });
  pendingHumanMove = { move, actor: 'You' };
  await playMoveSoundAndAnimation(move);
  if (myGen !== gen) return;
  await delay(TURN_SOUND_GAP_MS);
  if (myGen !== gen) return;
  busy = false;
  tick({ quietStatus: true });
}

async function engineHint() {
  if (gameOver || busy || !isHumanTurn() || !atHead()) return;
  const myGen = gen;
  const s = cur();
  setStatus('Finding a suggested move...', true);
  busy = true;
  render(0n);
  const sq = await engine.bestMove(s.black, s.white, s.blackToMove,
                                   { depth: 24, timeMs: levelMs(settings.level) });
  if (myGen !== gen || sq < 0) return;
  const after = await engine.apply(s.black, s.white, s.blackToMove, sq);
  if (myGen !== gen) return;
  const move = buildMove(s, after, sq, s.blackToMove);
  pushPly(after.black, after.white, !s.blackToMove, sq);
  render(0n, { move });
  pendingHumanMove = { move, actor: 'Your suggested move' };
  await playMoveSoundAndAnimation(move);
  if (myGen !== gen) return;
  await delay(TURN_SOUND_GAP_MS);
  if (myGen !== gen) return;
  busy = false;
  tick({ quietStatus: true });
}

function undo() {
  if (busy || cursor === 0) return;
  let i = cursor;
  do { i--; } while (i > 0 && history[i].blackToMove !== humanIsBlack);
  cursor = i;
  gameOver = false; bannerEl.hidden = true;
  pendingHumanMove = null;
  announce(`Moved back to move ${cursor}. ${sideName(cur().blackToMove)} to move.`);
  tick();
}

function redo() {
  if (busy || atHead()) return;
  let i = cursor;
  do { i++; } while (i < history.length - 1 && history[i].blackToMove !== humanIsBlack);
  cursor = i;
  pendingHumanMove = null;
  announce(`Moved forward to move ${cursor}. ${sideName(cur().blackToMove)} to move.`);
  tick();
}

// ---- move animation and sound ----
function buildMove(before, after, sq, blackToMove) {
  const color = blackToMove ? 'black' : 'white';
  const flipped = [];
  const opponentBefore = blackToMove ? before.white : before.black;
  const moverAfter = blackToMove ? after.black : after.white;

  for (let i = 0; i < 64; i++) {
    if (i !== sq && bitAt(opponentBefore, i) && bitAt(moverAfter, i)) flipped.push(i);
  }

  flipped.sort((a, b) => flipDistance(a, sq) - flipDistance(b, sq) || a - b);
  return { sq, color, flips: flipped, black: after.black, white: after.white };
}

function flipDistance(a, b) {
  return Math.max(Math.abs((a % 8) - (b % 8)), Math.abs(Math.floor(a / 8) - Math.floor(b / 8)));
}

function flipDelay(index) {
  return FLIP_DELAY_MS + index * FLIP_STAGGER_MS;
}

function moveAnimationMs(move) {
  if (!animationsEnabled()) return 0;
  if (!move.flips.length) return PLACE_DURATION_MS + 80;
  return flipDelay(move.flips.length - 1) + FLIP_DURATION_MS + 90;
}

async function playMoveSoundAndAnimation(move) {
  const sound = await playMoveSounds(move);
  await Promise.all([sound.finished, delay(moveAnimationMs(move))]);
}

let audioCtx = null;
let audioWarningShown = false;
let audioOutput = null;

function getAudioContext() {
  if (!settings.soundEffects) return null;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  audioCtx ||= new AudioContext();
  return audioCtx;
}

function unlockAudio() {
  const ctx = getAudioContext();
  if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
}

async function playMoveSounds(move) {
  if (!settings.soundEffects) return noMoveSound();
  const ctx = getAudioContext();
  if (!ctx) {
    warnAudio('Othello sound effects are enabled, but Web Audio is unavailable in this browser.');
    return noMoveSound();
  }
  try {
    if (ctx.state === 'suspended') await ctx.resume();
  } catch (err) {
    warnAudio(`Othello sound effects could not start: ${err}`);
    return noMoveSound();
  }
  if (ctx.state !== 'running') {
    warnAudio(`Othello sound effects could not start; audio context is ${ctx.state}.`);
    return noMoveSound();
  }

  scheduleMoveHit(ctx, move, PLACE_SOUND_START_MS, -1, 'place');
  move.flips.forEach((_, i) => {
    scheduleMoveHit(ctx, move, flipSoundStart(i), i, 'flip');
  });

  const durationMs = moveSoundDurationMs(move);
  return { durationMs, finished: delay(durationMs) };
}

function moveSoundDurationMs(move) {
  let end = PLACE_SOUND_START_MS + hitDurationMs(move.color);
  if (move.flips.length) {
    const lastFlipStart = flipSoundStart(move.flips.length - 1);
    end = Math.max(end, lastFlipStart + hitDurationMs(move.color));
  }
  return end + SOUND_FINISH_PAD_MS;
}

function hitDurationMs(color) {
  return color === 'black' ? BONGO_HIT_DURATION_MS : STEEL_HIT_DURATION_MS;
}

function flipSoundStart(index) {
  return FLIP_DELAY_MS + index * FLIP_STAGGER_MS;
}

function noMoveSound() {
  return { durationMs: 0, finished: Promise.resolve(false) };
}

function warnAudio(message) {
  if (audioWarningShown) return;
  audioWarningShown = true;
  console.warn(message);
}

function scheduleMoveHit(ctx, move, startMs, flipIndex, kind) {
  if (move.color === 'black') scheduleBongoHit(ctx, startMs, flipIndex, kind);
  else scheduleSteelDrumHit(ctx, startMs, flipIndex, kind);
}

function getAudioOutput(ctx) {
  if (audioOutput?.context === ctx) return audioOutput.input;

  const input = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  input.gain.value = 1.8;
  compressor.threshold.value = -12;
  compressor.knee.value = 16;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.18;
  input.connect(compressor);
  compressor.connect(ctx.destination);
  audioOutput = { context: ctx, input };
  return input;
}

function scheduleBongoHit(ctx, startMs, flipIndex, kind) {
  const start = ctx.currentTime + startMs / 1000;
  const end = start + BONGO_HIT_DURATION_MS / 1000;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const base = kind === 'place' ? 118 : 142 + (flipIndex % 4) * 12;

  osc.type = 'sine';
  osc.frequency.setValueAtTime(base * 2.1, start);
  osc.frequency.exponentialRampToValueAtTime(base, start + 0.075);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(kind === 'place' ? 0.92 : 0.86, start + 0.007);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(gain);
  gain.connect(getAudioOutput(ctx));
  osc.start(start);
  osc.stop(end + 0.02);

  scheduleNoiseBurst(ctx, start, 38, 0.28, 620);
}

function scheduleNoiseBurst(ctx, start, durationMs, peakGain, cutoff) {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * durationMs / 1000));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  const end = start + durationMs / 1000;

  noise.buffer = buffer;
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(cutoff, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(getAudioOutput(ctx));
  noise.start(start);
  noise.stop(end + 0.01);
}

function scheduleSteelDrumHit(ctx, startMs, flipIndex, kind) {
  const start = ctx.currentTime + startMs / 1000;
  const end = start + STEEL_HIT_DURATION_MS / 1000;
  const base = kind === 'place' ? 523.25 : 622.25 + (flipIndex % 5) * 44;
  const partials = [
    [1, 0.5],
    [2.01, 0.24],
    [2.98, 0.15],
    [4.17, 0.09],
  ];

  for (const [ratio, peak] of partials) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(base * ratio, start);
    osc.detune.setValueAtTime(kind === 'place' ? 0 : flipIndex * 2, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(getAudioOutput(ctx));
    osc.start(start);
    osc.stop(end + 0.03);
  }
}

window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });

// ---- rendering ----
function render(legalMoves = 0n, { move = null } = {}) {
  const s = cur();
  currentLegalMoves = U64(legalMoves);
  const playableNow = canHumanMoveNow();
  const showHints = settings.showHints && playableNow;
  const animatedMove = animationsEnabled() ? move : null;
  const flipped = new Map((animatedMove?.flips || []).map((sq, i) => [sq, i]));

  if (!boardEl.contains(document.activeElement)) {
    const firstLegal = playableNow ? firstBit(currentLegalMoves) : -1;
    if (firstLegal >= 0) focusedSq = firstLegal;
  }

  for (let sq = 0; sq < 64; sq++) {
    const cell = cells[sq];
    const occupant = discAt(s, sq);
    const canPlay = playableNow && !occupant && !!bitAt(currentLegalMoves, sq);

    cell.className = 'cell';
    cell.replaceChildren();
    cell.removeAttribute('style');
    cell.tabIndex = sq === focusedSq ? 0 : -1;
    cell.setAttribute('aria-disabled', canPlay ? 'false' : 'true');
    cell.setAttribute('aria-label', squareLabel(sq, currentLegalMoves));

    if (occupant) {
      const disc = document.createElement('div');
      disc.className = `disc ${occupant}`;
      disc.setAttribute('aria-hidden', 'true');
      if (animatedMove?.sq === sq) disc.classList.add('placed');
      if (flipped.has(sq)) {
        disc.classList.add('flipped', `to-${occupant}`);
        disc.style.setProperty('--flip-delay', `${flipDelay(flipped.get(sq))}ms`);
      }
      cell.append(disc);
    } else if (canPlay) {
      cell.classList.add('playable');
      if (showHints) cell.classList.add('hint');
    }

    if (sq === s.lastMove) cell.classList.add('last');
  }

  const b = popcount(s.black), w = popcount(s.white);
  blackNum.textContent = b;
  whiteNum.textContent = w;
  blackScore.classList.toggle('turn', s.blackToMove && !gameOver);
  whiteScore.classList.toggle('turn', !s.blackToMove && !gameOver);

  renderMoves();
  undoBtn.disabled = cursor === 0 || busy;
  redoBtn.disabled = atHead() || busy;
  hintBtn.disabled = !(isHumanTurn() && atHead()) || gameOver || busy;
}

function squareLabel(sq, legalMoves) {
  const s = cur();
  const occupant = discAt(s, sq);
  const coord = `${sqName(sq)}, ${spokenSqName(sq)}`;
  const parts = [coord];

  if (occupant) {
    parts.push(`${colorName(occupant)} disc.`);
  } else if (canHumanMoveNow()) {
    parts.push(bitAt(legalMoves, sq)
      ? `Empty. Legal move for ${sideName(s.blackToMove)}.`
      : `Empty. Not a legal move for ${sideName(s.blackToMove)}.`);
  } else if (gameOver) {
    parts.push('Empty. The game is over.');
  } else if (!atHead()) {
    parts.push('Empty. You are reviewing previous moves, so this square is not playable.');
  } else if (busy) {
    parts.push('Empty. Not playable while the current move is in progress.');
  } else if (!isHumanTurn()) {
    parts.push(`Empty. You cannot move now; it is ${sideName(s.blackToMove)}'s turn.`);
  } else {
    parts.push('Empty. Not playable right now.');
  }

  if (sq === s.lastMove) parts.push('Last move.');
  return parts.join(' ');
}

function unavailableMessage(sq, legalMoves) {
  const s = cur();
  const occupant = discAt(s, sq);

  if (gameOver) return 'The game is over. Start a new game to play again.';
  if (busy) return 'Please wait until the current move finishes.';
  if (!atHead()) return 'You are reviewing previous moves. Use Redo to return to the live position before playing.';
  if (!isHumanTurn()) return `It is ${sideName(s.blackToMove)}'s turn. Please wait for the engine.`;
  if (occupant) return `${spokenSqName(sq)} already has a ${colorName(occupant)} disc.`;
  if (!bitAt(legalMoves, sq)) return `${spokenSqName(sq)} is empty, but it is not a legal move for ${sideName(s.blackToMove)}.`;
  return `${spokenSqName(sq)} is playable.`;
}

function renderMoves() {
  const list = document.createElement('ol');
  // history[0] is the start position; plies begin at index 1.
  for (let i = 1; i < history.length; i++) {
    const li = document.createElement('li');
    const moverIsBlack = history[i - 1].blackToMove;
    const moveSq = history[i].lastMove;
    const span = document.createElement('span');
    span.className = 'mv';
    span.textContent = `${moverIsBlack ? 'B' : 'W'} ${sqName(moveSq)}`;
    li.setAttribute('aria-label', moveSq < 0
      ? `${sideName(moverIsBlack)} passed`
      : `${sideName(moverIsBlack)} played ${spokenSqName(moveSq)}`);
    if (i === cursor) {
      li.style.color = 'var(--accent)';
      li.setAttribute('aria-current', 'step');
    }
    li.append(span);
    list.append(li);
  }
  movesEl.replaceChildren(list);
  movesEl.scrollTop = movesEl.scrollHeight;
}

function endGame() {
  gameOver = true;
  const s = cur();
  const b = popcount(s.black), w = popcount(s.white);
  render(0n);
  const youWon = (humanIsBlack && b > w) || (!humanIsBlack && w > b);
  const who = b === w ? 'Draw' : b > w ? 'Black wins' : 'White wins';
  const tag = b === w ? '' : (youWon ? ' - you win!' : ' - engine wins');
  const pending = takePendingHumanMove();
  const prefix = pending ? `${moveSummary(pending.move, pending.actor)} ` : '';
  const message = `${prefix}Game over. ${who}, ${b} to ${w}${tag}`;
  setStatus('Game over', false, false);
  bannerEl.textContent = message;
  bannerEl.hidden = false;
  announce(message, 'assertive');
}

function announceMove(move, actor) {
  announce(`${moveSummary(move, actor)} ${scoreText(move.black, move.white)}`);
}

function announceComputerMove(move) {
  const pending = takePendingHumanMove();
  if (pending) {
    announce(`${moveSummary(pending.move, pending.actor)} Then ${moveSummary(move, 'The computer')} ${scoreText(move.black, move.white)}`);
  } else {
    announceMove(move, 'The computer');
  }
}

function announcePass(blackToMove) {
  const pending = takePendingHumanMove();
  const passText = `${sideName(blackToMove)} had no legal move and passed.`;
  if (pending) announce(`${moveSummary(pending.move, pending.actor)} ${passText} ${scoreText(pending.move.black, pending.move.white)}`);
  else announce(passText);
}

function moveSummary(move, actor) {
  const flippedColor = move.color === 'black' ? 'white' : 'black';
  const flipped = move.flips.length
    ? `flipping ${plural(move.flips.length, `${flippedColor} disc`)} on ${spokenSquareList(move.flips)}`
    : 'flipping no discs';
  return `${actor} placed a ${colorName(move.color)} disc on ${spokenSqName(move.sq)}, ${flipped}.`;
}

function spokenSquareList(squares) {
  const names = squares.map(spokenSqName);
  if (names.length <= 1) return names[0] || 'no squares';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function takePendingHumanMove() {
  const pending = pendingHumanMove;
  pendingHumanMove = null;
  return pending;
}

function announce(text, politeness = 'polite') {
  announcerEl.setAttribute('aria-live', politeness);
  announcerEl.textContent = '';
  setTimeout(() => { announcerEl.textContent = text; }, 20);
}

function setStatus(text, thinking = false, live = true) {
  statusEl.setAttribute('aria-live', live ? 'polite' : 'off');
  statusEl.textContent = text;
  statusEl.classList.toggle('thinking', thinking);
}

function syncControls() {
  // populate level select once
  if (!levelSel.options.length) {
    for (const [key, v] of Object.entries(LEVELS)) {
      levelSel.add(new Option(`${v.label} (${v.timeMs} ms)`, key));
    }
  }
  levelSel.value = settings.level;
  colorSel.value = settings.color;
}

// ---- wiring ----
newBtn.addEventListener('click', newGame);
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
hintBtn.addEventListener('click', engineHint);
levelSel.addEventListener('change', () => {
  settings.level = levelSel.value; saveSettings(settings);
});
colorSel.addEventListener('change', () => {
  settings.color = colorSel.value; saveSettings(settings); newGame();
});

applySettingsToBody();
newGame();
