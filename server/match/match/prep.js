// server/match/match/prep.js — Match methods: the PREP phase — its start (deferred item merges, onPrepStart), the AI
// seats' sliced preps (scheduleBotPrep: economy + layout, rehearsal, Ready), Ready and the deadline, and its end
// (onPrepEnd, PlayerState.endPrep, then COMBAT or the Final Assault / Hidden Core).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ENDLESS } from '../../../shared/constants.js';
import { botPrepBeginSteps, botPrepEndSteps } from '../bot.js';
import { hiddenLayerStats } from '../finalAssault.js';
import { DELAYS } from './common.js';

export class MatchPrep {
  enterPrep() {
    this.phase = PHASE.PREP;
    this.sp = null;
    const alive = this.alivePlayers();
    for (const ps of alive) {
      ps.ready = false;
      // Items gained as the previous prep ended waited unmerged (acquireItem deferMerge). Merge them now, before
      // this prep's onPrepStart grants and before the player acts — not in endPrep, which runs in the same prep
      // that granted them and would take an equipped copy off for the fight about to start.
      ps.checkItemMerges();
      ps.recompute();
      this.dispatch(ps, 'onPrepStart', { round: this.round });
      ps.recompute();
    }
    // solo / single-human matches: untimed (soloUntimed); co-op: the round's prepTime
    const secs = this.soloUntimed ? null : this.gd.prepTime(this.round);
    this.setDeadline(secs, () => this.prepDeadline());
    let i = 0;
    for (const ps of alive) if (ps.botControlled) this.scheduleBotPrep(ps, i++);
    this.markPublic();
    this.maybeEndPrep();
  }

  /**
   * The bot plays a prep in three stages, every one in slices of ≤ botSliceMs wall-clock ms (one scheduler callback
   * each, so other rooms' battles and every player's requests keep flowing): economy + the default layout
   * (bot.js botPrepBeginSteps — shop decisions and layout planning, 50–120 ms late in a 4-bot match), the layout
   * rehearsal (whole simulated battles, 0.2–1 s of CPU per bot late in a match), then botPrepEndSteps (the rehearsed
   * layout, temp, Ready). The step generators run the same actions in the same order as the one-shot routine (same
   * rng draws, same decisions); in virtual time (botSliceMs unbounded) each stage runs at once. The prep ending first
   * (deadline) or a newer schedule for the seat drops the job (a step never leaves a transient board behind).
   */
  scheduleBotPrep(ps, i = 0) {
    const round = this.round;
    const token = (ps._botPrepToken = (ps._botPrepToken || 0) + 1);
    const valid = () => this.phase === PHASE.PREP && this.round === round && ps.alive && !ps.ready && ps.botControlled && ps._botPrepToken === token;
    const bounded = Number.isFinite(this.botSliceMs);
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    /** Step a generator until done or the slice budget is used; `then(value)` once it is done (null on an error). */
    const drive = (gen, label, then) => {
      const t0 = now();
      let r = null;
      try {
        do r = gen.next(); while (!r.done && !(bounded && now() - t0 >= this.botSliceMs));
      } catch (e) {
        this.reportError(`bot ${ps.playerId}${label}`, e);
        then(null);
        return;
      }
      if (r.done) { then(r.value); return; }
      this.later(0, () => { if (valid()) drive(gen, label, then); });
    };
    const ready = () => {
      if (!ps.ready) {
        ps.resolveTemp();
        ps.setReady(true);
      }
    };
    const end = (job) => {
      let gen = null;
      try { gen = botPrepEndSteps(this, ps, job); } catch (e) { this.reportError(`bot ${ps.playerId}`, e); }
      if (!gen) { ready(); return; }
      drive(gen, '', ready);
    };
    this.later(this.scaled(DELAYS.BOT_ACTION + i * DELAYS.BOT_STAGGER), () => {
      if (!valid()) return;
      drive(botPrepBeginSteps(this, ps), '', (job) => {
        if (!job) { end(null); return; }
        const slice = () => {
          if (!valid()) return;
          let done = true;
          try { done = job.run(this.botSliceMs); } catch (e) { this.reportError(`bot ${ps.playerId} rehearsal`, e); }
          if (done) { if (bounded) this.later(0, () => { if (valid()) end(job); }); else end(job); }
          else this.later(0, slice);
        };
        // bounded slices start in a callback of their own (the economy + default layout above already used this one)
        if (bounded) this.later(0, slice);
        else slice();
      });
    });
  }

  onReadyChanged(ps) {
    this.markPublic();
    void ps;
    this.maybeEndPrep();
  }

  maybeEndPrep() {
    if (this.phase !== PHASE.PREP || this._prepEndQueued) return;
    const allReady = () => { const alive = this.alivePlayers(); return alive.length > 0 && alive.every((p) => p.ready); };
    if (!allReady()) return;
    const round = this.round;
    this._prepEndQueued = true;
    // the prep deadline stays armed until the phase really ends: a player may un-ready before this runs
    this.later(0, () => {
      this._prepEndQueued = false;
      if (this.phase === PHASE.PREP && this.round === round && allReady()) this.endPrep();
    });
  }

  prepDeadline() {
    if (this.phase !== PHASE.PREP) return;
    for (const ps of this.alivePlayers()) {
      if (ps.ready) continue;
      ps.resolveTemp();
      ps.ready = true;
      // 准备阶段没准备的玩家：时间一到进入战斗时**自动由 AI 接管**（作者 2026-10-11）——席位照常被操作，玩家可随时
      // 用客户端的「AI 托管中 → 返回模拟」手动退出（g.autoplay { on: false }）。人机席位本来就不需要 ready。
      if (!ps.isBot && !ps.left && !ps.autoplay) ps.autoplay = true;
      ps.dirty();
    }
    this.markPublic();   // players[].autoplay 走 m.public
    this.endPrep();
  }

  endPrep() {
    if (this.phase !== PHASE.PREP) return;
    this.setDeadline(0);
    const alive = this.alivePlayers();
    for (const ps of alive) this.dispatch(ps, 'onPrepEnd', { round: this.round });
    for (const ps of alive) ps.endPrep();
    // 无尽狂潮 肉鸽: prep 结束仍未选的藏品/决策/专属候选 → 自动选第一个 (author 2026-10-12)
    if (this.endless && ENDLESS.RELIC_ENABLED) this.endlessResolveOffers();
    // 无尽模式 打桩环节: the prep on the boss map ended → run the 30 s 打桩 battle instead of a normal round
    if (this.endless && this.endless.dummy && this.endless.dummy.stage === 'prep') { this.startDummyBattle(); return; }
    const r = this.round;
    // 无尽模式 首领战: R20 起每 10 回合一次真正的 final-assault (打完继续下一回合; 首领已由 startRound 抽好)
    if (this.endless && this.endlessBossRound(r)) {
      this.hiddenLayerStats = hiddenLayerStats(this.gd, alive);
      this.startFinalAssault(false);
    } else if (!this.endless && r === this.gd.bossRound) {
      this.hiddenLayerSum = alive.reduce((s, p) => s + p.activatedLayers(), 0);
      // hidden-core gate inputs (finalAssault.hiddenLayerStats): read at the boss prep's end, before the fight
      this.hiddenLayerStats = hiddenLayerStats(this.gd, alive);
      this.startFinalAssault(false);
    } else if (!this.endless && r === this.gd.hiddenRound) {
      this.startFinalAssault(true);
    } else {
      this.startCombat();
    }
  }
}
