// Main-thread API for the Othello engine. Wraps the worker in promises.
//
//   import { OthelloEngine } from './othello-engine.js';
//   const engine = new OthelloEngine();
//   let { black, white } = await engine.initial();
//   const sq = await engine.bestMove(black, white, true, { timeMs: 1000 });
//   ({ black, white } = await engine.apply(black, white, true, sq));
//
// Bitboards are BigInt (bit i = file (i%8), rank (i/8); a1 = 0, h8 = 63).
export class OthelloEngine {
  constructor(workerUrl = new URL('./engine-worker.js', import.meta.url)) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this._id = 0;
    this._pending = new Map();
    this.worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const p = this._pending.get(id);
      if (!p) return;
      this._pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
  }

  _call(type, payload = {}) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  /** Starting position: { black, white } as BigInt bitboards. */
  initial() {
    return this._call('initial');
  }

  /** Legal moves for the side to move, as a BigInt bitboard. */
  legalMoves(black, white, blackToMove) {
    return this._call('legalMoves', { black, white, blackToMove });
  }

  /** Static evaluation (side-to-move relative). */
  evaluate(black, white, blackToMove) {
    return this._call('evaluate', { black, white, blackToMove });
  }

  /**
   * Best move square (0..63), or -1 to pass. Time-bounded by `timeMs`
   * (capped at `depth` plies); set timeMs = 0 for a fixed-depth search.
   */
  bestMove(black, white, blackToMove, { depth = 20, timeMs = 1000 } = {}) {
    return this._call('bestMove', { black, white, blackToMove, depth, timeMs });
  }

  /** Apply move `sq`, returning the new { black, white }. */
  apply(black, white, blackToMove, sq) {
    return this._call('apply', { black, white, blackToMove, sq });
  }

  terminate() {
    this.worker.terminate();
  }
}
