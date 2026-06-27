import { OthelloEngine } from './othello-engine.js';
import { loadSettings, saveSettings, levelMs, resolveColor, LEVELS } from './config.js';

const engine = new OthelloEngine();

// ---- DOM ----
const boardEl = document.getElementById('board');
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
const sqName = (sq) => sq < 0 ? '–' : String.fromCharCode(97 + (sq % 8)) + (Math.floor(sq / 8) + 1);

// ---- build cells once ----
const cells = [];
for (let sq = 0; sq < 64; sq++) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.setAttribute('role', 'button');
  cell.tabIndex = -1;
  cell.addEventListener('click', () => onCellClick(sq));
  cell.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCellClick(sq); }
  });
  boardEl.appendChild(cell);
  cells.push(cell);
}

// ---- game state ----
let settings = loadSettings();
let humanIsBlack = true;
let history = [];   // [{ black, white, blackToMove, lastMove }]
let cursor = 0;
let busy = false;
let gameOver = false;
let gen = 0;        // bumps on New Game to cancel stale async work

const cur = () => history[cursor];
const atHead = () => cursor === history.length - 1;
const isHumanTurn = () => cur().blackToMove === humanIsBlack;

function pushPly(black, white, blackToMove, lastMove) {
  history = history.slice(0, cursor + 1);
  history.push({ black, white, blackToMove, lastMove });
  cursor = history.length - 1;
}

async function newGame() {
  const myGen = ++gen;
  busy = true; gameOver = false;
  settings = loadSettings();
  syncControls();
  humanIsBlack = resolveColor(settings.color) === 'black';
  const { black, white } = await engine.initial();
  if (myGen !== gen) return;
  history = [{ black, white, blackToMove: true, lastMove: -1 }];
  cursor = 0;
  busy = false;
  bannerEl.hidden = true;
  render();
  tick();
}

async function tick() {
  const myGen = gen;
  if (gameOver) return;
  const s = cur();
  const myMoves = await engine.legalMoves(s.black, s.white, s.blackToMove);
  if (myGen !== gen) return;

  if (myMoves === 0n) {
    const oppMoves = await engine.legalMoves(s.black, s.white, !s.blackToMove);
    if (myGen !== gen) return;
    if (oppMoves === 0n) { endGame(); return; }
    if (atHead()) {                         // forced pass — only advance live
      setStatus(`${s.blackToMove ? 'Black' : 'White'} has no move — passing`);
      pushPly(s.black, s.white, !s.blackToMove, -1);
      render();
      setTimeout(tick, 700);
    } else {
      render();
      setStatus('Reviewing — Redo to continue');
    }
    return;
  }

  if (isHumanTurn()) {
    render(myMoves);
    setStatus('Your move');
  } else if (atHead()) {
    setStatus('Engine thinking…', true);
    render();
    busy = true;
    const sq = await engine.bestMove(s.black, s.white, s.blackToMove,
                                     { depth: 24, timeMs: levelMs(settings.level) });
    busy = false;
    if (myGen !== gen) return;
    if (sq < 0) { tick(); return; }
    const after = await engine.apply(s.black, s.white, s.blackToMove, sq);
    if (myGen !== gen) return;
    pushPly(after.black, after.white, !s.blackToMove, sq);
    render();
    tick();
  } else {
    render();
    setStatus('Reviewing — Redo to continue');
  }
}

async function onCellClick(sq) {
  if (gameOver || busy) return;
  const s = cur();
  if (s.blackToMove !== humanIsBlack) return;
  const moves = await engine.legalMoves(s.black, s.white, s.blackToMove);
  if (!bitAt(moves, sq)) return;
  const after = await engine.apply(s.black, s.white, s.blackToMove, sq);
  pushPly(after.black, after.white, !s.blackToMove, sq);
  render();
  tick();
}

async function engineHint() {
  if (gameOver || busy || !isHumanTurn() || !atHead()) return;
  const s = cur();
  setStatus('Engine thinking…', true);
  busy = true;
  const myGen = gen;
  const sq = await engine.bestMove(s.black, s.white, s.blackToMove,
                                   { depth: 24, timeMs: levelMs(settings.level) });
  busy = false;
  if (myGen !== gen || sq < 0) return;
  const after = await engine.apply(s.black, s.white, s.blackToMove, sq);
  pushPly(after.black, after.white, !s.blackToMove, sq);
  render();
  tick();
}

function undo() {
  if (busy || cursor === 0) return;
  let i = cursor;
  do { i--; } while (i > 0 && history[i].blackToMove !== humanIsBlack);
  cursor = i;
  gameOver = false; bannerEl.hidden = true;
  tick();
}

function redo() {
  if (busy || atHead()) return;
  let i = cursor;
  do { i++; } while (i < history.length - 1 && history[i].blackToMove !== humanIsBlack);
  cursor = i;
  tick();
}

// ---- rendering ----
function render(hints = 0n) {
  const s = cur();
  const showHints = settings.showHints && isHumanTurn() && !gameOver;
  for (let sq = 0; sq < 64; sq++) {
    const cell = cells[sq];
    cell.className = 'cell';
    cell.replaceChildren();
    cell.tabIndex = -1;
    let label = sqName(sq) + ', empty';
    if (bitAt(s.black, sq)) {
      const d = document.createElement('div'); d.className = 'disc black'; cell.append(d);
      label = sqName(sq) + ', black';
    } else if (bitAt(s.white, sq)) {
      const d = document.createElement('div'); d.className = 'disc white'; cell.append(d);
      label = sqName(sq) + ', white';
    } else if (showHints && bitAt(hints, sq)) {
      cell.classList.add('hint');
    }
    if (showHints && bitAt(hints, sq)) { cell.classList.add('playable'); cell.tabIndex = 0; }
    if (sq === s.lastMove) cell.classList.add('last');
    cell.setAttribute('aria-label', label);
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

function renderMoves() {
  const list = document.createElement('ol');
  // history[0] is the start position; plies begin at index 1.
  for (let i = 1; i < history.length; i++) {
    const li = document.createElement('li');
    const mover = history[i - 1].blackToMove ? 'B' : 'W';
    const txt = history[i].lastMove < 0 ? 'pass' : sqName(history[i].lastMove);
    li.innerHTML = `<span class="mv">${mover} ${txt}</span>`;
    if (i === cursor) li.style.color = 'var(--accent)';
    list.append(li);
  }
  movesEl.replaceChildren(list);
  movesEl.scrollTop = movesEl.scrollHeight;
}

function endGame() {
  gameOver = true;
  const s = cur();
  const b = popcount(s.black), w = popcount(s.white);
  render();
  const youWon = (humanIsBlack && b > w) || (!humanIsBlack && w > b);
  const who = b === w ? 'Draw' : b > w ? 'Black wins' : 'White wins';
  const tag = b === w ? '' : (youWon ? ' — you win! 🎉' : ' — engine wins');
  setStatus(`Game over`);
  bannerEl.textContent = `${who} ${b}–${w}${tag}`;
  bannerEl.hidden = false;
}

function setStatus(text, thinking = false) {
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

document.body.classList.toggle('no-anim', !settings.animate);
newGame();
