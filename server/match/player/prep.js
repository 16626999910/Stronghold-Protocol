// server/match/player/prep.js — PlayerState methods: the gate of every prep intent (_gate: alive, PREP, not ready),
// g.reward (a reward offer's pick), Ready (refused while temp holds pieces) and the resolution of the temp pieces due
// at a prep's deadline.
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { ERR, PHASE } from '../../../shared/constants.js';
import { freeSlot } from '../board.js';
import { OK, fail } from './common.js';

export class PlayerPrep {
  _gate({ allowWhenReady = false } = {}) {
    if (!this.alive) return fail(ERR.ELIMINATED);
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (this.ready && !allowWhenReady) return fail(ERR.WRONG_PHASE, 'ready');
    return null;
  }

  /**
   * g.reward {idx}: the pick of the first queued offer (promotion reward, a strategy's special refresh, an item offer).
   * A pick is a 招募 like a purchase: a full regular hand refuses it, also when it would complete a merge (PRTS
   * 卫戍协议/帮助 §手牌区, see buy; GitHub #82).
   */
  pickReward(idx) {
    const g = this._gate(); if (g) return g;
    const offer = this.offers[0];
    if (!offer) return fail(ERR.BAD_TARGET, 'no reward');
    if (!Number.isInteger(idx) || idx < 0 || idx >= offer.slots.length) return fail(ERR.BAD_TARGET);
    const slot = offer.slots[idx];
    if (!slot || slot.sold) return fail(ERR.SOLD_OUT);
    const handFull = freeSlot(this.hand) < 0;
    if (slot.kind === 'item') {
      if (!this.gd.item(slot.id)) return fail(ERR.BAD_TARGET);
      // 装备库 (无尽狂潮): a reward item goes to the unbounded library, so a full hand never blocks it
      if (!this.m.endless && handFull) return fail(ERR.HAND_FULL);
    } else {
      const rec = this.gd.chess(slot.id);
      if (!rec || (rec.isDiy && !rec.diyFor)) return fail(ERR.BAD_TARGET);
      const base = this.gd.baseIdOf(slot.id);
      const need = rec.isGolden ? this.gd.goldenCopies : 1;
      const pool = this.poolOf(base); // the shared pool, or this player's 自选 stock
      if (pool.has(base) && pool.left(base) < need) return fail(ERR.SOLD_OUT);
      if (handFull) return fail(ERR.HAND_FULL);
    }
    const price = Number.isFinite(slot.price) && slot.price > 0 ? Math.trunc(slot.price) : 0;
    if (price > this.funds) return fail(ERR.NO_FUNDS);
    slot.sold = true;
    this.offers.shift();
    if (price > 0) this.spend(price);
    if (slot.kind === 'item') this.acquireItem(slot.id, { source: 'reward' });
    else this.acquireChess(slot.id, { source: 'reward' });
    this._afterSpend(price, 'reward');
    this.recompute();
    return OK;
  }

  setReady(on) {
    if (!this.alive) return fail(ERR.ELIMINATED);
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (on && !this.tempEmpty) return fail(ERR.TEMP_NOT_EMPTY);
    if (this.ready === !!on) return OK;
    this.ready = !!on;
    // un-ready: the player can act again, so what overflowed while it was ready is due at this prep's deadline
    if (!on) for (const p of this.temp) if (p && this.tempDue(p) > this.prepsEnded) this._tempDue.set(p.uid, this.prepsEnded);
    this.dirty();
    this.m.onReadyChanged(this);
    return OK;
  }

  /**
   * Prep deadline: every temp piece due at this prep (tempDue ≤ prepsEnded) is resolved — a chess is sold back (its
   * pool copies return, its summons are removed), a summon stack (token) is removed and comes back at the next round
   * start (startRound → grantTokensFor; PRTS "干员所属召唤物会于下一回合返还"). An ITEM is KEPT (this build's rule,
   * author 2026-10 — never silently destroyed): its due is pushed to the next prep, so it waits in the 临时整备区 —
   * recompute's _fillHandFromTemp moves it into a free hand slot the moment one appears (a sale / a deployment / using
   * another item), and Ready stays blocked (treat it like any overflow). Pieces that overflowed after the player could
   * no longer act on them (after Ready, at the prep end) are kept for the next prep too.
   */
  resolveTemp() {
    let changed = false;
    for (let i = 0; i < this.temp.length; i++) {
      const p = this.temp[i];
      if (!p || this.tempDue(p) > this.prepsEnded) continue;
      changed = true;
      if (p.kind === 'chess') {
        this.temp[i] = null;
        this._tempDue.delete(p.uid);
        this.removeTokensOf(p.uid);
        this.returnCopies(p);
      } else if (p.kind === 'item') {
        // 道具保留到下一回合（作者 2026-10：临时道具不再在休整期截止时静默销毁）
        this._tempDue.set(p.uid, this.prepsEnded + 1);
      } else {
        // a summon stack (token): removed here, re-granted by its owner at the next round start (grantTokensFor)
        this.temp[i] = null;
        this._tempDue.delete(p.uid);
      }
    }
    if (changed) this.recompute();
  }
}
