// server/match/match/unitePhase.js — Match methods: 联防 glue (the rules: server/match/unite.js) — the UNITE phase in
// both modes (the 联防 field from the helpers' carried state and the leakers' enemies), its end, and the leakers' live
// counts (_uniteLeft, user playtest #6 item 7; _uniteTick in the server-run mode).
// The field is the ROUND's own battlefield with its terrain (upstream 0.2.1「官服保留地形」; server/match/unite.js
// uniteStageId). 4 人同图 (this build): every helper fights on ONE field — the round map widened to one 8-column lane per
// helper, each helper on its own lane, enemies entering on the right and walking left through them all to the blue door
// (tools/build-data.mjs addUniteRoundMaps builds the 3- / 4-lane ones); the field rect is widened to match (uniteRect).
// 1-2 helpers keep the round map at its official rect (cols 0-20).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { uniteBattleOpts, uniteSurvivors, uniteStageId } from '../unite.js';
import { FieldRunner, timelineAt, uniteBillBounds } from '../fields.js';
import { uniteLeft } from '../../sim/spec.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from './common.js';
import { msg } from '../../../shared/i18n.js';

/**
 * The 联防 field rect of `helperCount` helpers: ONE half (cols 0-10) for a lone helper, the official full width
 * (cols 0-20) for 2, and the widened corridor for 3-4 (a lane is 8 columns; the rightmost gate = the entry, the blue
 * door E at col 2 → the field ends at col 8n+2).
 * @param {number} helperCount
 */
export function uniteRect(helperCount) {
  const n = Math.max(1, Number(helperCount) || 1);
  // 1 helper: ONE half only (the lone helper's own lane — the official 21-wide map would render both halves; the owner's
  // decision of 2026-10-08 「只有一个人联防的时候只用一张地图就行」). 2 helpers: the official whole map (both halves,
  // cols 0-20). 3 / 4: the widened corridor, 8 columns per helper (rightmost gate at col 8n+2).
  const c1 = n <= 1 ? 10 : Math.max(GEO.UNITE_RECT.c1, 8 * n + 2);
  return { r0: GEO.UNITE_RECT.r0, r1: GEO.UNITE_RECT.r1, c0: 0, c1 };
}

export class MatchUnite {
  startUnite(plan) {
    this.unitePlan = plan;
    this._uniteActive = plan.helpers;
    this._unitePending = plan.leaked;
    this._runUnite();
  }

  /**
   * 联防 field time limit (this build): the round's combat time, extended for the widened 3 / 4-lane corridor. A leaked
   * enemy crosses the whole field at its own move speed (~1 tile / 2 game s), and our field is ~1 lane (8 cols) longer per
   * helper beyond the official 2 — on the flat map the walk is 33 tiles (~67 s, just inside a 90 s round) but the round
   * maps' obstacles make it ~57 tiles (~114 s). Without the extension the survivors never reach the door, strand at the
   * limit and charge the leaker — a 联防 the players saw as cleared still cost LP (the owner's report of 2026-10-08).
   * 1 / 2 helpers keep the official limit (the official map fits it).
   * @param {any[]} helpers the 联防 helpers
   * @returns {number} seconds
   */
  _uniteLimit(helpers) {
    const base = this.wave ? this.wave.timeLimit : 60;
    const n = Array.isArray(helpers) && helpers.length ? helpers.length : 1;
    return Math.round(base * Math.max(1, n - 1));
  }

  /** Start the 联防 field (client-side combat or the server-run fallback): every helper on one map at once. */
  _runUnite() {
    const helpers = this.unitePlan.helpers;
    const leaked = this.unitePlan.leaked;
    const limit = this._uniteLimit(helpers);
    if (this.clientCombat) { this._startUniteClient(helpers, leaked); return; }
    this.phase = PHASE.UNITE;
    const battle = this.newBattle(this._uniteOpts(helpers, leaked, limit));
    this.fields = [{ fieldId: 'u', kind: 'unite', players: helpers.map((p) => p.playerId), battle, live: true }];
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this._uniteTicker(helpers);
    this._uniteLeftKey = null;
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE) return;
        const res = runner.resultOf(this.fields[0]);
        this._collectSimErrors(this.fields[0], res);
        this.fields[0].live = false;
        this.deadline = 0;
        this.markPublic();
        this.later(this.scaled(DELAYS.COMBAT_END), () => this._uniteFinished(res));
      },
    });
    this.runner.start();
  }

  /**
   * Battle options of the 联防 field (the helpers' carried end state, the enemies they face) on the ROUND's own map —
   * its terrain, crates, water, devices and runes included (unite.js uniteStageId; upstream 0.2.1「官服保留地形」, 3/4
   * helpers widened to one lane per helper). The field meta and the client-run spec carry that stageId and the (widened)
   * rect, so every viewer draws the 联防 map.
   */
  _uniteOpts(helpers, leaked, limit) {
    const { wave, players } = uniteBattleOpts(this, helpers, leaked, limit);
    return {
      seed: deriveSeed(this.seed, `u:${this.round}`),
      kind: 'unite',
      modeId: this.modeId,
      round: this.round,
      stageId: uniteStageId(this.gd, helpers.length, this.stageId) ?? this.stageId,
      rect: uniteRect(helpers.length),
      timeLimit: limit,
      players,
      spawns: this._sanitizeSpawns(wave.spawns),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: false, ...this.statFlags() },
      fieldId: 'u',
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
    };
  }

  _startUniteClient(helpers, leaked) {
    this.phase = PHASE.UNITE;
    const limit = this._uniteLimit(helpers);
    const f = this._ccField({ fieldId: 'u', kind: 'unite', players: helpers.map((p) => p.playerId), opts: this._uniteOpts(helpers, leaked, limit) });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    this._launch([f]);
    // helpers and everyone else (as observers, spectator seats included) simulate the same 联防 spec locally
    for (const ps of this._viewers()) {
      this.watchers.set(ps.playerId, 'u');
      this._sendStart(ps.playerId, f, { watch: !f.players.includes(ps.playerId) });
    }
    this.markPublic();
    this._uniteTicker(helpers);
  }

  _finishUniteClient() {
    if (this.phase !== PHASE.UNITE) return;
    const f = this.fields[0];
    const res = f.result;
    this._collectSimErrors(f, res);
    this._stopClientCombat();
    f.live = false;
    this.deadline = 0;
    this.markPublic();
    this.later(this.scaled(DELAYS.COMBAT_END), () => this._uniteFinished(res));
  }

  /** The ticker line of the 联防 ("联防阶段：{names} 迎战突破防线的敌人"). */
  _uniteTicker(helpers) {
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
  }

  /** The 联防 battle ended: settle() / uniteSurvivors charge the leakers from this field's result. */
  _uniteFinished(res) {
    if (this.phase !== PHASE.UNITE) return;
    this.runner = null;
    this._stopClientCombat();
    this.deadline = 0;
    this.markPublic();
    this.settle(this.unitePlan, res);
  }

  /**
   * 联防 (user playtest #6 item 7; PRTS 卫戍协议/帮助 "防卫失败的玩家可通过上方信息栏确认自身所属敌人的剩余数量"): how many of
   * a leaker's enemies are still standing on the 联防 field — not spawned yet, alive, or through the objective again —
   * plus its leaks that could not re-enter: what settle() charges it (before the per-round cap) if the 联防 ended now.
   * It falls as the helpers strike them down and rises when one splits or summons (the children carry the leaker).
   * Live from the field (client run: the authority's b.progress `left`; server run: the headless timeline on the field
   * clock, or the streamed battle itself), clamped to what settlement can bill that leaker (fields.js uniteBillBounds:
   * sent in + the offspring bound, validateClientResult's budget); exact once the field has its result (unite.js
   * uniteSurvivors; a synthetic result charges the own leaks, as settle()). null for anyone but a leaker of the running
   * 联防.
   * @returns {number|null}
   */
  _uniteLeft(ps) {
    const plan = this.unitePlan;
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    const f = this.fields.find((x) => x && x.kind === 'unite') || null;
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(plan, res).get(pid) || 0;
    const sent = plan.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[3] && typeof sample[3] === 'object' ? sample[3] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) this._uniteBounds = { plan, bounds: uniteBillBounds(plan.leaked, this.gd) };
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    return standing + (plan.notReentered.get(pid) || 0);
  }

  /** Server-run 联防 (streaming mode): refresh m.public about once a game second when a leaker's count moved. */
  _uniteTick(runner) {
    const f = runner && runner.fields ? runner.fields[0] : null;
    if (!f || !f.battle || runner.ticks % 30 !== 0) return;
    let key = '';
    try { key = JSON.stringify(uniteLeft(f.battle)); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }
}
