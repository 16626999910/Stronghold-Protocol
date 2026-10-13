// server/match/match/endless.js — Match methods: 无尽模式 (娱乐玩法, this build, author 2026-10-11). A fixed 4-player
// co-op 娱乐 match that skips the 14-round flow: normal rounds run forever (no boss round), the team fights on ONE
// shared LP pool fixed at 1, and when it is spent the run ends in a 打桩环节 (PHASE.DUMMY) whose cumulative team damage
// is the score. Numbers are re-scaled (enemies ×ENDLESS.ENEMY_MUL hp+atk, operators ×ENDLESS.UNIT_MUL hp+atk) and grow
// ×ENDLESS.GROWTH_STEP each round after ENDLESS.GROWTH_FROM; 盟约层数上限 ENDLESS.LAYER_CAP; 每回合资金 +2.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ENDLESS, GEO, ERR } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { freeSlot } from '../board.js';
import { FieldRunner } from '../fields.js';
import { weightedPick } from '../waves.js';
import { RELICS, GENERAL_DECISIONS, EXCLUSIVE_DECISIONS, aggregateStats, roundLayerGains, relicText, rollRelics, rollDecisions, rollExclusives, relicDefById, decisionDefByKey, exclusiveDefByBond } from './relics.js';
import { OK, fail } from './common.js';

/** 经济商店「装备」货位排除的鸡肋道具: 「装备时销毁，获得少量资金」类 (18 块买 1 块, 性价比极低)。 */
const ECON_JUNK_ITEMS = new Set([
  'chess_item_1_03_e_a', // 盟约之币: 销毁 +1 资金
  'chess_item_2_07_e_a', // 见钱眼开玩偶: 销毁, 下回合 +2 资金
  'chess_item_2_05_e_a', // 精打细算玩偶: 销毁, 之后每回合 +1 资金
  'chess_item_3_12_e_a', // 骑士储蓄罐: 销毁, 随机 +1~6 资金
]);

export class MatchEndless {
  /**
   * Enter 无尽模式 at round 1: no briefing / draft, shared LP = ENDLESS.START_LP. The stage is already drawn (Match
   * constructor, setupMatchWaves); startRound(1) plans the normal wave and walks ROUND_START → PREP through the usual
   * machinery (only the boss round is skipped later, prep.js endPrep). Called from platform.start() (endless).
   */
  enterEndless() {
    if (this.disposed || this.ended) return;
    // set BEFORE startRound: its shared-LP init only runs while teamLp is null, so the fixed 1 is kept (not the sum)
    this.teamLp = ENDLESS.START_LP;
    // 作者 2026-10-12: 删掉开局的「并发 3 选策略」draft —— 无尽不再发策略 (藏品/决策/专属盟约已承担构筑)，
    // 直接进战斗准备 (startRound(1))。开局每人 lp 固定 1 (原来由 draft 结束时设置)。
    for (const ps of this.alivePlayers()) { ps.lp = ENDLESS.START_LP; this.markPrivate(ps); }
    this.enterBattleCheck();
  }

  /** The enemy hp/atk growth multiplier of `round`: ×GROWTH_STEP per round after GROWTH_FROM (1 before). */
  endlessGrowth(round = this.round) {
    const over = Math.max(0, (Number(round) || 0) - ENDLESS.GROWTH_FROM);
    return ENDLESS.GROWTH_STEP ** over;
  }

  /**
   * Which round's composition a given endless round fields. Rounds with their own normal spawn template use it; rounds
   * beyond the last defined one (R14+ here — roundCfg is null past the boss round) **cycle** through the defined
   * compositions, newest → oldest, so no two consecutive rounds field the same wave. (Before it always returned the
   * last defined round, so R14, R15, R16 … all spawned the identical enemies — author 2026-10-12 「14 波以后一直出同一波怪」;
   * then the first cycle step re-fielded `last` right after round `last` — author 2026-10-12 「不要出现重复一波怪」.)
   * @param {number} [r] the round to plan (default this.round)
   */
  endlessWaveCfgRound(r = this.round) {
    const hi = Math.max(1, this.gd.lastRound || this.gd.bossRound || 15, this.gd.bossRound || 0);
    const rounds = [];
    for (let k = 1; k <= hi; k++) {
      const rc = this.gd.roundCfg(k);
      if (rc && typeof rc.template === 'string') rounds.push(k); // rounds that carry a NORMAL spawn template
    }
    if (!rounds.length) return 1;
    const last = rounds[rounds.length - 1];
    if (r <= last) return r; // R ≤ last defined round: its own composition
    // Past the defined rounds: descend last−1 → 1, then wrap to `last` (so the FIRST round past the defined ones does
    // NOT repeat the composition round `last` already used — author 2026-10-12 「不要出现重复一波怪」; the old
    // `rounds[(len − k%len) % len]` mapped R14 back to `last` = R13's wave, a consecutive duplicate).
    const k = r - last;
    const len = rounds.length;
    const idx = ((len - 1 - (k % len)) % len + len) % len;
    return rounds[idx];
  }

  /** 全部悬赏卡敌人 (去重): choices.json cards.bounty 的 enemyKey 池 (ENDLESS.BOUNTY_POOL 覆盖时直接用它)。 */
  endlessBountyPool() {
    if (Array.isArray(ENDLESS.BOUNTY_POOL)) return ENDLESS.BOUNTY_POOL;
    if (this._ebPool) return this._ebPool;
    const cards = (this.gd.choices && this.gd.choices.cards && this.gd.choices.cards.bounty) || [];
    const keys = [];
    const seen = new Set();
    for (const c of cards) {
      const k = c && c.enemyKey;
      if (typeof k === 'string' && this.gd.enemy(k) && !seen.has(k)) { seen.add(k); keys.push(k); }
    }
    this._ebPool = keys;
    return keys;
  }

  /**
   * 本轮的额外悬赏敌人卡 (author 2026-10-12): r ≥ ENDLESS.BOUNTY_FROM 起每一波额外加入
   * `1 + floor((r − BOUNTY_FROM) / BOUNTY_STEP)` 只随机悬赏卡敌人 —— 每 BOUNTY_STEP 回合多一只。全队本轮共用同一组、
   * 由 rngEndless 确定性抽取并缓存到本轮结束 (预览 / 各玩家的对战 / 机器人推演三处一致)。返回与 ps.bounties 同形的
   * `[{ id, card }]` (card 无 coin/payout → 只出怪、不掉落资金)。
   */
  endlessBountyCards(round = this.round) {
    if (!this.endless || !Number.isFinite(round) || !(round >= ENDLESS.BOUNTY_FROM)) return [];
    if (this._ebCards && this._ebCards.round === round) return this._ebCards.cards;
    const pool = this.endlessBountyPool();
    const n = 1 + Math.floor((round - ENDLESS.BOUNTY_FROM) / ENDLESS.BOUNTY_STEP);
    const cards = [];
    for (let i = 0; i < n && pool.length; i++) {
      const key = pool[Math.floor(this.rngEndless() * pool.length)];
      cards.push({ id: `eb:${round}:${i}`, card: { enemyKey: key, count: 1 }, roundsLeft: 99 });
    }
    this._ebCards = { round, cards };
    return cards;
  }

  /** 一名玩家某场作战的完整悬赏列表: 其策略悬赏 + 无尽模式的本轮额外悬赏敌人 (不改动 ps.bounties 本身)。 */
  endlessBountiesFor(ps) {
    const base = ps && Array.isArray(ps.bounties) ? ps.bounties : [];
    if (!this.endless) return base;
    const extra = this.endlessBountyCards();
    return extra.length ? [...base, ...extra] : base;
  }

  /**
   * 该回合是否是无尽模式的首领战 (author 2026-10-12): 从 BOSS_ROUND_FROM 起每 BOSS_ROUND_STEP 回合一次 —— 真正的
   * final-assault 流程 (打完继续下一回合)。R ≤ BOSS_POOL_LIMIT 抽常规首领池, R ≥ BOSS_POOL_SWITCH 起抽隐藏首领池。
   */
  endlessBossRound(r = this.round) {
    if (!this.endless || !Number.isFinite(r)) return false;
    const from = ENDLESS.BOSS_ROUND_FROM;
    return r >= from && (r - from) % ENDLESS.BOSS_ROUND_STEP === 0;
  }

  /**
   * The round whose config carries the boss templates / pick for an endless boss round: the run's own round (20, 30 …)
   * has no `roundCfg` (the boss templates only exist at R14/R15), so the boss wave must be built from the boss (R14)
   * or hidden (R15) round — R≤100 → 常规首领池's round, R≥110 → 隐藏首领池's round. (Without this `buildBossWave` gets
   * an empty `bossTemplates` and the boss round spawns NOTHING — author 2026-10-12「20 轮没有生成 boss」.)
   */
  endlessBossCfgRound(r = this.round) {
    const hidden = Number(r) >= ENDLESS.BOSS_POOL_SWITCH;
    const cfg = hidden ? this.gd.hiddenRound : this.gd.bossRound;
    return Number.isInteger(cfg) && cfg > 0 ? cfg : r;
  }

  /**
   * 无尽首领战的血池 (author 2026-10-12「boss 血量 ≈ 小怪的 5 倍」): 直接用「名义常规小怪基础血 × 小怪提升倍率 ×
   * BOSS_TRASH_X」，**不再**按 bossPoolHp 数据基础缩放。于是首领池 ≈ BOSS_TRASH_X × (NOMINAL_ENEMY_HP × ENEMY_MUL ×
   * growth(r))。R<BOSS_ROUND_FROM 无首领战, 值无关。
   */
  endlessBossPoolHp(r = this.round) {
    return Math.max(1, Math.round(ENDLESS.BOSS_TRASH_X * ENDLESS.NOMINAL_ENEMY_HP * ENDLESS.ENEMY_MUL * this.endlessGrowth(r)));
  }

  /** 本轮无尽首领战抽到的首领: 常规池 (R≤100) 或隐藏池 (R≥110), 按 rngEndless 加权抽取, 落到 this.bossId。 */
  _endlessPickBoss(r = this.round) {
    const pairs = r >= ENDLESS.BOSS_POOL_SWITCH ? this.gd.hiddenBossPool() : this.gd.bossWeights(false);
    const id = pairs.length ? weightedPick(this.rngEndless, pairs) : this.bossId;
    if (id) this.bossId = id;
    this.hiddenBossId = null; // 无尽首领战一律走 FINAL_ASSAULT (隐藏池也只是换一个首领数据)
    if (this.endless) { this.endless.bossId = this.bossId; this.endless.bossRound = true; }
    return this.bossId;
  }

  /**
   * The battle `flags` every field carries: the base gd.dp plus, in 无尽模式, the stat multipliers the sim applies —
   * `friendlyStatMul` (operators + summons hp/atk ×ENDLESS.UNIT_MUL) and `enemyStatMul` (enemies hp/atk ×ENEMY_MUL ×
   * the round's growth). In the JSON spec these flags reach the client sim too, so both sides scale identically.
   * A normal match returns the plain gd.dp (no keys, no effect).
   */
  statFlags() {
    const f = { ...this.gd.dp };
    if (this.endless) {
      f.friendlyStatMul = ENDLESS.UNIT_MUL;
      f.enemyStatMul = ENDLESS.ENEMY_MUL * this.endlessGrowth(this.round);
      // 藏品/决策的全队攻/血加成 (全队共享; 由 relics.js 聚合所有存活玩家的藏品/决策) —— 提前算好, 怪物攻击上限要用到「干员血量倍率」
      const rel = this.endlessTeamStatMul();
      const teamHp = 1 + rel.hp;
      // 怪物攻/防的独立成长 (作者 2026-10-13): 攻击每回合缓涨(1.10), **上限跟着干员血量倍率**(×0.9, <1) —— 干员越肉攻击涨越高,
      // 但永远不超过干员血量增长 → 保持威胁又不会一击秒杀; 干员没叠血时 ≈ 原值。防御增长更慢(1.06, 封顶 4)。
      const over = Math.max(0, (this.round || 0) - 1);
      const atkMul = Math.min(ENDLESS.ENEMY_ATK_GROWTH_STEP ** over, Math.max(1, ENDLESS.ENEMY_ATK_HP_TRACK * teamHp));
      const defMul = Math.min(ENDLESS.ENEMY_DEF_MUL_CAP, ENDLESS.ENEMY_DEF_GROWTH_STEP ** over);
      if (atkMul !== 1) f.enemyAtkMul = atkMul;
      if (defMul !== 1) f.enemyDefMul = defMul;
      // 维多利亚 (吃装备的盟约): 无尽里装备已改为「藏品」——把「每个装备」的加成换算成「每个藏品」(bonds/core.js installVictoria)。
      // 数值 = 全队持有的藏品总数 (藏品本就连全队共享)。
      f.relicAsEquip = this.endlessRelicCount();
      f.relicRarityCounts = this.endlessRelicRarityCounts(); // 维多利亚 tier6: 按品阶拆分加攻
      // 转职: 带 giveBondId 的装备单独携带即视为该盟约成员 (sim 侧 support/index.js unitBonds)
      f.bondGrantAlone = true;
      // 解除首领「限伤」: 单次伤害 ≥30 万 会被官方整击取消 (sim damage.js leaderHitCancelled); 无尽里伤害远超此值 → 全部取消 → "打 boss 不掉血"
      f.noBossHitLimit = true;
      f.terrainDmgMul = ENDLESS.TERRAIN_DMG_MUL; // 地形伤害 (活性源石/深水) 也 ×0.01
      f.layerCap = this.layerCap;                // 盟约层数上限 (无尽 0 = 无上限) —— 战斗内层数收益按它封顶/放开(sim/battle/economy.js)
      // 我方干员/召唤物的「最多叠加 N 层」天赋/技能堆叠上限解除 (sim/battle/status.js addBuff)
      if (ENDLESS.UNLIMITED_STACKS) f.noStackLimit = true;
      // 持续叠加据守「每场至多 N 层/次」的加盟约层数上限解除 (sim/content/garrisons/battle.js)
      if (ENDLESS.UNLIMITED_PER_BATTLE_CAP) f.noPerBattleCap = true;
      // 盟约(阵营)战斗加成的「至多」上限解除 (拉特兰 / 卡西米尔; sim/content/bonds/core.js)
      if (ENDLESS.UNLIMITED_BOND_CAP) f.noBondCap = true;
      // 叠盟约特质的层数 ×N (sim/content/garrisons/battle.js fireGain; 仅「开启技能/击倒敌人/被击倒」触发)
      if (ENDLESS.LAYER_TRAIT_MUL > 1) f.layerTraitMul = ENDLESS.LAYER_TRAIT_MUL;
      if (rel.atk !== 0 || rel.hp !== 0 || rel.def !== 0 || rel.dmg !== 0) {
        f.relicStatMul = { atk: 1 + rel.atk, hp: teamHp, def: rel.def, dmg: 1 + rel.dmg };
      }
      // 战斗内核触发 (处决者/杀戮成长): sim 在伤害 / 击杀时机结算
      const cb = this.endlessTeamCombatFlags();
      if (cb.exec) f.relicExec = cb.exec;
      if (cb.rampage) f.relicRampage = cb.rampage;
    }
    return f;
  }

  // —— 肉鸽藏品 / 决策 (author 2026-10-12, relics.js) --------------------------------------------------

  /** 某个玩家的「藏品 + 通用决策 + 专属决策」条目 (def + count)。 */
  _relicEntries(ps) {
    const out = [];
    for (const [id, count] of Object.entries(ps.relics || {})) {
      const def = relicDefById(id);
      if (def) out.push({ def, count });
    }
    for (const key of ps.decisions || []) {
      const def = decisionDefByKey(key);
      if (def) out.push({ def, count: 1 });
    }
    if (ps.exclusiveBond) {
      const def = exclusiveDefByBond(ps.exclusiveBond);
      if (def) out.push({ def, count: 1 });
    }
    return out;
  }

  /**
   * 藏品/决策汇总 (下发客户端「藏品栏」): [{ id, name, rarity, text, count }]。
   * `players` 省略 = 全队 (m.public.endless.relics, 藏品效果本就全队共享); 传单个 ps = 只看该玩家的 (m.private.relicsView)。
   */
  endlessRelicSummary(players = null) {
    const list = players || this.alivePlayers();
    const byId = new Map();
    const push = (key, def, count, extra = null) => {
      const e = byId.get(key) || { id: key, name: def.name, rarity: def.rarity || 'color', text: relicText(def), count: 0, icon: def.icon || null, ...(extra || {}) };
      e.count += count;
      byId.set(key, e);
    };
    for (const ps of list) {
      // 藏品 = 装备 id (客户端 gd.item(id) 取图标); 决策带 icon (trap id); 专属带 bond (盟约图标)
      for (const [id, count] of Object.entries(ps.relics || {})) { const d = relicDefById(id); if (d) push(id, d, count); }
      for (const key of ps.decisions || []) { const d = decisionDefByKey(key); if (d) push(`d:${key}`, d, 1, { icon: d.icon || null }); }
      if (ps.exclusiveBond) { const d = exclusiveDefByBond(ps.exclusiveBond); if (d) push(`x:${ps.exclusiveBond}`, d, 1, { bond: d.bond }); }
    }
    return [...byId.values()].sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  }

  /** 单个玩家的藏品/决策汇总 (m.private.relicsView): 只列自己的, 不和队友混在一起。 */
  endlessRelicSummaryFor(ps) { return this.endlessRelicSummary([ps]); }

  /** 全队持有的藏品总数 (维多利亚: 每个藏品当作一件装备; m.public 的 flags.relicAsEquip)。 */
  endlessRelicCount() {
    let n = 0;
    for (const ps of this.alivePlayers()) for (const c of Object.values(ps.relics || {})) n += (Number(c) || 0);
    return n;
  }

  /** 全队藏品按品阶计数 { white, blue, gold, color } (维多利亚 tier6: 按品阶拆分加攻)。 */
  endlessRelicRarityCounts() {
    const out = { white: 0, blue: 0, gold: 0, color: 0 };
    for (const ps of this.alivePlayers()) {
      for (const [id, c] of Object.entries(ps.relics || {})) {
        const d = relicDefById(id);
        const r = d && d.rarity ? d.rarity : 'white';
        if (out[r] != null) out[r] += (Number(c) || 0);
      }
    }
    return out;
  }

  // —— 经济商店 (每 SHOP_EVERY 回合) -------------------------------------------------------------

  /** 经济商店价格: (BASE + tier×TIER) × GROWTH^(周期−1)。 */
  endlessEconPrice(tier, cycle) {
    const t = Math.max(1, Math.floor(Number(tier) || 1));
    const c = Math.max(1, Math.floor(Number(cycle) || 1));
    return Math.max(1, Math.round((ENDLESS.ECON_PRICE_BASE + t * ENDLESS.ECON_PRICE_TIER) * Math.pow(ENDLESS.ECON_PRICE_GROWTH, c - 1)));
  }

  /** 藏品货位价格: 按稀有度 (白/蓝/金/彩) × GROWTH^(周期−1)。 */
  endlessRelicPrice(rarity, cycle) {
    const base = ENDLESS.ECON_RELIC_PRICE[rarity] || ENDLESS.ECON_RELIC_PRICE.white;
    const c = Math.max(1, Math.floor(Number(cycle) || 1));
    return Math.max(1, Math.round(base * Math.pow(ENDLESS.ECON_RELIC_PRICE_GROWTH, c - 1)));
  }

  /** 抽 count 个不重复 (Fisher-Yates on a copy)。 */
  _sample(rng, arr, count) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = a[i]; a[i] = a[j]; a[j] = tmp; }
    return a.slice(0, Math.max(0, Math.min(count, a.length)));
  }

  /**
   * 经济商店货架 (每 SHOP_EVERY 回合): 转职 (每个盟约一张, 图标=盟约图标) + 装备 (商店装备, tier ≤ 调度中心等级)。
   * 每张带 price; 玩家用资金购买 (endlessBuyEcon), 买到的进备战席。
   */
  endlessEconOffer(ps, round) {
    const gd = this.gd;
    const rng = this.rngEndless || Math.random;
    const cycle = Math.max(1, Math.floor((Number(round) || this.round) / ENDLESS.SHOP_EVERY));
    const entries = [];
    // 转职 (带 giveBondId 的装备)
    const transfers = [];
    for (const [id, it] of Object.entries(gd._items || {})) {
      if (!it || it.isGolden) continue;
      if (typeof it.giveBondId !== 'string' || !gd.bond(it.giveBondId)) continue;
      transfers.push({ id, it });
    }
    // 转职: 统一按「六阶道具」计价 → 所有转职同价 (ENDLESS.ECON_TRANSFER_SLOT 概念: tier 6)
    const transferPrice = this.endlessEconPrice(6, cycle);
    for (const { id, it } of this._sample(rng, transfers, ENDLESS.ECON_TRANSFER_SLOTS)) {
      const bondName = gd.bond(it.giveBondId)?.name || it.giveBondId;
      entries.push({
        kind: 'transfer', id, name: `转职 · ${bondName}盟约`, bond: it.giveBondId, bondName, tier: 6,
        text: `转职为【${bondName}】盟约：携带者视为该盟约成员`, price: transferPrice, sold: false,
      });
    }
    // 藏品 (花资金直接买一件藏品): 从藏品池按稀有度权重抽, 定价按稀有度 —— 与「每 RELIC_EVERY 关 3 选 1」是并行的另一条获取途径
    for (const d of rollRelics(rng, ps, round, ENDLESS.ECON_RELIC_SLOTS)) {
      entries.push({ kind: 'relic', id: d.id, name: d.name, rarity: d.rarity, icon: d.icon || null, text: relicText(d), price: this.endlessRelicPrice(d.rarity, cycle), sold: false });
    }
    // 装备 (普通商店装备; 显示效果). 排除「转职」(另有转职货位) 与鸡肋的「销毁换资金」类小道具 (性价比太低)
    const level = ps && ps.shop ? ps.shop.level : 1;
    const junk = ECON_JUNK_ITEMS;
    const pool = [];
    for (const [t, list] of Object.entries(gd.shopItemsByTier || {})) {
      if (Number(t) > level) continue;
      for (const id of list) {
        if (junk.has(id)) continue;
        const it = gd.item(id);
        if (it && typeof it.giveBondId === 'string') continue; // 转职不重复作为「装备」
        pool.push(id);
      }
    }
    const clean = (s) => String(s || '').replace(/<@[^>]*>/g, '').replace(/<\/>/g, ' ').trim();
    for (const id of this._sample(rng, pool, ENDLESS.ECON_EQUIP_SLOTS)) {
      const it = gd.item(id);
      entries.push({ kind: 'item', id, name: it?.name || id, tier: it?.tier, text: clean(it?.desc) || '装备', price: this.endlessEconPrice(it?.tier, cycle), sold: false });
    }
    return { round: Number(round) || this.round, entries, bought: false };
  }

  /** 经济商店购买 (g.econBuy {idx}): 扣资金, 装备进「备战席」; **每个商店只能买 1 件**。 */
  endlessBuyEcon(ps, idx) {
    const off = ps && ps.econOffer;
    if (!off || off.bought) return fail(ERR.BAD_TARGET, off && off.bought ? '本商店已购买' : 'no offer');
    const e = off.entries[idx];
    if (!e || e.sold) return fail(ERR.BAD_TARGET);
    const price = Math.max(0, Math.round(Number(e.price) || 0));
    if (ps.funds < price) return fail(ERR.NO_FUNDS);
    ps.spend(price);
    e.sold = true;
    off.bought = true; // 每个商店只能购买一个
    if (e.kind === 'relic') {
      // 藏品: 直接入手 (与 3 选 1 藏品同一套数据; 全队生效、与盟约联动)
      ps.relics[e.id] = (ps.relics[e.id] || 0) + 1;
      this.toast(ps, 'info', `购入藏品：${e.name || e.id}`);
      this.markPrivate(ps);
      return OK;
    }
    const piece = ps.newPiece('item', e.id);
    if (e.kind === 'transfer' && e.bond) piece.grantBond = e.bond; // 图标 = 盟约图标
    if (e.kind === 'transfer') piece.tierOverride = 6;             // 统一六阶
    const slot = freeSlot(ps.hand);
    if (slot >= 0) ps.hand[slot] = piece; else ps.items.push(piece);
    ps.recompute();
    this.dispatch(ps, 'onGain', { piece, kind: 'item', source: 'econShop' });
    this.markPrivate(ps);
    return OK;
  }

  /** 全队 (所有存活玩家) 藏品/决策的「战斗内核触发」(落到战斗 flags; 取最强的一个)。 */
  endlessTeamCombatFlags() {
    let exec = null, rampage = null;
    for (const ps of this.alivePlayers()) {
      for (const key of ps.decisions || []) {
        const d = decisionDefByKey(key);
        if (!d) continue;
        if (d.exec && (!exec || d.exec.mul > exec.mul)) exec = d.exec;
        if (d.rampage) rampage = d.rampage;
      }
    }
    return { exec, rampage };
  }

  /** 全队 (所有存活玩家) 藏品/决策的攻/血/防/伤害合计 (atk/hp/dmg 为小数, def 为平铺值)。 */
  endlessTeamStatMul() {
    let atk = 0, hp = 0, def = 0, dmg = 0;
    for (const ps of this.alivePlayers()) {
      const a = aggregateStats(ps, this._relicEntries(ps));
      atk += a.atk; hp += a.hp; def += a.def; dmg += a.dmg;
    }
    return { atk, hp, def, dmg };
  }

  /**
   * 每回合开始 (startRound 调): ① 给每个玩家发候选 (R1 专属盟约 8 选 1; r%RELIC_EVERY 藏品 3 选 1; r%DECISION_EVERY 通用决策 3 选 1);
   * ② 应用每个玩家藏品/决策的「每回合给层数」到其自己的盟约; ③ 藏品的每回合资金。
   */
  endlessRoundStart(r) {
    if (!this.endless || this.disposed) return;
    for (const ps of this.alivePlayers()) {
      // 候选
      ps.exclusiveOffer = null; ps.relicOffer = null; ps.decisionOffer = null;
      // 经济商店 (每 SHOP_EVERY 回合): 弹出货架 (转职 + 装备), 用资金买
      ps.econOffer = (ENDLESS.SHOP_EVERY > 0 && r % ENDLESS.SHOP_EVERY === 0) ? this.endlessEconOffer(ps, r) : null;
      if (r === 1 && !ps.exclusiveBond) {
        ps.exclusiveOffer = rollExclusives(this.rngEndless, 3).map((d) => ({ bond: d.bond, name: d.name, rarity: 'color', text: relicText(d) }));
      }
      if (r % ENDLESS.RELIC_EVERY === 0) {
        ps.relicOffer = rollRelics(this.rngEndless, ps, r).map((d) => ({ id: d.id, name: d.name, rarity: d.rarity, icon: d.icon || null, text: relicText(d) }));
      }
      if (r % ENDLESS.DECISION_EVERY === 0) {
        ps.decisionOffer = rollDecisions(this.rngEndless, ps).map((d) => ({ key: d.key, name: d.name, rarity: d.rarity, icon: d.icon, text: relicText(d) }));
      }
      // 每回合给层数 + 资金
      const entries = this._relicEntries(ps);
      for (const { bondId, n } of roundLayerGains(ps, entries)) ps.addLayers(bondId, n, { requireActive: false, reason: 'relic' });
      const gold = aggregateStats(ps, entries).funds;
      if (gold !== 0) ps.addFunds(gold, { reason: 'relic' }); // 可为负 (取舍型决策「一夜暴富」等)
    }
    for (const ps of this.alivePlayers()) this.markPrivate(ps); // 下发候选给各自玩家
  }

  /** prep 结束仍未选的候选 → 自动选第一个 (避免卡住)。 */
  endlessResolveOffers() {
    if (!this.endless) return;
    for (const ps of this.alivePlayers()) {
      if (ps.exclusiveOffer && ps.exclusiveOffer.length && !ps.exclusiveBond) this.endlessChooseExclusive(ps, ps.exclusiveOffer[0].bond, { quiet: true });
      if (ps.relicOffer && ps.relicOffer.length) this.endlessChooseRelic(ps, 0, { quiet: true });
      if (ps.decisionOffer && ps.decisionOffer.length) this.endlessChooseDecision(ps, 0, { quiet: true });
    }
  }

  /** 选专属盟约 (第 1 回合, 3 选 1, 互斥)。选中即给一笔启动层数 (startLayers, 经 layerMul 放大)。 */
  endlessChooseExclusive(ps, bondId, { quiet = false } = {}) {
    if (!ps || ps.exclusiveBond) return fail(ERR.ALREADY);
    if (!EXCLUSIVE_DECISIONS.some((d) => d.bond === bondId)) return fail(ERR.BAD_TARGET);
    const def = exclusiveDefByBond(bondId);
    ps.exclusiveBond = bondId;
    ps.exclusiveOffer = null;
    if (def && def.startLayers > 0) ps.addLayers(bondId, def.startLayers, { reason: 'exclusive' });
    if (!quiet) this.toast(ps, 'info', `专属盟约：${def.name}`);
    this.markPrivate(ps);
    return OK;
  }

  /** 选藏品 (3 选 1)。 */
  endlessChooseRelic(ps, idx, { quiet = false } = {}) {
    if (!ps || !Array.isArray(ps.relicOffer) || !ps.relicOffer[idx]) return fail(ERR.BAD_TARGET);
    const id = ps.relicOffer[idx].id;
    ps.relics[id] = (ps.relics[id] || 0) + 1;
    ps.relicOffer = null;
    if (!quiet) this.toast(ps, 'info', `获得藏品：${relicDefById(id)?.name || id}`);
    this.markPrivate(ps);
    return OK;
  }

  /** 选通用决策 (3 选 1)。 */
  endlessChooseDecision(ps, idx, { quiet = false } = {}) {
    if (!ps || !Array.isArray(ps.decisionOffer) || !ps.decisionOffer[idx]) return fail(ERR.BAD_TARGET);
    const key = ps.decisionOffer[idx].key;
    if (!ps.decisions.includes(key)) ps.decisions.push(key);
    ps.decisionOffer = null;
    if (!quiet) this.toast(ps, 'info', `决策：${decisionDefByKey(key)?.name || key}`);
    this.markPrivate(ps);
    return OK;
  }

  /**
   * Enter the 打桩环节 (PHASE.DUMMY) — stage 1 (准备): the shared LP (fixed 1) is spent, so instead of a defeat the team
   * gets a last chance: the 双人 boss 地图 (round set to the boss round → the client's boss-prep camera) where players
   * may still (re)arrange their board. When the prep ends (all ready / the deadline) startDummyBattle runs the 30 s
   * dummy fight. Called from settle.js when the shared LP hits 0.
   */
  enterDummy() {
    if (this.disposed || this.ended) return;
    // TEMP DIAG (bug hunt 2026-10-12): why did the run reach 打桩? Remove once located.
    console.warn(`[endless] enterDummy R=${this.round} teamLp=${this.teamLp} bossRound=${!!(this.endless && this.endless.bossRound)} phase=${this.phase} enteredRound=${this.endless ? this.endless.enteredRound : '-'}`);
    try { this._stopClientCombat(); } catch (e) { this.reportError('enterDummy stop', e); }
    // 成绩 = 进打桩时的回合数 (the round the team actually reached) — kept before `round` is repointed at the boss round
    // (which is only a client-camera trick), so the result's 通过回合 shows the real round, not bossRound − 1.
    if (this.endless && this.endless.enteredRound == null) this.endless.enteredRound = this.round;
    this.round = this.gd.bossRound;   // the client's prepCamera → bossPrep (the boss big map)
    this.wave = null;
    this.bossWaves = this._dummyPreviewWaves(); // preview the 源石虫 on the boss map during the prep
    this.fields = [];
    this.watchers.clear();
    this.endless.dummy = { stage: 'prep', dmg: 0, at: 0 };
    this.enterPrep();                 // players may keep editing their board on the boss map
    this.markPublic();
  }

  /**
   * The prep preview of the 打桩 (each player its own group of one): one 源石虫 at the middle of the boss field, so the
   * 准备阶段 draws it (nextEnemiesFor reads bossWaves → previewOf). One group per player keeps bossMateOf off (no 队友).
   */
  _dummyPreviewWaves() {
    const slug = ENDLESS.DUMMY_ENEMY;
    const center = [Math.round((GEO.BOSS_RECT.r0 + GEO.BOSS_RECT.r1) / 2), 10];
    const wave = {
      templateId: null,
      // tag 'boss' so previewOf carries `start` (its position) — a preview marker, not a real leader
      spawns: [{ enemyKey: slug, count: 1, time: 0, tag: 'boss', preview: { start: center, gate: 'lower', fly: false, elite: true } }],
      routes: [], extraRoutes: [], timeLimit: ENDLESS.DUMMY_SECONDS, overrides: {}, pick: null, entries: { ground: null, fly: null }, actions: [],
    };
    return this.alivePlayers().map((ps) => ({ players: [ps.playerId], side: 'L', wave }));
  }

  /**
   * The 打桩 battle (PHASE.DUMMY) — stage 2: each player's board fights on the boss map against one unkillable 源石虫
   * (enemyOverrides: huge HP, atk 0, 岁相-sized hitArea, stationary) for ENDLESS.DUMMY_SECONDS game seconds. Client-run
   * (the browser renders it like a normal battle) so the map/units show and the clock does not run out instantly; the
   * team's summed damage is the second 无尽 leaderboard's score. Called from prep.endPrep (endless dummy prep).
   */
  startDummyBattle() {
    if (this.disposed || this.ended) return;
    this.phase = PHASE.DUMMY;
    this.reviveAsk = null;
    const alive = this.alivePlayers();
    this.lastResults = new Map();
    const at = this.sched.instant ? 0 : this.sched.now() + Math.round((ENDLESS.DUMMY_SECONDS / this.gameSpeed) * 1000);
    this.endless.dummy = { stage: 'battle', dmg: 0, at };
    this.deadline = at;
    if (this.clientCombat) {
      const fields = alive.map((ps) => this._ccField({ fieldId: `d:${ps.playerId}`, kind: 'dummy', players: [ps.playerId], opts: this._dummyOpts(ps) }));
      this._launch(fields);
      // hand every client its own field's spec (like _startCombatClient) — WITHOUT this the browsers never run the
      // 打桩 field, so the operators stand still (no attacks) and the silence guard later hands it to the server
      for (const f of fields) for (const pid of f.players) {
        const ps = this.players.get(pid);
        if (!ps || ps.isBot || ps.left) continue;
        this.watchers.set(pid, f.fieldId);
        this._sendStart(pid, f);
      }
      for (const ps of this._viewers()) {
        if (this.watchers.has(ps.playerId)) continue;
        const f = fields[0];
        if (f) { this.watchers.set(ps.playerId, f.fieldId); this._sendStart(ps.playerId, f, { watch: true }); }
      }
    } else {
      const fields = alive.map((ps) => ({ fieldId: `d:${ps.playerId}`, kind: 'dummy', players: [ps.playerId], battle: this.newBattle(this._dummyOpts(ps)), live: true }));
      this.fields = fields;
      this.runner = new FieldRunner(this, fields, { onDone: () => this._dummyDone() });
      this.runner.start();
    }
    this._defaultWatch();
    this.markPublic();
  }

  /** Battle options of one player's 打桩 field: the boss map, one stationary / unkillable / harmless 源石虫 at the middle. */
  _dummyOpts(ps) {
    const slug = ENDLESS.DUMMY_ENEMY;
    const center = [Math.round((GEO.BOSS_RECT.r0 + GEO.BOSS_RECT.r1) / 2), 10];
    return {
      seed: deriveSeed(this.seed, `dummy:${ps.seat}`),
      kind: 'dummy', modeId: this.modeId, round: this.round,
      stageId: this.stageId, rect: { ...GEO.BOSS_RECT },
      timeLimit: ENDLESS.DUMMY_SECONDS,
      players: [ps.battleInput({ side: 'L', colOffset: 0 })],
      spawns: this._sanitizeSpawns([{ enemyKey: slug, count: 1, time: 0, pos: center, mods: { speedMul: 0 } }]),
      routes: [],
      sharedBoss: null,
      flags: { layerGainsEnabled: false, ...this.statFlags() },
      fieldId: `d:${ps.playerId}`,
      enemyOverrides: {
        [slug]: {
          stats: { maxHp: ENDLESS.DUMMY_HP, atk: 0, def: 0, res: 0, rangeRadius: 0, blockCnt: 0 }, // no attack, no def
          hitArea: { w: 4.95, h: 2.95, dx: 0, dy: 1 },                          // 岁相 (boss_14) 巨型单位 受击判定
          modelScale: ENDLESS.DUMMY_MODEL_SCALE,                                // 画得跟岁相一样大
          staticBody: true,                     // 位移免疫: 推 / 拉 / 直接位移都不移动它 (_displaceable 直接挡掉)
          immune: ENDLESS.DUMMY_IMMUNE,         // 只免疫「位移类」状态: 诱导 / 恐惧 (会让它自己走动); 其余负面效果照常生效
          immortal: true,                       // 不死: 血量下限 1、伤害全额统计 (作者 2026-10-12「不希望源石虫能被打死」)
        },
      },
    };
  }

  /**
   * One 打桩 field's team damage — the SERVER's own number, never the client's report: a client-run field's spec is
   * deterministic (buildBattleSpec → createBattleFromSpec, golden-tested), so re-simulating it server-side yields the
   * exact honest damage and a tampered report cannot reach the leaderboard. A server-run field already has its battle.
   * Returns null when the field cannot be (re)simulated (the caller then falls back to the reported result).
   */
  _dummyFieldDamage(f) {
    try {
      let b = f.battle || null;
      if (!b && f.spec) b = this._specBattle(f.spec);
      if (b && !b.finished && typeof b.step === 'function') {
        const lim = (f.spec && Number(f.spec.timeLimit) > 0 ? Number(f.spec.timeLimit) : ENDLESS.DUMMY_SECONDS) + 1;
        let guard = 0;
        while (!b.finished && b.time < lim && guard++ < 2e6) b.step();
      }
      const r = b && typeof b.result === 'function' ? b.result() : f.result;
      const per = {};
      if (r && r.perPlayer) for (const id of Object.keys(r.perPlayer)) per[id] = Number(r.perPlayer[id].damageDealt) || 0;
      return per;
    } catch (e) { this.reportError('dummy re-sim', e); return null; }
  }

  /**
   * The 打桩 battle ended (every field done): bank the SERVER-simulated team damage per player (`byPlayer`) and the total,
   * then end the run. The result shows each player's 打桩伤害 as their 领袖伤害.
   */
  _dummyDone() {
    if (this.ended) return;
    const byPlayer = {};
    let dmg = 0;
    for (const f of this.fields || []) {
      try {
        let per = this._dummyFieldDamage(f);
        if (per == null) { // re-sim unavailable: fall back to whatever the field reported (client / synthetic)
          const r = f.result || (f.battle && typeof f.battle.result === 'function' ? f.battle.result() : null);
          per = {};
          if (r && r.perPlayer) for (const id of Object.keys(r.perPlayer)) per[id] = Number(r.perPlayer[id].damageDealt) || 0;
        }
        for (const [pid, d] of Object.entries(per)) { byPlayer[pid] = (byPlayer[pid] || 0) + d; dmg += d; }
      } catch (e) { this.reportError('dummy result', e); }
    }
    if (this.endless && this.endless.dummy) {
      this.endless.dummy.dmg = Math.round(dmg);
      this.endless.dummy.byPlayer = byPlayer;
      this.endless.dummy.at = 0;
    }
    this.markPublic();
    this.finish({ victory: false, reason: 'endless' });
  }
}
