// server/match/match/reroll.js — 重刷本局 (author 2026-10-13): a unanimously-agreed re-roll of the match's opening
// info (战场 stage / 阵营 factions / 领袖 boss / 禁用盟约·干员), keeping the room and each player's own loadout (DIY,
// loadout). Server-owned vote; while it is open the INFO_CHECK (简报) countdown is paused. Mirrors the reference
// remake's setupReroll.
//
//   g.rerollSetup            open the vote (INFO_CHECK, all humans connected, no vote open). The client shows the
//                            button to the host only; the server accepts any seated human.
//   g.rerollVote {id, agree} a voter agrees (unanimous → re-roll, revision++) or declines (vote cancelled, countdown back)
//   g.cancelReroll {id}      the starter cancels the vote
//
// State on the wire: m.public.rerollVote = { id, voters: [playerId], agreed: [playerId] } | null; m.public.setupRevision
// (bumped on every re-roll so clients re-key the setup panels). Installed on Match.prototype by server/match/Match.js.

import { PHASE, ERR } from '../../../shared/constants.js';
import { setupMatchWaves } from '../waves.js';
import { SharedPool, drawDisabledBonds } from '../pool.js';
import { OK, fail } from './common.js';

export class MatchReroll {
  /**
   * Roll (or re-roll) the per-match opening info. Called once from the Match constructor and again by 重刷本局. It draws
   * from this.rngSetup so a re-roll advances the same seeded stream; sandbox fixes the stage / boss by hand.
   */
  _rollSetup() {
    const setup = setupMatchWaves(this.gd, this.rngSetup);
    this.stageId = this.sandbox ? this.sandbox.stageId : setup.stageId;
    this.stage = this.stageId ? this.gd.stage(this.stageId) : null;
    this.factions = setup.factions;
    this.bossId = this.sandbox ? this.sandbox.bossId : setup.bossId;
    this.hiddenBossId = this.sandbox ? null : setup.hiddenBossId;
    const bans = drawDisabledBonds(this.gd, this.rngSetup, this.teamSize, this.noBondBan);
    this.disabledBonds = bans.drawn;
    this.staticInactiveBonds = bans.staticOff;
    this.bannedChess = bans.banned;
    this.pool = new SharedPool(this.gd, { banned: bans.banned, copyMul: this.poolCopyMul });
    // 自选编队: each human's slotted DIY pieces get their own stock — none for one whose bonds are all off this match.
    const off = new Set([...bans.drawn, ...bans.staticOff]);
    for (const ps of this.order) ps.initDiyStock(off);
  }

  /** 重刷本局: open the vote. INFO_CHECK only, no vote open, every human connected. */
  startRerollSetup(ps) {
    if (this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE);
    if (this.reroll) return fail(ERR.WRONG_PHASE, 'vote open');
    if (this.sandbox || this.endless) return fail(ERR.WRONG_PHASE, 'no reroll in this mode');
    if (!this.order.includes(ps) || ps.isBot || ps.left) return fail(ERR.BAD_TARGET, 'not a player');
    const voters = this.order.filter((p) => !p.isBot && !p.left).map((p) => p.playerId);
    if (voters.some((id) => { const p = this.players.get(id); return p && p.connected === false; })) {
      return fail(ERR.WRONG_PHASE, 'someone offline');
    }
    this.reroll = { id: `rr${++this._rerollSeq}`, voters, agreed: [ps.playerId], starter: ps.playerId };
    if (this.reroll.agreed.length >= this.reroll.voters.length) return this._applyReroll(); // 单人局: unanimous at once
    this.setDeadline(0); // pause the 简报 countdown while the vote runs
    this.markPublic();
    return OK;
  }

  /** A voter's answer. Unanimous agreement re-rolls the setup; a decline cancels the vote. */
  rerollVote(ps, id, agree) {
    const v = this.reroll;
    if (!v || v.id !== id) return fail(ERR.BAD_TARGET, 'no such vote');
    if (!v.voters.includes(ps.playerId)) return fail(ERR.BAD_TARGET, 'not a voter');
    if (agree) {
      if (!v.agreed.includes(ps.playerId)) v.agreed.push(ps.playerId);
      if (v.agreed.length >= v.voters.length) return this._applyReroll();
    } else {
      this.reroll = null;
      this._resumeInfoDeadline();
    }
    this.markPublic();
    return OK;
  }

  /** The starter cancels the vote (no re-roll); the countdown resumes. */
  cancelRerollSetup(ps, id) {
    const v = this.reroll;
    if (!v || v.id !== id) return fail(ERR.BAD_TARGET, 'no such vote');
    if (ps.playerId !== v.starter) return fail(ERR.BAD_TARGET, 'only the starter');
    this.reroll = null;
    this._resumeInfoDeadline();
    this.markPublic();
    return OK;
  }

  /** Unanimous → re-roll the opening info; bump revision so clients re-key; re-push public + every private. */
  _applyReroll() {
    this.reroll = null;
    // never re-roll out of the briefing (a stale vote that survived a phase change must not move the battlefield
    // under already-placed pieces — fuzz: 'chess on an illegal tile')
    if (this.phase !== PHASE.INFO_CHECK) { this.markPublic(); return OK; }
    this._rollSetup();
    // a new stage = a new deploy field: drop every player's cached deploy map so its next placement / eviction reads
    // the new terrain (otherwise a piece can be placed against the old stage's map and the invariant flags it illegal)
    for (const ps of this.order) ps.invalidateDeployMap();
    this.setupRevision = (this.setupRevision || 0) + 1;
    this.markPublic();
    for (const ps of this.order) this.markPrivate(ps);
    this._resumeInfoDeadline();
    return OK;
  }

  /** After the vote: if still in the 简报 and not everyone ready, restart the INFO_CHECK countdown (else advance). */
  _resumeInfoDeadline() {
    if (this.phase !== PHASE.INFO_CHECK) return;
    if (this.soloUntimed) return; // 单人 briefing is untimed
    if (this.order.every((p) => p.isBot || p.left || p.infoReady)) { this.maybeEndInfo(); return; }
    this.setDeadline(this.gd.timer('infoCheck'), () => this.enterBandDraft());
  }
}
