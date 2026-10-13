// server/match/match/intents.js — Match methods: the g.* / b.* intent router (_handle: the prep intents go to
// PlayerState, the drafts, watching, the pause and the battle reports to the match), emotes, AI 托管 (setAutoplay,
// kickBot) and g.unitStats (the stats the board's units start their next battle with: a preview battle, started, read
// and dropped).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { unitStatsEntry } from '../../../shared/protocol.js';
import { PHASE, ERR, EMOTES, EMOTE_COOLDOWN_MS, GEO, REVIVE_COST_LP, REVIVE_RESTORE_LP } from '../../../shared/constants.js';
import { cleanChatText } from '../../../shared/chat.js';
import { deriveSeed } from '../../sim/rng.js';
import { msg } from '../../../shared/i18n.js';
import { OK, fail, FLOW_TICKER_PRIORITY, REVIVE_PHASES } from './common.js';

export class MatchIntents {
  _handle(ps, msg) {
    switch (msg.t) {
      case 'g.infoReady':
        if (this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE);
        if (!ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
        return OK;
      // 无尽模式 runs the 并发 3 选 strategy draft (draft.endless): g.band appends to the player's set
      case 'g.band': return this.pickBand(ps, msg.bandId);
      case 'g.bandSkip': return this.skipBand(ps);
      // the strategy highlighted in the draft screen (what a timed-out turn takes, timeoutBand)
      case 'g.bandFocus': return this.bandFocus(ps, msg.bandId ?? null);
      case 'g.buy': return ps.buy(msg.slot);
      case 'g.econBuy': return this.endlessBuyEcon(ps, msg.idx); // 经济商店弹窗: 买转职/装备
      case 'g.refresh': return ps.refresh();
      case 'g.freeze': return ps.freeze();
      case 'g.levelUp': return ps.levelUp();
      case 'g.sell': return ps.sell(msg.uid);
      // dir: the deploy wheel's facing (DESIGN §3; absent ⇒ PlayerState reads to.dir, then RIGHT)
      case 'g.move': return ps.move(msg.uid, msg.to, msg.dir);
      case 'g.equip': return ps.equip(msg.itemUid, msg.targetUid, msg.replaceUid ?? null);
      case 'g.art': return ps.useArt(msg.itemUid, msg.row, msg.col, msg.dir);
      case 'g.destroy': return ps.destroy(msg.uid);
      // 无尽狂潮 装备拆卸器: strip every item off an operator back to the 装备库 (author 2026-10-12)
      case 'g.unequip': return ps.unequip(msg.targetUid);
      // 无尽狂潮 肉鸽: 藏品/决策/专属盟约 选取 (author 2026-10-12)
      case 'g.relic': return this.endlessChooseRelic(ps, msg.idx);
      case 'g.decision': return this.endlessChooseDecision(ps, msg.idx);
      case 'g.exclusive': return this.endlessChooseExclusive(ps, msg.bondId);
      case 'g.reward': return ps.pickReward(msg.idx);
      case 'g.choice': return this.pickCard(ps, msg.idx);
      case 'g.ready': return ps.setReady(!!msg.ready);
      case 'g.emote': return this.emote(ps, msg.id);
      case 'g.chat': return this.chat(ps, msg.text);
      // playerId: the player tapped (a shared field names two) — the watch preference (item 56)
      case 'g.watch': return this.watch(ps, msg.fieldId, msg.playerId ?? null);
      case 'g.autoplay': return this.setAutoplay(ps, !!msg.on);
      case 'g.pause': return this.setPause(ps, !!msg.on);
      // 复活队友 (this build): spend the sender's own LP to bring an eliminated teammate back (see revive)
      case 'g.revive': return this.revive(ps, msg.playerId);
      // the stats the board's units start their next battle with (the detail card in prep, user playtest #4 item 7)
      case 'g.unitStats': return this.unitStats(ps, msg.seq ?? null);
      // 沙盒 (this build): the in-match 控制台
      case 'g.sandboxSet': return this.sandboxSet(ps, msg);
      case 'g.sandboxGive': return this.sandboxGive(ps, msg.kind, msg.id);
      case 'g.sandboxStart': return this.sandboxStart();
      case 'g.sandboxExit': return this.sandboxExit();
      case 'g.sandboxClear': return this.sandboxClear(ps, msg.area);
      case 'g.leave': this.onLeave(ps.playerId); return OK;
      case 'b.progress': return this._onProgress(ps, msg);
      case 'b.result': return this._onResult(ps, msg);
      default: return fail(ERR.BAD_MSG);
    }
  }

  emote(ps, id) {
    if (!EMOTES.includes(id)) return fail(ERR.BAD_MSG, 'unknown emote');
    const now = this.sched.now();
    if (now - ps.lastEmoteAt < EMOTE_COOLDOWN_MS) return fail(ERR.RATE);
    ps.lastEmoteAt = now;
    this.broadcast({ t: 'm.emote', playerId: ps.playerId, id });
    return OK;
  }

  /**
   * 局内文字聊天（作者 2026-10-11）：与表情**同一条冷却**（`lastEmoteAt`，chatCD）——清理后的文本广播一条
   * `m.chat { playerId, text }`，客户端把它像表情一样横穿屏幕。空串 / 只有空白 → 拒绝。
   */
  chat(ps, text) {
    const clean = cleanChatText(text);
    if (!clean) return fail(ERR.BAD_MSG, 'empty chat');
    const now = this.sched.now();
    if (now - ps.lastEmoteAt < EMOTE_COOLDOWN_MS) return fail(ERR.RATE);
    ps.lastEmoteAt = now;
    this.broadcast({ t: 'm.chat', playerId: ps.playerId, text: clean });
    return OK;
  }

  setAutoplay(ps, on) {
    if (ps.autoplay === on) return OK;
    ps.autoplay = on;
    this.markPublic();
    if (on) this.kickBot(ps);
    return OK;
  }

  /** Let the bot act for a (newly) bot-controlled seat in the current phase. */
  kickBot(ps) {
    if (!ps.botControlled || this.ended) return;
    if (this.phase === PHASE.INFO_CHECK && !ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
    else if (this.phase === PHASE.BAND_DRAFT && this.draftTurn() === ps.playerId) this.scheduleBandBot();
    else if (this.phase === PHASE.SP_DRAFT && this.spTurn(ps.playerId) === ps.playerId) this.scheduleSpBot(this.spGroupOf(ps.playerId));
    else if (this.phase === PHASE.PREP && ps.alive && !ps.ready) this.scheduleBotPrep(ps, 0);
  }

  /**
   * 复活队友 (this build's addition; the room extension 'revive' — the host turns it on in 房间 · 玩法扩展): g.revive
   * { playerId } spends REVIVE_COST_LP (10) of the sender's OWN LP to rescue an eliminated teammate. The rescued keeps
   * its operators, equipment and state (PlayerState.reviveFrom restores the board / hand / temp and re-takes its pool
   * copies) and comes back at REVIVE_RESTORE_LP (1). Each SEAT may be rescued at most once per match (PlayerState
   * .rescued — the limit is on the one rescued, not on whoever pays). Offered whenever a teammate is eliminated — any
   * round, not only one that ran a 联防 (the owner's rule of 2026-10-08; settle.js _refreshReviveAsk) — and through the
   * phases that follow; the cost is broadcast so everyone sees what was paid.
   */
  revive(ps, targetId) {
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (!this.extensions || !this.extensions.revive) return fail(ERR.EXTENSION_OFF);
    if (!REVIVE_PHASES.has(this.phase)) return fail(ERR.WRONG_PHASE);
    if (!(ps.lp > REVIVE_COST_LP)) return fail(ERR.REVIVE_LP);
    const target = typeof targetId === 'string' ? this.players.get(targetId) : null;
    if (!target || target === ps) return fail(ERR.BAD_MSG, 'no such teammate');
    if (target.alive) return fail(ERR.ALREADY, 'that teammate is still standing');
    if (target.left || !target.eliminatedState) return fail(ERR.BAD_MSG, 'that teammate cannot be rescued');
    if (target.rescued) return fail(ERR.REVIVE_USED);
    ps.lp -= REVIVE_COST_LP;
    target.reviveFrom(this.round);
    target.startRound(this.round);                                   // this round's income + shop for the rescued seat
    this.dispatch(target, 'onRoundStart', { round: this.round });
    target.lp = REVIVE_RESTORE_LP;
    target.rescued = true;
    target.revivedBy = ps.playerId;
    this._refreshReviveAsk(); // the prompt is answered; offer the next fallen teammate, if any
    // a boss round's prep: pair the players again for the rescued seat (as a departure does — platform._quit), so its
    // half of the boss field and the template preview are the same as the rest of the team's
    if (this.bossWaves && (this.phase === PHASE.ROUND_START || this.phase === PHASE.SP_DRAFT || this.phase === PHASE.PREP)) {
      this._planBossWaves();
      for (const p of this.alivePlayers()) p.recompute();
    }
    this.tickerText(msg('{who}博士消耗 {cost} 点目标生命救援了 {name}博士（其剩余 {restore} 点）', { who: ps.name, cost: REVIVE_COST_LP, name: target.name, restore: REVIVE_RESTORE_LP }), FLOW_TICKER_PRIORITY);
    this.toast(ps, 'info', msg('已消耗 {cost} 点目标生命救援 {name}博士', { cost: REVIVE_COST_LP, name: target.name }));
    this.toast(target, 'info', msg('{who}博士消耗 {cost} 点目标生命救援了你（剩余 {restore} 点）', { who: ps.name, cost: REVIVE_COST_LP, restore: REVIVE_RESTORE_LP }));
    this.markPrivate(ps);
    this.markPrivate(target);
    this.markPublic();
    return OK;
  }

  /**
   * g.unitStats { seq? } (user playtest #4 item 7: the detail card showed fixed record stats): the stats every unit of
   * the player's board will fight with at the start of its next battle — equipment, bonds and their layers, 特质, the
   * band and 机变 effects — computed exactly by the shared sim. The player's battle input after the onBattleStart meta
   * handlers (`ev.preview: true`, no enemies — those handlers must not change the match for a preview) builds a Battle
   * of the battle's options that is started (initial deployment + battleStart hooks), read and dropped: it is never
   * stepped, so skills and timed effects do not show. Pushed to the player as `m.unitStats { seq, round, units }`
   * (units: shared/protocol.js unitStatsEntry, board operators and summons by uid); cached per input (a build costs
   * ≈ 0.3–0.7 ms). Prep phases only (ROUND_START, 机变, PREP); a battle's live stats come from the browser's own sim.
   * @param {PlayerState} ps @param {number|null} seq echoed (the client keeps the newest answer)
   */
  unitStats(ps, seq = null) {
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.phase !== PHASE.ROUND_START && this.phase !== PHASE.SP_DRAFT && this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    const units = this._unitStatsOf(ps);
    this.sendTo(ps.playerId, { t: 'm.unitStats', seq: Number.isInteger(seq) ? seq : null, round: this.round, units });
    return OK;
  }

  /** The start-of-battle stats of a player's board units (see unitStats); [] when the preview battle cannot be built. */
  _unitStatsOf(ps) {
    const input = ps.battleInput({ side: 'L', colOffset: 0 });
    const ev = { input, kind: 'normal', round: this.round, preview: true };
    this.dispatch(ps, 'onBattleStart', ev);
    const players = [ev.input && typeof ev.input === 'object' ? ev.input : input];
    let key = null;
    try { key = JSON.stringify([this.round, this.stageId, this.battleContent, players]); } catch { key = null; }
    if (!this._unitStatsCache) this._unitStatsCache = new WeakMap(); // PlayerState → { key, units } (the last preview)
    const cached = this._unitStatsCache.get(ps);
    if (key && cached && cached.key === key) return cached.units;
    const units = [];
    // the flags of the battle it previews: a normal round gains IN_BATTLE layers from its start (a <战斗开始时> layer gain
    // raises bond stats at t = 0 there too); the Final Assault / Hidden Core fight without (previewed as a normal field)
    const bossRound = this.round === this.gd.bossRound || this.round === this.gd.hiddenRound;
    const b = this.newBattle({
      seed: deriveSeed(this.seed, `preview:${this.round}:${ps.seat}`), kind: 'normal', modeId: this.modeId, round: this.round,
      stageId: this.stageId, rect: { ...GEO.NORMAL_RECT }, timeLimit: 60, players, spawns: [], routes: this.wave ? this.wave.routes : [],
      sharedBoss: null, flags: { layerGainsEnabled: !bossRound, ...this.statFlags() }, fieldId: `n:${ps.playerId}`, recordEvents: false,
    });
    try {
      if (typeof b.start === 'function') b.start();
      for (const u of Array.isArray(b.allyUnits) ? b.allyUnits : []) {
        if (u && Number.isInteger(u.uid) && (u.kind === 'op' || u.kind === 'token')) units.push(unitStatsEntry(u, u.s));
      }
    } catch (e) { this.reportError('unitStats', e); }
    this._unitStatsCache.set(ps, { key, units });
    return units;
  }
}

// 清理一条局内文字聊天（去控制字符 / 压缩空白 / 去首尾 / 按码点截断 CHAT_MAX_LEN；空串返回 null）。实现已抽到
// shared/chat.js（大厅聊天 server/lobbyChat.js 也用它）；这里 import 后用并 re-export，保住既有 import
// （test/ui/emotes.test.js 从这里取）。
export { cleanChatText };
