// server/match/match/sandbox.js — Match methods: 沙盒 (this build, author 2026-10-11). A SOLO 娱乐 match that runs
// **ONE configurable battle** (地图 / 波次 / 首领 / 怪物血量倍率 / 羁绊层数), driven by the in-match 控制台
// (g.sandboxSet / g.sandboxGive / g.sandboxStart / g.sandboxExit). The random stage/boss draw and the 14-round flow are
// skipped: the match enters a single 沙盒准备 (reusing PREP — the board editor + the console; solo ⇒ no deadline) and only
// 开战 starts a field. After the battle settles it returns to 沙盒准备 (match/settle.js) instead of advancing.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR, SANDBOX_HP_MUL_MAX, BOND_LAYER_CAP } from '../../../shared/constants.js';
import { buildBossWave } from '../waves.js';
import { pairPlayers } from '../finalAssault.js';
import { OK, fail } from './common.js';

/** The purse handed out each 沙盒准备 (the console buys everything, so a comfortable amount keeps `funds` readable). */
const SANDBOX_FUNDS = 999;
const SANDBOX_MAX_ENEMY_SLOTS = 64;
const SANDBOX_MAX_LAYERS = BOND_LAYER_CAP; // 羁绊层数上限 999 (author 2026-10-11)

export class MatchSandbox {
  /**
   * Enter 沙盒准备. Reuses PREP so the client's prep editor + the 控制台 are active; solo ⇒ no deadline (only 开战 starts
   * a battle, g.sandboxStart). Called from platform.start() (sandbox) and again from settle.js after a battle.
   */
  enterSandbox() {
    if (this.disposed || this.ended) return;
    this.round = 1;
    this.sandboxForcePair = false;                     // 双人首领战场: set per boss 开战 (sandboxStart), cleared here
    const alive = this.alivePlayers();
    for (const ps of alive) {
      ps.startRound(this.round);
      // the opening 策略 draft is skipped, so LP (set by it) comes from the default strategy once
      if (!ps.bandId) { const id = this.defaultBand(ps.playerId); ps.bandId = id; ps.lp = this.gd.startLp(id); }
    }
    this.enterPrep();
    for (const ps of alive) ps.addFunds(SANDBOX_FUNDS, { reason: 'sandbox' });
    this._applyBossPreview();                          // 首领场: show the boss big map in the prep right away
    this.markPublic();
  }

  /**
   * 准备期的「首领预览」(author 2026-10-11): while a boss is selected in the 控制台, plan the boss round's `bossWaves`
   * and set `round` to the boss round — exactly the normal 最终攻势 prep — so the client's prep view jumps to the boss
   * big map (prepCamera → bossPrep, deployFieldOf → bossL) with the leader standing at its spawn (nextEnemiesFor). With
   * no boss (普通战场) it resets to round 1 / no boss waves (the normal board).
   */
  _applyBossPreview() {
    const sb = this.sandbox;
    if (!sb || sb.mode !== 'boss' || !sb.bossId) { this.round = 1; this.bossWaves = null; return; }
    const rec = this.gd.boss(sb.bossId);
    const hidden = !!rec.hidden;
    const tr = rec.templates && rec.templates[this.modeId] && rec.templates[this.modeId].round;
    this.round = Number.isInteger(tr) ? tr : (hidden ? 15 : 14);
    this.bossWaves = pairPlayers(this.alivePlayers()).map((g) => ({
      players: g.map((p) => p.playerId),
      wave: buildBossWave(this.gd, this.rngWaves, this.factions, this.round, { bossId: sb.bossId, solo: false }),
    }));
  }

  /** g.sandboxSet (ps, { stageId?, mode?, enemies?, bossId?, hpMul?, bonds? }) — the 控制台 config; applied at the next 开战. */
  sandboxSet(ps, cfg) {
    if (!this.sandbox || this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    const sb = this.sandbox;
    if (cfg.stageId !== undefined) {
      const st = this.gd.stage(cfg.stageId);
      if (!st) return fail(ERR.BAD_MSG, 'unknown stage');
      sb.stageId = cfg.stageId; this.stageId = cfg.stageId; this.stage = st;
      sb.entered = true; // the 开局 picks the map (普通/首领战场) first; that choice enters the sandbox proper
    }
    if (cfg.mode !== undefined) sb.mode = cfg.mode;
    if (cfg.hpMul !== undefined) sb.hpMul = Math.max(1, Math.min(SANDBOX_HP_MUL_MAX, Number(cfg.hpMul) || 1));
    if (cfg.layerCap !== undefined) { sb.layerCap = Math.max(0, Math.min(9999, cfg.layerCap | 0)); this.layerCap = sb.layerCap; }
    if (cfg.bossId !== undefined) {
      if (cfg.bossId && !this.gd.boss(cfg.bossId)) return fail(ERR.BAD_MSG, 'unknown boss');
      sb.bossId = cfg.bossId || null;
    }
    if (cfg.enemies !== undefined) {
      const list = [];
      for (const e of cfg.enemies) {
        if (!this.gd.enemy(e.key)) return fail(ERR.BAD_MSG, 'unknown enemy');
        if (e.count > 0) list.push({ key: e.key, count: Math.min(999, e.count | 0) });
        if (list.length >= SANDBOX_MAX_ENEMY_SLOTS) break;
      }
      sb.enemies = list;
    }
    // 数值: set each 羁绊's layer count directly (sandbox testing). Bypasses addLayers' cap/requireActive — it SETS.
    if (cfg.bonds !== undefined && ps && ps.alive && !ps.isBot && !ps.left) {
      for (const [bondId, n] of Object.entries(cfg.bonds)) {
        if (!this.gd.bond(bondId)) continue;
        ps.layers[bondId] = Math.max(0, Math.min(SANDBOX_MAX_LAYERS, Number(n) | 0));
      }
      ps.recompute();
      this._privDirty.add(ps);
    }
    this._applyBossPreview();                          // 首领场: selecting a boss jumps the prep view to the big map
    this.markPublic();
    return OK;
  }

  /** g.sandboxGive { kind, id } — 控制台买全部: grant one operator / equipment straight to the seat (no slot/pool/funds). */
  sandboxGive(ps, kind, id) {
    if (!this.sandbox) return fail(ERR.WRONG_PHASE);
    if (!ps || !ps.alive || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    try {
      if (kind === 'chess') {
        const rec = this.gd.chess(id);
        if (!rec || rec.visible === false) return fail(ERR.BAD_TARGET, 'not a buyable operator');
        ps.acquireChess(id, { source: 'sandbox' });
      } else {
        if (!this.gd.item(id)) return fail(ERR.BAD_TARGET, 'unknown equipment');
        ps.acquireItem(id, { source: 'sandbox' });
      }
    } catch (e) { this.reportError('sandboxGive', e); return fail(ERR.INTERNAL); }
    this._privDirty.add(ps);
    return OK;
  }

  /** g.sandboxStart {} — run ONE battle from the current config (a custom normal wave, or the chosen boss's field). */
  sandboxStart() {
    if (!this.sandbox || this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    const sb = this.sandbox;
    if (!this.stageId) return fail(ERR.BAD_MSG, 'no map');
    if (sb.mode === 'boss') {
      if (!sb.bossId) return fail(ERR.BAD_MSG, 'no boss');
      const rec = this.gd.boss(sb.bossId);
      const hidden = !!rec.hidden;
      if (hidden) this.hiddenBossId = sb.bossId; else this.bossId = sb.bossId;
      const tr = rec.templates && rec.templates[this.modeId] && rec.templates[this.modeId].round;
      this.round = Number.isInteger(tr) ? tr : (hidden ? 15 : 14);
      this.bossWaves = null;
      // 双人首领战场: a sandbox boss plays the PAIR (non-_s) layout even though the match is solo (author 2026-10-11)
      this.sandboxForcePair = true;
      this.startFinalAssault(hidden);
      return OK;
    }
    if (!sb.enemies.length) return fail(ERR.BAD_MSG, 'no enemies');
    this.round = 1;
    this.wave = this._sandboxWave();
    this.startCombat();
    return OK;
  }

  /**
   * g.sandboxExit {} — leave a running battle and go back to 沙盒准备 (the author: "战斗开始后也能随时退出战斗回准备
   * 阶段"). Cancels the field, drops the shared boss pool / parts, and re-enters 沙盒准备. A no-op while already in PREP.
   */
  sandboxExit() {
    if (!this.sandbox) return fail(ERR.WRONG_PHASE);
    if (this.phase === PHASE.PREP) return OK;
    try { this._stopClientCombat(); } catch (e) { this.reportError('sandboxExit', e); }
    this.deadline = 0;
    this.overtimeAt = 0;
    this.bossOvertimeAfterReal = null;
    this.bossPool = null;
    this.bossParts = null;
    this.bossWaves = null;
    this.runner = null;
    if (Array.isArray(this.fields)) for (const f of this.fields) f.live = false;
    this.enterSandbox();
    return OK;
  }

  /**
   * g.sandboxClear { area:'bench'|'board' } — clear the bench (hand + temp) or the deployed board at once (author
   * 2026-10-11). Detaches every piece of that area (with its summoned tokens / equipped items, no refunds).
   */
  sandboxClear(ps, area) {
    if (!this.sandbox || this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps || !ps.alive || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    const drop = (loc) => {
      const piece = loc.piece;
      ps._detach(loc);
      if (typeof ps.removeTokensOf === 'function') ps.removeTokensOf(piece.uid);
      if (piece.kind === 'chess' && typeof ps.returnCopies === 'function') ps.returnCopies(piece); // pool accounting
    };
    if (area === 'board') {
      for (const [key, piece] of [...ps.board]) drop({ piece, area: 'board', key });
    } else {
      for (let i = 0; i < ps.hand.length; i++) if (ps.hand[i]) drop({ piece: ps.hand[i], area: 'hand', idx: i });
      for (let i = 0; i < ps.temp.length; i++) if (ps.temp[i]) drop({ piece: ps.temp[i], area: 'temp', idx: i });
    }
    ps.recompute();
    this._privDirty.add(ps);
    return OK;
  }

  /**
   * The custom normal wave: one spawn per chosen enemy (route 0, hpMul ×) on the chosen map. Routes come from the mode's
   * round-1 template (a standard spawn→goal lane list that every active stage carries).
   */
  _sandboxWave() {
    const sb = this.sandbox;
    const rc = this.gd.roundCfg(1);
    const tpl = rc && typeof rc.template === 'string' ? this.gd.wave(rc.template) : null;
    const routes = tpl && Array.isArray(tpl.routes) ? tpl.routes : [];
    const mods = { hpMul: sb.hpMul, atkMul: 1, speedMul: 1 };
    const spawns = sb.enemies.filter((e) => e.count > 0).map((e) => ({
      time: 1, enemyKey: e.key, count: e.count, interval: e.count > 1 ? 1 : 0, routeIndex: 0, mods: { ...mods },
    }));
    return {
      templateId: null, spawns, routes, extraRoutes: [], timeLimit: this.gd.combatTimeLimit(1) || 120,
      overrides: {}, pick: null, entries: { ground: null, fly: null }, actions: [],
    };
  }
}
