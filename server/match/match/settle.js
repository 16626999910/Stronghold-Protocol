// server/match/match/settle.js — Match methods: SETTLE (the LP loss — a leaker's 联防 survivors —, stats, bounty coins,
// the IN_BATTLE layer gains clamped by layerGainRoom, CHAR_DAMAGE tickers, eliminations, the 联防 outcome the SETTLE
// view carries) and RESULT (finish: m.result to every human still here, onEnd).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, layerGainRoom, REVIVE_COST_LP } from '../../../shared/constants.js';
import { uniteSurvivors } from '../unite.js';
import { buildResult } from '../results.js';
import { exclusiveLayerMul } from './relics.js';
import { FLOW_TICKER_PRIORITY, DELAYS, REVIVE_PHASES } from './common.js';
import { msg } from '../../../shared/i18n.js';

/**
 * Real ms an AI teammate waits before it rescues a fallen teammate (× timerScale) — the same beat as the other bot
 * actions (DELAYS.BOT_ACTION), so the rescue reads as an action rather than an instant teleport.
 */
export const REVIVE_BOT_DELAY_MS = 900;

export class MatchSettle {
  settle(plan, uniteResult) {
    this.phase = PHASE.SETTLE;
    this.runner = null;
    this._stopClientCombat();
    // the pending in-battle gains the views showed become persistent below (alive players) or lapse (DESIGN §20.15)
    for (const ps of this.order) if (ps.pendingLayerGains) { ps.pendingLayerGains = null; ps.dirty(); }
    const cap = this.gd.lpCapPerRound;
    // a 联防 battle that could not run at all (synthetic result) must not wipe the leakers' losses: charge their own leaks
    const uniteRan = !!(plan && uniteResult && !uniteResult.synthetic);
    const survivors = uniteRan ? uniteSurvivors(plan, uniteResult) : null;
    // The 联防's outcome as data for the SETTLE view (m.public.uniteResult, views.js; GitHub #235, PR #112 by @Convey123):
    // each client pops the official result box from it (ui/gameLogic/phases.js uniteResultBox) — `through` = the leakers'
    // enemies that still got through (uncapped; only decides whether 「全员无伤！」 is true), `losses` = every alive
    // player's own LP charge of this round, the same `loss` deducted below, so the box and the LP bar never disagree. A
    // leaker's own battle leaks are not its charge in a 联防 round, which is why the client cannot work the number out
    // itself. No ticker line: the official reports the outcome in the one dialog. null when no 联防 resolved.
    this.uniteResultView = uniteRan && plan.leakers.length ? {
      through: plan.leakers.reduce((n, lk) => n + Math.max(0, survivors.get(lk.playerId) || 0), 0),
      helpers: plan.helpers.map((p) => p.playerId),
      leakers: plan.leakers.map((p) => p.playerId),
      losses: {},
    } : null;
    const alive = this.alivePlayers();
    // 共享血条 (the room extension 'sharedLp'): every charge lands in the ONE team pool (this.teamLp) instead of on the
    // individual who leaked; nobody is knocked out on their own — the pool reaching 0 ends the match as a team defeat
    const shared = !!this.sharedLp;
    let poolLoss = 0;
    for (const ps of alive) {
      const r = this.lastResults.get(ps.playerId) || { leaked: [], perfect: true, coins: 0, layerGains: {}, killed: 0, damageDealt: 0 };
      const counted = (r.leaked || []).filter((l) => l && l.counted !== false).length;
      const loss = uniteRan && plan.leakers.includes(ps) ? Math.min(cap, survivors.get(ps.playerId) || 0) : Math.min(cap, counted);
      if (this.uniteResultView) this.uniteResultView.losses[ps.playerId] = loss;
      if (shared) poolLoss += loss;
      else ps.lp -= loss;
      ps.stats.lpLost += loss;
      ps.stats.leaks += counted;
      ps.stats.kills += Number(r.killed) || 0;
      ps.stats.dmgDealt += Number(r.damageDealt) || 0;
      ps.stats.healing += Number(r.healingDone) || 0;
      if (r.perfect !== false && counted === 0) ps.stats.perfectRounds++;
      // bounty coins (own battle + unite kills) are credited to the next prep
      let coins = Math.max(0, Math.trunc(Number(r.coins) || 0));
      const up = uniteResult && uniteResult.perPlayer && uniteResult.perPlayer[ps.playerId];
      if (up) {
        coins += Math.max(0, Math.trunc(Number(up.coins) || 0));
        ps.stats.dmgDealt += Number(up.damageDealt) || 0;
        ps.stats.kills += Number(up.killed) || 0;
      }
      // perfect-payout bounties (战术特训): own phase perfect
      for (const b of ps.bounties) if (b.card.payout === 'perfect' && counted === 0 && r.perfect !== false) coins += b.card.coin;
      if (coins > 0) { ps.pendingFunds += coins; ps.stats.fundsGained += coins; }
      for (const b of ps.bounties) b.roundsLeft--;
      ps.bounties = ps.bounties.filter((b) => b.roundsLeft > 0);
      // IN_BATTLE layer gains (normal battles only), at most the room left under the match's 盟约层数上限 (this.layerCap:
      // BOND_LAYER_CAP 999 in a normal match, uncapped (0) in 无尽模式 (the 沙盒 knob caps at 9999), as the battle's live copy); a bond
      // at the cap gains nothing and dispatches nothing
      for (const [bondId, n] of Object.entries(r.layerGains || {})) {
        if (!this.gd.bond(bondId) || !(n > 0)) continue;
        const before = ps.layers[bondId] || 0;
        // 本命盟约 (专属盟约 layerMul): 战斗内获得的一切层数也 ×倍
        const mul = this.endless ? exclusiveLayerMul(ps, bondId) : 1;
        const want = mul > 1 ? Math.round(Math.floor(n) * mul) : Math.floor(n);
        const add = layerGainRoom(before, want, this.layerCap);
        if (!(add > 0)) continue;
        ps.layers[bondId] = before + add;
        this.dispatch(ps, 'onLayers', { bondId, from: before, to: ps.layers[bondId], reason: 'battle' });
      }
      this._charDamageTickers(ps, r);
      this.dispatch(ps, 'onBattleResult', { result: r, lpLoss: loss, perfect: counted === 0 && r.perfect !== false, unite: uniteResult || null });
      ps.recompute();
    }
    if (shared) {
      this.teamLp = Math.max(0, (Number.isFinite(this.teamLp) ? this.teamLp : 0) - poolLoss);
      this._syncSharedLp();   // every bar / row shows the shared total
      if (this.teamLp <= 0) {
        // TEMP DIAG (bug hunt 2026-10-12): the shared pool hit 0 — which leaks charged it? Remove once located.
        if (this.endless) {
          const detail = alive.map((ps) => { const r = this.lastResults.get(ps.playerId) || {}; const n = (r.leaked || []).filter((l) => l && l.counted !== false).length; return `${ps.playerId}:${n}`; }).join(' ');
          console.warn(`[endless] shared LP spent R=${this.round} poolLoss=${poolLoss} teamLp=${this.teamLp} uniteRan=${uniteRan} countedLeaks=${detail}`);
        }
        // 无尽模式: the fixed shared LP is spent after a failed 联防 — instead of a defeat the team enters the 打桩环节
        if (this.endless) { this.enterDummy(); return; }
        this.tickerText(msg('全队的目标生命值已耗尽'), FLOW_TICKER_PRIORITY);
        this.finish({ victory: false, reason: 'eliminated' });
        return;
      }
    } else {
      for (const ps of alive) {
        if (ps.lp <= 0) {
          ps.lp = 0;
          ps.eliminate(this.round);
          this.toast(ps, 'error', '你的目标生命值耗尽，已被淘汰');
          this.tickerText(msg('{name}博士的目标生命值已耗尽', { name: ps.name }), FLOW_TICKER_PRIORITY);
        }
      }
    }
    this.fields = [];
    this.watchers.clear();
    // 复活队友 (this build, the room extension 'revive'): a teammate was just eliminated — ask the survivors whether to
    // rescue it, in ANY round (not only one that ran a 联防; the owner's rule of 2026-10-08). m.public.reviveAsk; the
    // client pops the confirm, and a rescue offers the next fallen.
    this._refreshReviveAsk();
    this.markPublic();
    this.setDeadline(DELAYS.SETTLE / 1000, () => this.afterSettle(), { silent: this.soloUntimed });
  }

  /**
   * CHAR_DAMAGE tickers: one per board unit of the battle (its highest threshold); units created in battle (summons,
   * no board uid) count once per unit type (the highest of them) — a result can never announce more units than the
   * lineup has kinds of.
   */
  _charDamageTickers(ps, r) {
    const steps = (Array.isArray(this.gd.config.broadcasts) ? this.gd.config.broadcasts : []).filter((b) => b.type === 'CHAR_DAMAGE' && Array.isArray(b.params)).map((b) => Number(b.params[0])).filter((n) => n > 0).sort((a, b) => b - a);
    if (!steps.length) return;
    const board = new Set();
    for (const p of ps.board.values()) board.add(p.uid);
    const best = new Map();
    for (const u of r.unitStats || []) {
      if (!u) continue;
      const key = Number.isInteger(u.uid) && board.has(u.uid) ? `uid:${u.uid}` : `def:${u.defId}`;
      const cur = best.get(key);
      if (!cur || (Number(u.dmg) || 0) > (Number(cur.dmg) || 0)) best.set(key, u);
    }
    for (const u of best.values()) {
      const hit = steps.find((s) => (u.dmg || 0) >= s);
      if (hit) this.tickerFor('CHAR_DAMAGE', [ps.name, u.name || u.defId, String(hit)], { playerId: ps.playerId, param: String(hit) });
    }
  }

  /**
   * 复活队友 (this build, the room extension 'revive'; the owner's rule of 2026-10-08): the survivors are asked to
   * rescue the next fallen teammate — the first eliminated seat that is neither gone nor already rescued. Set after ANY
   * elimination (not only a 联防 round), refreshed by a rescue so the next one is offered, and null when the extension
   * is off or nobody is waiting. m.public.reviveAsk (views.js); the client pops the confirm.
   */
  _refreshReviveAsk() {
    const on = this.extensions && this.extensions.revive;
    const fallen = on ? this.order.find((p) => !p.alive && !p.left && p.eliminatedState && !p.rescued) : null;
    this.reviveAsk = fallen ? { playerId: fallen.playerId, cost: REVIVE_COST_LP } : null;
    // AI 复活 (this build): a bot teammate answers the prompt when no human survivor is left to answer it
    if (this.reviveAsk) this.scheduleReviveBot();
  }

  /**
   * AI 复活 (this build): an AI teammate (an AI seat, or a seat under AI 托管) spends its own LP to bring back a fallen
   * teammate — but only while NO connected human survivor is left to answer the 复活 prompt. The AI never preempts a
   * human's choice; it covers the case where the prompt would otherwise hang (every survivor is a bot / 托管 /
   * disconnected / gone). The richest eligible bot pays, so one bot does not spend itself to death while a richer one
   * waits. A rescue re-offers the next fallen teammate (Match.revive → _refreshReviveAsk → here again), so a team with
   * enough LP brings several back. Gated by the room extension 'revive' (a null reviveAsk never reaches here).
   */
  scheduleReviveBot() {
    if (this._reviveBotQueued) return;
    if (!(this.extensions && this.extensions.revive) || !this.reviveAsk) return;
    this._reviveBotQueued = true;
    this.later(this.scaled(REVIVE_BOT_DELAY_MS), () => {
      this._reviveBotQueued = false;
      this._reviveBotStep();
    });
  }

  /** One AI 复活 decision (scheduleReviveBot): rescue the offered teammate with the richest eligible bot, or wait. */
  _reviveBotStep() {
    if (this.ended) return;
    if (!(this.extensions && this.extensions.revive)) return;
    const ask = this.reviveAsk;
    if (!ask) return;
    if (!REVIVE_PHASES.has(this.phase)) return;      // the prompt outlives a phase it can be answered in (Match.revive)
    const fallen = this.players.get(ask.playerId);
    if (!fallen || fallen.alive || fallen.rescued) { this._refreshReviveAsk(); return; } // stale → offer the next one
    if (this._humanSurvivor()) return;               // a human can still answer: leave the choice to them
    const rescuers = [...this.players.values()].filter((p) => p.alive && p.botControlled && p.lp > REVIVE_COST_LP);
    if (!rescuers.length) return;
    rescuers.sort((a, b) => (b.lp - a.lp) || (a.seat - b.seat)); // richest first, then seat order
    this.revive(rescuers[0], fallen.playerId);
  }

  /** Whether a connected human who can answer the 复活 prompt is still alive (then the AI does not preempt it). */
  _humanSurvivor() {
    for (const p of this.players.values()) if (p.alive && !p.botControlled && p.connected) return true;
    return false;
  }

  /**
   * 共享血条 (the room extension 'sharedLp'): mirror the ONE team pool onto every player's own LP so the top bar, the
   * team rows and any individual read all show the same shared total (m.public / m.private players[].lp).
   */
  _syncSharedLp() {
    const v = Math.max(0, Number.isFinite(this.teamLp) ? this.teamLp : 0);
    for (const ps of this.order) if (ps.alive) ps.lp = v;
  }

  afterSettle() {
    if (!this.alivePlayers().length) { this.finish({ victory: false, reason: 'eliminated' }); return; }
    // 沙盒模式 (this build): ONE battle per 开战 — back to the 控制台 instead of advancing the round.
    if (this.sandbox) { this.enterSandbox(); return; }
    this.startRound(this.round + 1);
  }

  finish({ victory, hiddenCleared = false, reason = 'defeat' }) {
    if (this.ended || this.disposed) return;
    this.ended = true;
    if (this.runner) { try { this.runner.stop(); } catch { /* ignore */ } this.runner = null; }
    this._stopClientCombat();
    this.cancel(this._phaseTimer);
    this.cancel(this._turnTimer);
    for (const h of this._timers) { try { this.sched.clearTimeout(h); } catch { /* ignore */ } }
    this._timers.clear();
    this.phase = PHASE.RESULT;
    this.deadline = 0;
    for (const f of this.fields) f.live = false;
    this.outcome = { victory: !!victory, hiddenReached: this.hiddenReached, hiddenCleared: !!hiddenCleared, reason };
    let result;
    try {
      result = buildResult(this, this.outcome);
    } catch (e) {
      this.reportError('buildResult', e);
      result = { t: 'm.result', victory: !!victory, roundsPassed: 0, reason, modeId: this.modeId, difficulty: this.difficulty, players: [] };
    }
    this.lastResultMsg = result;
    this.markPublic();
    try { this.flush(true); } catch (e) { this.reportError('flush', e); }
    // every human still here gets the settlement — the spectator seats the same public rows (none of them their own)
    for (const ps of this._viewers()) this.sendTo(ps.playerId, { ...result, playerId: ps.playerId });
    const { t, ...summary } = result;
    void t;
    summary.errors = this.errorCount;
    try { this.onEndFn(summary); } catch (e) { this.reportError('onEnd', e); }
  }
}
