// server/match/match/spDraft.js — Match methods: the 机变 draft (SP_DRAFT: turn order, timers, AI picks, the card applied
// by choices.js applyCard) and the rolls the meta effects ask for — bounties (addBounty), item ids (rollItemId) and
// choices.json pools (rollPool).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { generateDraft, applyCard, bountyBattles, isMultiRoundBounty } from '../choices.js';
import { weightedPick } from '../waves.js';
import { botPickCard } from '../bot.js';
import { OK, fail, DELAYS } from './common.js';

/** 悬赏/机变 grouping (this build): at most this many seats share one 机变 card set — see enterSpDraft. */
const SP_GROUP_MAX = 4;
/**
 * Split `list` into balanced groups of at most `max`, as evenly as possible (10 seats / 4 ⇒ 4/3/3, 8 ⇒ 4/4, 6 ⇒ 3/3,
 * 7 ⇒ 4/3, 5 ⇒ 3/2). The fewest groups that hold the list, then the remainder spread one-per-group from the front.
 * @template T @param {T[]} list @param {number} max @returns {T[][]}
 */
function splitGroups(list, max) {
  const n = list.length;
  if (n <= max) return n ? [list.slice()] : [];
  const groups = Math.ceil(n / max);
  const base = Math.floor(n / groups);
  const rem = n % groups;
  const out = [];
  let at = 0;
  for (let g = 0; g < groups; g++) {
    const size = base + (g < rem ? 1 : 0);
    out.push(list.slice(at, at + size));
    at += size;
  }
  return out;
}

/**
 * The 机变 decision of one group: its seats, its own card set, a fresh taken map and its own clock. 组间并行 (this build):
 * every group is open at the same time and each carries its own `deadline` / `timer` (m.deadline publishes the earliest).
 */
class SpGroup {
  constructor(draft, order, groupIndex, groupCount) {
    this.cards = draft.cards;
    this.order = order.slice();
    this.idx = 0;
    this.picks = {};
    this.taken = {};
    // Safety net: if a family could not deal a card per seat, the "one copy of each card" exclusivity is lifted so the
    // last seat still gets one instead of ending the 机变 empty-handed (spAvailableCards).
    this.allowReuse = draft.cards.length < order.length;
    this.groupIndex = groupIndex;
    this.groupCount = groupCount;
    this.done = false;
    this.deadline = 0;
    this.timer = null;
    this.tick = 0;
  }
}

/**
 * The whole 机变 (all groups). `cards` / `order` / `picks` / `taken` / `idx` / `allowReuse` / `groupIndex` are live views
 * of the group picking now (the first unfinished one) so the single-group case reads exactly like the old flat `this.sp`;
 * `groups` holds every group (see views.js). Never constructed — only via Match.enterSpDraft.
 */
class SpState {
  constructor(family, name, desc, eventId, untimed, groups) {
    this.family = family;
    this.name = name;
    this.desc = desc;
    this.eventId = eventId;
    this.untimed = untimed;
    this.groups = groups;
  }
  /** The group whose card set the flat accessors expose: the first still picking, else the last (all done). */
  get primary() { return this.groups.find((g) => !g.done) || this.groups[this.groups.length - 1] || null; }
  get cards() { const g = this.primary; return g ? g.cards : []; }
  get order() { const g = this.primary; return g ? g.order : []; }
  get picks() { const g = this.primary; return g ? g.picks : {}; }
  get taken() { const g = this.primary; return g ? g.taken : {}; }
  get allowReuse() { const g = this.primary; return g ? g.allowReuse : false; }
  get idx() { const g = this.primary; return g ? g.idx : 0; }
  get groupIndex() { const g = this.primary; return g ? g.groupIndex : 0; }
  get groupCount() { return this.groups.length; }
  // the flat views are writable too (tests lay out a card set on the open draft: `m.sp.cards = […]`) — they write the
  // group picking now, exactly like the old flat `this.sp`
  set cards(v) { const g = this.primary; if (g) g.cards = v; }
  set order(v) { const g = this.primary; if (g) g.order = v; }
  set picks(v) { const g = this.primary; if (g) g.picks = v; }
  set taken(v) { const g = this.primary; if (g) g.taken = v; }
  set allowReuse(v) { const g = this.primary; if (g) g.allowReuse = v; }
  set idx(v) { const g = this.primary; if (g) g.idx = v; }
  set groupIndex(v) { const g = this.primary; if (g) g.groupIndex = v; }
}

export class MatchSpDraft {
  /**
   * 悬赏/机变 grouping (this build): a 机变 family yields ~6 cards, so a roster bigger than that would leave the extra
   * seats with nothing to pick ("悬赏决策六个选完就没有了"). The seats are split into balanced groups of ≤ SP_GROUP_MAX (4)
   * — 10 seats → 4/3/3 — each run through its OWN card set (the same family), so every seat picks one card.
   * 组间并行 (this build): all groups open AT ONCE and pick on their own clocks — no group waits for the previous one to
   * finish ("不用一组选完再进下一组"). Within a group the seats still take their turn one by one; each card is held by
   * one picker of that group.
   */
  enterSpDraft() {
    const alive = this.alivePlayers();
    if (!alive.length) { this.enterPrep(); return; }
    const ids = alive.map((p) => p.playerId);
    this.phase = PHASE.SP_DRAFT;
    this.sp = null;
    let groups;
    let drafts;
    if (ids.length <= SP_GROUP_MAX) {
      // upstream parity: the family's cards are drawn BEFORE the co-op turn order is shuffled (the RNG order of a
      // single-group 机变 must not change — balance and the deterministic tests depend on it)
      const draft = generateDraft(this.gd, this.rngDraft, this.round, { stageId: this.stageId, bondAvailable: (bondId) => this.bondLive(bondId) });
      if (!draft) { this.enterPrep(); return; }
      if (!this.isSolo) this.rngDraft.shuffle(ids);
      groups = [ids.slice()];
      drafts = [draft];
    } else {
      if (!this.isSolo) this.rngDraft.shuffle(ids);
      groups = splitGroups(ids, SP_GROUP_MAX);
      drafts = [];
      // groups after the first re-use the first group's family — one 机变 decision (悬赏 / 补给=装备 / 战术=效果) run per
      // group with fresh cards, never a different family per group. Drawn here up front (same RNG order as the old
      // sequential version): group 0's family is read first, then every other group forces it.
      let family = null;
      for (let i = 0; i < groups.length; i++) {
        const d = generateDraft(this.gd, this.rngDraft, this.round, { stageId: this.stageId, bondAvailable: (bondId) => this.bondLive(bondId), family });
        if (!d) { groups.length = i; break; }
        if (i === 0) family = d.family;
        drafts.push(d);
      }
    }
    if (!drafts.length) { this.enterPrep(); return; }
    const g0 = drafts[0];
    this.sp = new SpState(g0.family, g0.name, g0.desc, g0.eventId, this.soloUntimed,
      drafts.map((d, i) => new SpGroup(d, groups[i], i, drafts.length)));
    // every group starts its first seat at once (组间并行)
    const gs = this.sp.groups;
    for (const g of gs) { if (this.phase !== PHASE.SP_DRAFT) break; this._spGroupAdvance(g); }
    this.markPublic();
  }

  /** The 机变 group a seat belongs to (null when the seat is not in the draft — e.g. eliminated mid-draft). */
  spGroupOf(pid) {
    for (const g of (this.sp && this.sp.groups) || []) if (g.order.includes(pid)) return g;
    return null;
  }

  /** The seat whose turn it is in group `g` (null once every seat of the group has picked). */
  spTurnOf(g) { return g ? (g.order[g.idx] ?? null) : null; }

  /**
   * The seat whose turn it is — of the group of `pid`, or of the group picking now when no pid is given (the flat view
   * the tests and the older single-group code read).
   * @param {string} [pid]
   */
  spTurn(pid) {
    if (!this.sp) return null;
    if (typeof pid === 'string') return this.spTurnOf(this.spGroupOf(pid));
    return this.spTurnOf(this.sp.primary);
  }

  /** Whether `pid` has already taken its card. */
  spPicked(pid) { const g = this.spGroupOf(pid); return !!(g && g.picks[pid] != null); }

  /**
   * The card indexes a group's current seat may pick: normally the not-yet-taken ones of that group's set; when the set
   * is smaller than the group (`allowReuse`) all of them. Defaults to the group picking now.
   * @param {SpGroup} [g]
   * @returns {number[]}
   */
  spAvailableCards(g) {
    const grp = g && Array.isArray(g.cards) ? g : (this.sp ? this.sp.primary : null);
    if (!grp) return [];
    if (grp.allowReuse) return grp.cards.map((c) => c.idx);
    return grp.cards.map((c) => c.idx).filter((i) => grp.taken[i] == null);
  }

  /** m.deadline = the earliest clock among the still-picking groups (0 ⇒ untimed / none). */
  _spSyncDeadline() {
    let min = 0;
    for (const g of (this.sp && this.sp.groups) || []) {
      if (!(g.deadline > 0)) continue;
      min = min === 0 ? g.deadline : Math.min(min, g.deadline);
    }
    this.deadline = min;
  }

  /**
   * Start (or move on to) group `g`'s current seat: skip seats already picked / gone, finish the group when none is
   * left. Arms the group's own clock (and a bot pick). The whole 机变 ends once no group has a seat left.
   */
  _spGroupAdvance(g) {
    if (!g || this.phase !== PHASE.SP_DRAFT) return;
    this.cancel(g.timer);
    g.timer = null;
    g.tick++;
    while (g.idx < g.order.length) {
      const ps = this.players.get(g.order[g.idx]);
      if (ps && ps.alive && g.picks[ps.playerId] == null) break;
      g.idx++;
    }
    const available = this.spAvailableCards(g);
    if (g.idx >= g.order.length || !available.length) {
      g.done = true;
      g.deadline = 0;
      this._spSyncDeadline();
      // the 机变 ends once no group has a seat left. Deferred one tick (like the old baton hand-off) so the just-finished
      // group's state is still readable when the last pick lands (m.sp is cleared only in finishSpDraft).
      if (((this.sp && this.sp.groups) || []).every((x) => x.done)) {
        this.later(0, () => { if (this.phase === PHASE.SP_DRAFT) this.finishSpDraft(); });
        return;
      }
      this.markPublic();
      return;
    }
    if (this.soloUntimed) {
      g.deadline = 0;
    } else {
      const secs = g.idx === 0 ? this.gd.timer('spFirst') : this.gd.timer('spTurn');
      const ms = this.scaled(secs * 1000);
      g.deadline = this.sched.now() + ms;
      const token = g.tick;
      g.timer = this.later(ms, () => {
        g.timer = null;
        if (this.phase !== PHASE.SP_DRAFT || token !== g.tick) return;
        const ps = this.players.get(this.spTurnOf(g));
        if (!ps) return;
        const avail = this.spAvailableCards(g);
        if (!avail.length) { this._spGroupAdvance(g); return; }
        this._applyCard(ps, avail[Math.floor(this.rngDraft() * avail.length)]);
      });
    }
    const cur = this.players.get(this.spTurnOf(g));
    if (cur && cur.botControlled) this.scheduleSpBot(g);
    this._spSyncDeadline();
    this.markPublic();
  }

  /** A seat came back / left while it held its group's turn: re-arm (skip it if it already departed). platform.js onLeave. */
  spResumeTurn(pid) {
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return;
    const g = this.spGroupOf(pid);
    if (g && this.spTurnOf(g) === pid) this._spGroupAdvance(g);
  }

  /** Let the bot pick for group `g`'s current seat (after the presentation delay). */
  scheduleSpBot(g) {
    if (!g || !g.cards) return;
    const token = g.tick;
    this.later(this.scaled(DELAYS.BOT_ACTION), () => {
      if (this.phase !== PHASE.SP_DRAFT || !this.sp || token !== g.tick) return;
      const ps = this.players.get(this.spTurnOf(g));
      if (!ps || !ps.botControlled) return;
      const avail = this.spAvailableCards(g);
      if (!avail.length) return;
      this._applyCard(ps, botPickCard(this, ps, g.cards, avail));
    });
  }

  pickCard(ps, idx) {
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    const g = this.spGroupOf(ps.playerId);
    if (!g) return fail(ERR.BAD_TARGET);
    if (g.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    if (this.spTurnOf(g) !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!Number.isInteger(idx) || idx < 0 || idx >= g.cards.length) return fail(ERR.BAD_TARGET);
    if (!g.allowReuse && g.taken[idx] != null) return fail(ERR.SOLD_OUT);
    this._applyCard(ps, idx);
    return OK;
  }

  _applyCard(ps, idx) {
    const g = this.spGroupOf(ps.playerId);
    if (!g || g.picks[ps.playerId] != null || (!g.allowReuse && g.taken[idx] != null)) return;
    const card = g.cards[idx];
    if (!card) return;
    g.picks[ps.playerId] = idx;
    g.taken[idx] = ps.playerId;
    try { applyCard(this, ps, card); } catch (e) { this.reportError(`applyCard ${card.id}`, e); }
    this.markPrivate(ps);
    this.markPublic();
    this._spGroupAdvance(g);
  }

  finishSpDraft() {
    if (this.phase !== PHASE.SP_DRAFT) return;
    for (const g of (this.sp && this.sp.groups) || []) this.cancel(g.timer);
    this.sp = null;
    this.enterPrep();
  }

  addBounty(ps, card) {
    if (!ps || !card || !this.gd.enemy(card.enemyKey)) return null;
    // a multi-round card lasts MULTI_ROUND_BOUNTY_BATTLES battles (choices.js; the user's call after playtest #6)
    const rounds = bountyBattles(card);
    const b = {
      id: `bounty:${this.nextUid()}`,
      card: { effectId: card.effectId ?? card.id ?? null, name: card.name ?? '悬赏', desc: card.desc ?? '', tier: card.tier ?? 1, coin: Math.max(0, Math.trunc(Number(card.coin) || 0)), payout: card.payout === 'perfect' ? 'perfect' : 'kill', rounds, multiRound: isMultiRoundBounty(card), enemyKey: card.enemyKey, count: Math.max(1, Math.min(20, Number.isInteger(card.count) ? card.count : 1)) }, // i18n-ignore: a data-less card's fallback name
      roundsLeft: rounds,
    };
    ps.bounties.push(b);
    ps.dirty();
    return b.id;
  }

  /** Random item id: a choices.json server pool ({ pool }), a tier, or ≤ maxTier shop-eligible items. */
  rollItemId({ pool = null, tier = null, maxTier = 6, shopLevel = 6 } = {}) {
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof pool === 'string' && Object.hasOwn(pools, pool) ? pools[pool] : null;
    const rng = this.rngMeta;
    const tierList = (lo, hi) => { const out = []; for (let t = lo; t <= hi; t++) for (const id of this.gd.shopItemsByTier[t] || []) out.push(id); return out; };
    if (p && p.kind === 'equip') {
      if (Array.isArray(p.weighted) && p.weighted.length) {
        const pairs = p.weighted.filter((x) => Array.isArray(x) && this.gd.item(x[0]));
        let total = 0;
        for (const [, w] of pairs) total += Math.max(0, Number(w) || 0);
        let r = rng() * total;
        for (const [id, w] of pairs) { r -= Math.max(0, Number(w) || 0); if (r < 0) return id; }
        return pairs.length ? pairs[pairs.length - 1][0] : null;
      }
      if (Array.isArray(p.items) && p.items.length) {
        const items = p.items.filter((id) => this.gd.item(id));
        return items.length ? items[Math.floor(rng() * items.length)] : null;
      }
      let list;
      if (Array.isArray(p.tiers) && p.tiers.length) list = p.tiers.flatMap((t) => this.gd.shopItemsByTier[t] || []);
      else list = tierList(1, p.maxTier === 'shopLevel' ? Math.max(1, Math.min(6, shopLevel)) : 6);
      return list.length ? list[Math.floor(rng() * list.length)] : null;
    }
    const list = Number.isInteger(tier) ? tierList(tier, tier) : tierList(1, Math.max(1, Math.min(6, maxTier)));
    return list.length ? list[Math.floor(rng() * list.length)] : null;
  }

  /**
   * Roll a choices.json pool (ctx.rollPool). Equip pools → rollItemId. Chess pools: an `items` (uniform) or `weighted`
   * list — only chess with a free pool copy (or outside the pool) qualify — else a copy-weighted draw from the shared
   * pool filtered by `tier` / `minTier` / `maxTier` (number or 'shopLevel') / `bond`; `golden: true` yields the elite id.
   * `extra` (the drawing player's 自选 stock, player/diy.js diyStockEntries) joins that shared-pool draw, `chessOf` reads the
   * bonds (the player's data view: a slotted slot's operator) — 0.2.0 WE2.
   * @returns {{ kind: 'item'|'chess', id: string, golden?: boolean } | null}
   */
  rollPool(poolId, { shopLevel = 6, extra = null, chessOf = null } = {}) {
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof poolId === 'string' && Object.hasOwn(pools, poolId) ? pools[poolId] : null;
    if (!p || typeof p !== 'object') return null;
    const lvl = Math.max(1, Math.min(6, Number.isInteger(shopLevel) ? shopLevel : 6));
    if (p.kind === 'equip') {
      const id = this.rollItemId({ pool: poolId, shopLevel: lvl });
      return id ? { kind: 'item', id } : null;
    }
    if (p.kind !== 'chess') return null;
    const rng = this.rngMeta;
    const free = (id) => {
      if (typeof id !== 'string' || !this.gd.chess(id)) return false;
      const base = this.gd.baseIdOf(id);
      return !this.pool.has(base) || this.pool.left(base) > 0;
    };
    let id = null;
    if (Array.isArray(p.weighted) && p.weighted.length) {
      const pairs = p.weighted.filter((x) => Array.isArray(x) && free(x[0]));
      id = pairs.length ? weightedPick(rng, pairs) : null;
    } else if (Array.isArray(p.items) && p.items.length) {
      const list = p.items.filter(free);
      id = list.length ? list[Math.floor(rng() * list.length)] : null;
    } else {
      const maxTier = p.maxTier === 'shopLevel' ? lvl : Number.isInteger(p.maxTier) ? p.maxTier : 6;
      const minTier = Number.isInteger(p.minTier) ? p.minTier : 1;
      const bond = typeof p.bond === 'string' ? p.bond : null;
      const recOf = typeof chessOf === 'function' ? chessOf : (cid) => this.gd.chess(cid);
      id = this.pool.roll(rng, {
        tier: Number.isInteger(p.tier) ? p.tier : null,
        maxTier,
        filter: (cid, e) => e.tier >= minTier && (!bond || (Array.isArray(recOf(cid)?.bonds) && recOf(cid).bonds.includes(bond))),
        extra,
      });
    }
    if (!id) return null;
    const golden = !!p.golden;
    return { kind: 'chess', id: golden ? this.gd.goldenIdOf(id) || id : id, golden };
  }
}
