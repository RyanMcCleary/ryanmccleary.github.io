// Web Worker hosting the WASM engine, so search never blocks the UI thread.
// Boards are BigInt bitboards (a1 = bit 0 ... h8 = bit 63); squares are 0..63.
import createOthello from './othello.js';

let mod = null;
const ready = createOthello().then((m) => { mod = m; });

// uint64 bitboards come back from WASM as signed i64 BigInts: a disc on h8
// (bit 63) makes the value negative. Normalize to unsigned so the UI's bit
// math (popcount in particular) stays finite.
const u64 = (x) => BigInt.asUintN(64, x);

self.onmessage = async (e) => {
  await ready;
  const msg = e.data;
  const btm = msg.blackToMove ? 1 : 0;
  try {
    let result;
    switch (msg.type) {
      case 'initial':
        result = {
          black: u64(mod._othello_initial_black()),
          white: u64(mod._othello_initial_white()),
        };
        break;
      case 'legalMoves':
        result = u64(mod._othello_legal_moves(msg.black, msg.white, btm));
        break;
      case 'evaluate':
        result = mod._othello_evaluate(msg.black, msg.white, btm);
        break;
      case 'bestMove':
        result = mod._othello_best_move(
          msg.black, msg.white, btm, msg.depth | 0, msg.timeMs | 0);
        break;
      case 'apply':
        mod._othello_apply(msg.black, msg.white, btm, msg.sq | 0);
        result = {
          black: u64(mod._othello_result_black()),
          white: u64(mod._othello_result_white()),
        };
        break;
      default:
        throw new Error('unknown message type: ' + msg.type);
    }
    self.postMessage({ id: msg.id, result });
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err) });
  }
};
