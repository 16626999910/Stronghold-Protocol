// In-match intents (`g.*`, DESIGN §8.2) with uniform error handling: every request goes through
// `act()`, which plays a UI sound on success, shows the ERR_TEXT toast on failure and never throws.
// The UI never mutates state optimistically — it waits for the next m.private / m.public push.
// `net.request` is looked up at call time so the dev mock harness can stub it.

import { net } from '../net.js';
import { toastError } from './toasts.js';
import { audio } from '../audio.js';

const SUCCESS_SFX = {
  'g.buy': 'buy', 'g.sell': 'sell', 'g.refresh': 'refresh', 'g.freeze': 'freeze', 'g.levelUp': 'levelup',
  'g.move': 'drop', 'g.equip': 'equip', 'g.art': 'artPlace', 'g.reward': 'pick', 'g.choice': 'pick',
  'g.band': 'confirm', 'g.bandSkip': 'back', 'g.infoReady': 'ready', 'g.emote': 'emote', 'g.destroy': 'back',
};

let inflight = 0;
const busyListeners = new Set();
const emitBusy = () => { for (const fn of [...busyListeners]) { try { fn(inflight); } catch { /* ignore */ } } };

/** Subscribe to the number of in-flight intents (for subtle busy indicators). */
export function onBusy(fn) { busyListeners.add(fn); return () => busyListeners.delete(fn); }

/**
 * Send an intent. Resolves true on `ok`, false on error (already toasted).
 * @param {string} t
 * @param {object} [fields]
 * @param {{ sfx?: string|false, quiet?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function act(t, fields = {}, opts = {}) {
  inflight += 1;
  emitBusy();
  try {
    await net.request(t, fields);
    const s = opts.sfx === undefined ? SUCCESS_SFX[t] : opts.sfx;
    if (s) audio.sfx(s);
    return true;
  } catch (err) {
    if (!opts.quiet) {
      toastError(err);
      audio.sfx('error', { volume: 0.6 });
    }
    return false;
  } finally {
    inflight = Math.max(0, inflight - 1);
    emitBusy();
  }
}

export const actions = {
  infoReady: () => act('g.infoReady'),
  // 重刷本局 (match/reroll.js)
  rerollSetup: () => act('g.rerollSetup', {}, { sfx: 'click' }),
  rerollVote: (id, agree) => act('g.rerollVote', { id, agree: !!agree }, { sfx: agree ? 'confirm' : 'back' }),
  cancelReroll: (id) => act('g.cancelReroll', { id }, { sfx: 'back' }),
  band: (bandId) => act('g.band', { bandId }),
  bandSkip: () => act('g.bandSkip'),
  buy: (slot) => act('g.buy', { slot }),
  econBuy: (idx) => act('g.econBuy', { idx }, { sfx: 'buy' }), // 经济商店弹窗: 买转职/装备
  econRefresh: () => act('g.econRefresh', {}, { sfx: 'refresh' }), // 经济商店弹窗: 刷新货架
  refresh: () => act('g.refresh'),
  freeze: () => act('g.freeze'),
  levelUp: () => act('g.levelUp'),
  sell: (uid) => act('g.sell', { uid }),
  // `dir` (UP|RIGHT|DOWN|LEFT): the direction chosen with the deploy wheel (research 09 §6.1 — g.move / g.art carry it;
  // the server defaults to RIGHT when absent)
  move: (uid, to, dir) => act('g.move', dir ? { uid, to, dir } : { uid, to }),
  // `replaceUid`: the equipped item the replace dialog picked (ui/equipReplace.js) — it is destroyed; absent ⇒ none needed
  equip: (itemUid, targetUid, replaceUid) => act('g.equip', Number.isInteger(replaceUid) ? { itemUid, targetUid, replaceUid } : { itemUid, targetUid }),
  art: (itemUid, row, col, dir) => act('g.art', dir ? { itemUid, row, col, dir } : { itemUid, row, col }),
  destroy: (uid) => act('g.destroy', { uid }),
  // 无尽狂潮 装备拆卸器: strip every item off an operator back to the 装备库
  unequip: (targetUid) => act('g.unequip', { targetUid }, { sfx: 'back' }),
  // 无尽狂潮 肉鸽: 选藏品 / 选通用决策 / 第 1 回合选专属盟约 (author 2026-10-12)
  relic: (idx) => act('g.relic', { idx }, { sfx: 'pick' }),
  decision: (idx) => act('g.decision', { idx }, { sfx: 'pick' }),
  exclusive: (bondId) => act('g.exclusive', { bondId }, { sfx: 'pick' }),
  reward: (idx) => act('g.reward', { idx }),
  choice: (idx) => act('g.choice', { idx }),
  ready: (ready) => act('g.ready', { ready }, { sfx: ready ? 'ready' : 'back' }),
  emote: (id) => act('g.emote', { id }, { quiet: true }),
  // 局内文字聊天（作者 2026-10-11）：与表情同一条冷却（服务端 chatCD），文本经服务端清理后原样广播
  chat: (text) => act('g.chat', { text }, { quiet: true }),
  // 沙盒模式 (this build): the in-match 控制台 — 配置(map/wave/boss/倍率/层数上限)、买全部、开战
  sandboxSet: (cfg) => act('g.sandboxSet', cfg, { quiet: true }),
  // 反馈: buy sound on success and a toast on failure — a silent give read as "点了没反应" (community report 2026-10-14)
  sandboxGive: (kind, id) => act('g.sandboxGive', { kind, id }, { sfx: 'buy' }),
  sandboxStart: () => act('g.sandboxStart', {}, { sfx: 'ready' }),
  sandboxExit: () => act('g.sandboxExit', {}, { quiet: true }),
  sandboxClear: (area) => act('g.sandboxClear', { area }, { quiet: true }),
  // `playerId`: the player tapped in the team panel (a shared field shows two) — what an eliminated viewer follows
  watch: (fieldId, playerId = null) => act('g.watch', typeof playerId === 'string' && playerId ? { fieldId, playerId } : { fieldId }, { sfx: 'tab' }),
  autoplay: (on) => act('g.autoplay', { on }),
  // solo battles only (ui/matchStatus.js pauseAvailable): m.public.paused follows
  pause: (on) => act('g.pause', { on: !!on }, { sfx: on ? 'click' : 'confirm' }),
  // 复活队友 (this build, the room extension 'revive'): spend your own REVIVE_COST_LP to rescue an eliminated teammate
  // (playerId) back at REVIVE_RESTORE_LP with its operators / equipment / state; each seat rescuable once per match
  // (server/match/match/intents.js revive)
  revive: (playerId) => act('g.revive', { playerId }, { sfx: 'confirm' }),
};
