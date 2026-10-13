// server/match/match/clientCombat.js — Match methods: client-side combat bookkeeping (DESIGN §14) — field records (the
// JSON BattleSpec + the authority / result state), spec battles on the server, the field clock, the authority (the
// lowest connected seat), b.start per recipient, result deadlines and releases, server runs (headless slices,
// takeovers), field completion → the phase end, and the timers of it all.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE } from '../../../shared/constants.js';
import { DeadBattle, syntheticResult, RESULT_GRACE_MS, HARD_CAP_SECONDS, HeadlessJob, FIELD_SILENCE_MS, FIELD_SILENCE_CHECK_MS } from '../fields.js';
import { buildBattleSpec, createBattleFromSpec } from '../../sim/spec.js';

export class MatchClientCombat {
  /** Stop every client-combat timer and the headless pacer (phase end, finish, dispose). */
  _stopClientCombat() {
    if (this._silenceTimer) { this.cancel(this._silenceTimer); this._silenceTimer = null; }
    if (this._progressTimer) { this.cancel(this._progressTimer); this._progressTimer = null; }
    if (this._bossClock) { this.cancel(this._bossClock); this._bossClock = null; }
    this._bossClockOn = false;
    // a pending throttled boss refresh: the merged team LP is written back now (m.result / settlement read it)
    if (this._bossPubTimer) { this.cancel(this._bossPubTimer); this._bossPubTimer = null; this._syncTeamLp(); this.markPublic(); }
    this._clearPause();
    if (this._poolTimer) { this.cancel(this._poolTimer); this._poolTimer = null; }
    if (this.pacer) { try { this.pacer.stop(); } catch { /* ignore */ } this.pacer = null; }
    for (const f of this.fields) this._clearFieldTimers(f);
  }

  _clearFieldTimers(f) {
    if (!f || !f.cc) return;
    for (const k of ['deadlineTimer', 'doneTimer', 'waitTimer', 'sliceTimer']) if (f[k]) { this.cancel(f[k]); f[k] = null; }
    f.job = null;
  }

  /** A client-combat field record: the JSON BattleSpec of its Battle options plus the authority / result state. */
  _ccField({ fieldId, kind, players, opts, boss = null }) {
    const seq = `${this.battlePrefix}.${this.round}.${++this._battleSeq}`;
    // protocol ids are ≤ 64 chars (shared/protocol.js isId): the field id is informational, the sequence is unique
    const battleId = seq.length + 1 + String(fieldId).length <= 64 ? `${seq}.${fieldId}` : seq;
    const spec = buildBattleSpec({ ...opts, battleId, fieldId, kind, content: this.battleContent, boss });
    let total = 0;
    for (const x of spec.spawns) if (x && x.tag !== 'boss' && x.tag !== 'part') total += Math.max(1, Math.floor(Number(x.count) || 1));
    return {
      cc: true, fieldId, kind, players: players.slice(), battleId, spec, battle: null, live: true, done: false,
      mode: null, authority: null, startAt: this.sched.now(), result: null, resultSource: null, timeline: null, endGt: null,
      progress: { gt: 0, killed: 0, total, leaks: 0, done: false }, lastProgressAt: this.sched.now(),
      bossAcked: 0, bossBy: {}, lpAcked: 0, lpCum: 0, deadlineTimer: null, doneTimer: null, waitTimer: null,
      // boss fields: the latest client reports (re-credited as the plausibility budget grows), the server run's
      // CreditPool, humans demoted for an implausible result (never the authority of this field again), a 'cleared'
      // b.result waiting for the budget to credit the pool it emptied (`heldResult`, _onResult)
      bossReported: null, lpReported: 0, credit: null, demoted: new Set(), heldResult: null,
    };
  }

  /** A battle built from a spec on the server (headless / takeover / verification); never throws. */
  _specBattle(spec, { sharedBoss = null, sharedParts = null } = {}) {
    try {
      // server-run boss fields use the match's REAL shield pools (this.bossParts) so their damage credits the shared map
      return createBattleFromSpec(spec, this.ds, { BattleClass: this.BattleClass, sharedBoss, sharedParts: sharedParts || this.bossParts || null, logger: this.log, recordEvents: false });
    } catch (e) {
      this.reportError(`battle ${spec && spec.fieldId} construct`, e);
      return new DeadBattle({ fieldId: spec && spec.fieldId, kind: spec && spec.kind, players: (spec && spec.players) || [], rect: spec && spec.rect, stageId: spec && spec.stageId }, 'forced');
    }
  }

  /** Game seconds a field has run (its clock; a finished field: its final time). */
  _fieldElapsed(f) {
    if (f.done && f.result && Number.isFinite(f.result.time)) return f.result.time;
    const gt = Math.max(0, ((this._clockNow() - f.startAt) / 1000) * this.gameSpeed);
    if (f.endGt != null) return Math.min(gt, f.endGt);
    const lim = f.spec && f.spec.timeLimit > 0 ? f.spec.timeLimit : HARD_CAP_SECONDS;
    return Math.min(gt, lim);
  }

  /** The connected human who simulates a field: lowest seat among its players (normal: the owner). */
  _authorityFor(f, exclude = null) {
    let best = null;
    for (const pid of f.players) {
      if (pid === exclude || (f.demoted && f.demoted.has(pid))) continue;
      const ps = this.players.get(pid);
      if (!ps || ps.isBot || ps.left || !ps.connected) continue;
      if (!best || ps.seat < best.seat) best = ps;
    }
    return best ? best.playerId : null;
  }

  /** b.start of a field for one recipient (`watch`: not a player of the field). */
  _startMsg(f, pid, { watch = false } = {}) {
    return {
      t: 'b.start', battleId: f.battleId, fieldId: f.fieldId, kind: f.kind,
      spec: this.spectators.has(pid) ? this._spectatorSpec(f) : f.spec,
      authoritative: !!(!f.done && f.mode === 'client' && f.authority === pid && !watch),
      startAt: f.startAt, serverNow: this.sched.now(), elapsed: Math.round(this._fieldElapsed(f) * 1000) / 1000,
      speed: this.gameSpeed, watch: !!watch, done: !!f.done,
    };
  }

  _sendStart(pid, f, opts = {}) {
    const ps = this.players.get(pid) || this.spectators.get(pid);
    if (!ps || ps.isBot || ps.left || !ps.connected) return false;
    return this.sendTo(pid, this._startMsg(f, pid, opts));
  }

  /** Give every field its authority (a connected human) or run it on the server. */
  _launch(fields) {
    const now = this.sched.now();
    this.fields = fields;
    for (const f of fields) { f.startAt = now; f.lastProgressAt = now; }
    for (const f of fields) {
      const auth = this._authorityFor(f);
      if (auth) this._assignClient(f, auth);
      else this._runOnServer(f, 'no-human');
    }
    this._armSilenceWatch();
  }

  _assignClient(f, pid) {
    f.mode = 'client';
    f.authority = pid;
    f.lastProgressAt = this.sched.now();
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    if (f.kind === 'boss' || f.kind === 'hidden') return; // the pool / team LP / silence watchdog end those
    if (this.paused) { f.rearmDeadline = true; return; }
    this._armDeadline(f);
  }

  /** A client field's result deadline: its time limit on the field clock + RESULT_GRACE_MS (then the server takes over). */
  _armDeadline(f) {
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    const lim = f.spec.timeLimit > 0 ? f.spec.timeLimit : 60;
    const at = f.startAt + Math.round((lim / this.gameSpeed) * 1000) + RESULT_GRACE_MS;
    f.deadlineTimer = this.later(Math.max(0, at - this.sched.now()), () => {
      f.deadlineTimer = null;
      if (f.done || f.mode !== 'client') return;
      this._runOnServer(f, 'timeout');
    });
  }

  /** A server-run normal / 联防 field's result is released at the battle's natural end on the field clock. */
  _armRelease(f) {
    if (f.doneTimer) { this.cancel(f.doneTimer); f.doneTimer = null; }
    if (f.done || f.result == null) return;
    if (this.paused) { f.rearmRelease = true; return; }
    const doneAt = f.startAt + Math.round(((f.endGt || 0) / this.gameSpeed) * 1000);
    const wait = this.sched.instant ? 0 : Math.max(0, doneAt - this.sched.now());
    f.doneTimer = this.later(wait, () => { f.doneTimer = null; this._fieldDone(f); });
  }

  /**
   * The server simulates a field: normal / 联防 headlessly at once (the result is released at the battle's natural end
   * on the field's clock, so the teammates' progress UI and the round pacing stay as if it ran live); boss fields in
   * real time on the pacer (they share the pool), fast-forwarded to the field's clock on a takeover. On a real server
   * with a sim pool (this build) the normal / 联防 run happens on a worker thread instead (_runOnServerPool).
   */
  _runOnServer(f, reason) {
    const prev = f.mode === 'client' ? f.authority : null;
    if (prev) {
      this.verifyStats.takeovers++;
      this.log.info?.(`[match ${this.roomCode}] ${f.fieldId} R${this.round}: server takeover from ${prev} (${reason})`);
    }
    f.mode = 'server';
    f.authority = null;
    if (f.deadlineTimer) { this.cancel(f.deadlineTimer); f.deadlineTimer = null; }
    // the former authority (still online after a timeout / an invalid result) stops reporting and keeps its view
    if (prev) this.sendTo(prev, { t: 'b.end', battleId: f.battleId, fieldId: f.fieldId, reason: 'takeover' });
    if (f.kind === 'boss' || f.kind === 'hidden') { this._bossServerRun(f); return; }
    // normal / 联防 无人战场独立、可由 spec 重建、不碰共享血池 → 交给 worker 池跑在别的核上（多核）。虚拟时间（测试 /
    // 工具）与未启用池时保持原地跑；池任务失败同样回退原地（_runOnServerPool）。
    if (this.simPool && !this.sched.virtual) this._runOnServerPool(f);
    else this._runOnServerLocal(f);
    this._armProgressTicker();
  }

  /** The pool fallback / default: step the spec battle in-process (one-shot, or wall-clock slices on a real host). */
  _runOnServerLocal(f) {
    const job = new HeadlessJob(this._specBattle(f.spec), { onError: (e) => this.reportError(`field ${f.fieldId} step`, e), players: f.players });
    f.job = job;
    f.battle = job.battle;
    f.timeline = job.timeline; // grows while the job runs (the teammates' progress UI reads it on the field clock)
    if (f.sliceTimer) { this.cancel(f.sliceTimer); f.sliceTimer = null; }
    const complete = () => {
      if (f.job !== job || f.done) return;
      f.job = null;
      const run = job.output();
      f.battle = run.battle;
      f.result = run.result;
      f.resultSource = 'server';
      f.timeline = run.timeline;
      f.endGt = Number(run.battle.time) || 0;
      this._armRelease(f);
    };
    if (!Number.isFinite(this.headlessSliceMs)) {
      job.run(Infinity);
      complete();
    } else {
      // a real host: wall-clock-bounded slices in callbacks of their own (3 bot fields at combat start would otherwise
      // block the event loop for ~0.2–0.5 s here, seconds on a low-power mini PC)
      const slice = () => {
        f.sliceTimer = null;
        if (f.job !== job || f.done) return;
        if (job.run(this.headlessSliceMs)) complete();
        else f.sliceTimer = this.later(0, slice);
      };
      f.sliceTimer = this.later(0, slice);
    }
  }

  /**
   * The worker-pool run (production, real time): the field's spec battle is stepped to its end on another core
   * (server/match/simPool.js), which streams its timeline back for the teammates' waiting UI and the final result. The
   * field carries no live `battle` object (it lives in the worker); everything the match reads about it comes from
   * `f.timeline` / `f.result` — the same values an in-process run produces. A pool failure falls back to
   * _runOnServerLocal, so the field always resolves.
   */
  _runOnServerPool(f) {
    const token = {}; // identity token, standing in for the local path's HeadlessJob handle (f.job comparisons)
    f.job = token;
    f.battle = null;
    f.timeline = [];
    if (f.sliceTimer) { this.cancel(f.sliceTimer); f.sliceTimer = null; }
    const fallback = (why) => {
      this.log.warn?.(`[match ${this.roomCode}] ${f.fieldId}: sim pool ${why} — running in process`);
      this._runOnServerLocal(f);
    };
    let promise;
    try {
      promise = this.simPool.run({ spec: f.spec, players: f.players }, {
        onProgress: (tl) => { if (f.job === token && !f.done && Array.isArray(tl)) f.timeline = tl; },
      });
    } catch (e) {
      if (f.job === token && !f.done) { f.job = null; fallback(`threw (${(e && e.message) || e})`); }
      return;
    }
    promise.then((run) => {
      if (f.job !== token || f.done) return;
      f.job = null;
      f.result = run.result;
      f.resultSource = 'server';
      f.timeline = run.timeline || f.timeline;
      f.endGt = Number(run.time) || 0;
      this._armRelease(f);
    }, (e) => {
      if (f.job !== token || f.done) return;
      f.job = null;
      fallback(`failed (${(e && e.message) || e})`);
    });
  }

  /** m.public ~1 Hz while server-run fields progress along their timelines. */
  _armProgressTicker() {
    if (this._progressTimer || this.sched.instant) return;
    const tick = () => {
      this._progressTimer = null;
      if (!this.fields.some((f) => f.cc && f.mode === 'server' && !f.done && f.timeline)) return;
      this.markPublic();
      this._progressTimer = this.later(1000, tick);
    };
    this._progressTimer = this.later(1000, tick);
  }

  /** A field has its final result. */
  _fieldDone(f) {
    if (!f || f.done) return;
    f.done = true;
    f.live = false;
    this._clearFieldTimers(f);
    if (!f.result) f.result = syntheticResult(f.players, { bossBy: f.bossBy });
    f.progress.done = true;
    this.markPublic();
    this._maybeFieldsDone();
  }

  _maybeFieldsDone() {
    if (!this.fields.length || this.fields.some((f) => f.cc && !f.done)) return;
    if (!this.fields.every((f) => f.cc)) return;
    if (this.phase === PHASE.COMBAT) this._finishCombat((f) => f.result);
    else if (this.phase === PHASE.UNITE) this._finishUniteClient();
    else if (this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE) this._finishFinal(this.phase === PHASE.HIDDEN_CORE, (f) => f.result);
    else if (this.phase === PHASE.DUMMY) this._dummyDone(); // 无尽模式 打桩: the 30 s dummy fields all reported
  }

  /**
   * The silence guard of normal / 联防 client fields (FIELD_SILENCE_MS): a healthy authority reports b.progress ~1 Hz
   * (public/js/battle/runner.js progress()), so no report for the whole window means its browser stalled — a backgrounded
   * tab the browser throttled, a wedged main thread, a wedged client. Boss fields are left to their own clock
   * (bossRounds.js _bossClockTick). Bounds the worst case the result deadline would otherwise let run for minutes, the
   * widened 联防's limit being several times the round limit (unitePhase.js _uniteLimit).
   */
  _armSilenceWatch() {
    if (this._silenceTimer || this.sched.instant) return;
    if (!this.fields.some((f) => f.cc && !f.done && f.mode === 'client' && f.kind !== 'boss' && f.kind !== 'hidden')) return;
    this._silenceTimer = this.later(FIELD_SILENCE_CHECK_MS, () => { this._silenceTimer = null; this._silenceTick(); });
  }

  _silenceTick() {
    if (this.phase === PHASE.LOBBY || this.phase === PHASE.RESULT) return;
    // solo pause (g.pause): the player's own browser is frozen on purpose — its silence is not a stall
    if (this.paused) { this._armSilenceWatch(); return; }
    const now = this.sched.now();
    for (const f of this.fields) {
      if (!f.cc || f.done || f.heldResult || f.mode !== 'client') continue;
      if (f.kind === 'boss' || f.kind === 'hidden') continue;
      if (now - f.lastProgressAt <= FIELD_SILENCE_MS) continue;
      this.log.info?.(`[match ${this.roomCode}] ${f.fieldId} R${this.round}: no progress from ${f.authority} for ${Math.round((now - f.lastProgressAt) / 1000)} s — handing the field over`);
      this._handover(f, 'silent');
    }
    this._armSilenceWatch();
  }

  /**
   * Hand a normal / 联防 client field to its next connected authority (whose replica is already running, so it just
   * becomes authoritative — share/protocol b.start `authoritative`), else run it on the server. Same shape as a boss
   * handover without the pool / demote bookkeeping (bossRounds.js _bossHandover).
   */
  _handover(f, why) {
    if (!f || f.done || f.mode !== 'client' || f.heldResult) return;
    const prev = f.authority;
    const next = this._authorityFor(f, prev);
    if (next) {
      f.authority = next;
      f.lastProgressAt = this.sched.now();
      this.verifyStats.takeovers++;
      this.log.info?.(`[match ${this.roomCode}] ${f.fieldId} R${this.round}: ${f.kind} field handed to ${next} (${why})`);
      if (prev) this.sendTo(prev, { t: 'b.end', battleId: f.battleId, fieldId: f.fieldId, reason: 'takeover' });
      this._sendStart(next, f);
      return;
    }
    this._runOnServer(f, why);
  }

  /** An authoritative human disconnected / left: normal & 联防 fields → server takeover; boss → the partner or the server. */
  _authorityLost(ps, why) {
    for (const f of this.fields) {
      if (!f.cc || f.done || f.mode !== 'client' || f.authority !== ps.playerId) continue;
      if (f.kind === 'boss' || f.kind === 'hidden') this._bossHandover(f, why);
      else this._runOnServer(f, why);
    }
  }
}
