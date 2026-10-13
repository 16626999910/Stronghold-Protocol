// Shared enums & constants (server + browser). Pure ESM, no Node APIs.

import { N_ } from './i18n.js';

export const PROTOCOL_VERSION = 1;
/** Release version shown to players (title screen, server banner, /healthz). Kept equal to package.json "version"
 * (test/version.test.js); PROTOCOL_VERSION above is the separate wire-format number. */
export const APP_VERSION = '0.2.5';
/** A development build (the public `dev` branch): the title screen, the boot banner and the README say so, and
 * tools/package.mjs refuses to build a release zip from it without --allow-dev. */
export const DEV_BUILD = /-dev$/.test(APP_VERSION);

/**
 * Player seats of a room. The official mode is 1–4 players; this build raises the co-op cap to 12
 * (see the "队伍人数上限" customization) — the final-assault boss pool scales with the team size so a big
 * team does not simply melt the leader (server/match/gamedata.js bossPoolShare). A room may set a smaller
 * capacity of its own (room.setOptions maxPlayers, host-only).
 */
export const MAX_SEATS = 12;
/**
 * Spectator seats of a co-op room (community report #26, owner's decision 2026-10-04) — a remake feature: the official
 * room has 1–4 players and no spectator seat (there only eliminated players and 联防 bystanders watch, research 09 §3.1).
 * A spectator never counts as a player, may not act, and watches like an eliminated player (server/lobby.js spectate,
 * server/match/match/watch.js addSpectator).
 */
export const MAX_SPECTATORS = 2;
export const ROOM_CODE_LEN = 4;
export const NAME_MAX_LEN = 12;

// ---- 大队伍规则（本整合包的自定义规则；server/match/pool.js + Match.js）-------------------------------------
// 人数越多，每人的干员池被分走得越薄，官方那套「禁用盟约 + 固定副本数」的配置会让大队伍很难凑齐阵容。
// 队伍人数按「座位数」算（含 AI 队友补位），与最终攻势领袖血量的缩放口径一致。
/** 队伍人数 ≥ 该值时：本局不再禁用任何盟约（config.bans 的 core / addon 抽签跳过）。 */
export const BIG_TEAM_NO_BAN = 6;
/** 牌库倍率的起算人数：≤ 该人数时完全按官方规则（倍率 1，副本数分毫不动）。 */
export const POOL_SCALE_BASE_SEATS = 4;
/** 牌库倍率上限：人数再多也不会超过这个倍数。 */
export const POOL_SCALE_MAX_MUL = 2;

/**
 * 牌库副本倍率随队伍人数线性增长，4 人起算、上限 2 倍（整除无余数：8 人正好 2 倍）。
 *
 *   4 人 → ×1（官方原样）   5 人 → ×1.25   6 人 → ×1.5
 *   7 人 → ×1.75            8 人及以上 → ×2（封顶）
 *
 * 用于 server/match/pool.js 的 SharedPool：每一种棋子的副本上限都乘这个倍率（逐张取整，见 pool.js）。
 * 均匀放大所有棋子的副本数不会改变 copy-weighted 抽卡的 tier 权重分布 —— 只缓解「抢不到同一张卡」，
 * 不会让高 tier 更容易出。
 * @param {number} teamSize 座位数（玩家 + AI 队友）
 * @returns {number} 1 .. POOL_SCALE_MAX_MUL
 */
export function poolCopyMulFor(teamSize) {
  const n = Math.floor(Number(teamSize) || 0);
  if (!(n > POOL_SCALE_BASE_SEATS)) return 1;
  const raw = n / POOL_SCALE_BASE_SEATS;
  return raw >= POOL_SCALE_MAX_MUL ? POOL_SCALE_MAX_MUL : raw;
}

/**
 * 每局 AI 队友上限（本整合包的自定义规则，2H4G 服务器的容量考虑）：房主添加 AI 补位时，房间里的 AI 座位
 * 数不得超过这个值。真人座位（MAX_SEATS = 12）不受影响；真人撤离后由「AI 托管」接管的座位不算 AI 座位。
 * server/lobby.js room.addBot 用它做上限检查。
 */
export const MAX_AI_SEATS = 3;

// ---- 玩法扩展 (this build's addition) -------------------------------------------------------------------------
/**
 * Host-controlled room extensions (房间「玩法扩展」面板, room.setOptions). Each is an optional rule the host may turn on
 * for the room; a Match reads the room's selection and refuses the gated feature while it is off. `revive` = the
 * teammate-revive (g.revive) added by this build [ASSUMED default ON so the feature works out of the box; the host may
 * turn it off]. `sharedLp` = 共享血条 (the owner's decision of 2026-10-08): the team fights on ONE merged LP pool — the
 * sum of every player's LP. Any leak charges that pool instead of the individual who leaked, the bar shows the total,
 * and the pool hitting 0 ends the match as a team defeat (nobody is eliminated on their own). Default OFF (opt-in).
 * `dupBand` = 重复策略 (the owner's decision of 2026-10-08): the opening strategy draft no longer marks a teammate's
 * pick as 队友已选 — two or more players may take the SAME strategy (and the automatic assignments may repeat too).
 * Default OFF (opt-in).
 * `bossPanel` = DPS面板 (the owner's decision of 2026-10-09, extended 2026-10-11): ONE switch for TWO top-right cards —
 * the DPS 面板 (ui/dpsPanel.js: the own board's operators' damage this round + 每秒伤害 DPS, every in-battle phase,
 * collapsible) and the 领袖伤害面板 (ui/bossDamage.js: the team's damage share to the current leader, boss phases only).
 * Default ON (this build's own HUD, so a room only turns it off deliberately).
 * `deployCapOff` = 取消部署上限 (the owner's request of 2026-10-13): the board's deploy cap (economy.deployCap, default
 * 8) is lifted — a player may deploy as many operators as the board holds (also lifts the per-round 部署上限 grants'
 * effect since there is no cap). Default OFF (opt-in).
 * `noBan` = 不禁用盟约/干员 (the owner's request of 2026-10-13): the per-match ban draw is skipped entirely — no 禁用盟约,
 * no 禁用干员 (drawDisabledBonds returns empty drawn/banned). Moved here from the old "≥BIG_TEAM_NO_BAN seats auto-skip"
 * rule so it is an explicit host opt-in. Default OFF (opt-in).
 */
export const ROOM_EXTENSIONS = Object.freeze(['revive', 'sharedLp', 'dupBand', 'bossPanel', 'deployCapOff', 'noBan']);
/** Default of each room extension (a new room starts with these). */
export const ROOM_EXTENSIONS_DEFAULT = Object.freeze({ revive: true, sharedLp: false, dupBand: false, bossPanel: true, deployCapOff: false, noBan: false });
/**
 * 房间的「玩法扩展」是否全为默认 (author 2026-10-13): false = 用了非默认设置 (开了 sharedLp/dupBand/deployCapOff,
 * 或关了默认的 revive/bossPanel) → 该局属「非正规」, **不写入任何排行榜** (server/lobby.js onMatchEnd)。
 */
export function extensionsAreDefault(ext) {
  const e = ext || {};
  return ROOM_EXTENSIONS.every((k) => {
    const d = !!ROOM_EXTENSIONS_DEFAULT[k];
    const v = e[k] === undefined ? d : !!e[k]; // 缺省 = 取默认值
    return v === d;
  });
}
/**
 * 房间人数 (host-only, room.setOptions maxPlayers): the sizes the room's 玩法扩展 panel offers as chips, and the default
 * of a new room (4, the official roster). The absolute seat cap is MAX_SEATS.
 */
export const ROOM_PLAYER_OPTIONS = Object.freeze([4, 6, 8, 10, 12]);
export const DEFAULT_ROOM_PLAYERS = 4;

// ---- 复活队友 (this build's addition; the room extension 'revive') ---------------------------------------------
/** 救援消耗：出手的队友自己扣 10 点生命（因此他必须 ≥ 11 点才能出手，避免同归于尽）。 */
export const REVIVE_COST_LP = 10;
/** 获救者恢复到的生命：保留干员 / 装备 / 原有状态，只回 1 点生命。 */
export const REVIVE_RESTORE_LP = 1;

export const DIFFICULTIES = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'];
export const DIFFICULTY_NAMES = { FUNNY: N_('标准模拟'), NORMAL: N_('险境模拟'), HARD: N_('绝境模拟'), ABYSS: N_('终极模拟') };
export const DIFFICULTY_COLORS = { FUNNY: '#f6a329', NORMAL: '#e85a1a', HARD: '#e73118', ABYSS: '#ff0024' };

// modeId in data/config.json = `mode_${type}_${difficulty.toLowerCase()}` with type single|multi
export const modeIdFor = (roomMode, difficulty) =>
  `mode_${roomMode === 'solo' ? 'single' : 'multi'}_${difficulty.toLowerCase()}`;

export const PHASE = Object.freeze({
  LOBBY: 'LOBBY',
  INFO_CHECK: 'INFO_CHECK',
  BAND_DRAFT: 'BAND_DRAFT',
  BATTLE_CHECK: 'BATTLE_CHECK',
  ROUND_START: 'ROUND_START',
  SP_DRAFT: 'SP_DRAFT',
  PREP: 'PREP',
  COMBAT: 'COMBAT',
  UNITE: 'UNITE',
  SETTLE: 'SETTLE',
  FINAL_ASSAULT: 'FINAL_ASSAULT',
  HIDDEN_CORE: 'HIDDEN_CORE',
  // 无尽模式 (娱乐玩法, this build): the 打桩环节 — entered when the shared LP (fixed 1) is spent; a single unkillable
  // 源石虫 is damaged for 30 game seconds, then the run ends and its cumulative team damage is the score.
  DUMMY: 'DUMMY',
  RESULT: 'RESULT',
});

export const PHASE_NAMES = {
  LOBBY: N_('等待中'), INFO_CHECK: N_('确认本局信息'), BAND_DRAFT: N_('选择策略'), BATTLE_CHECK: N_('协议启动'),
  ROUND_START: N_('回合开始'), SP_DRAFT: N_('机变阶段'), PREP: N_('休整期'), COMBAT: N_('作战中'), UNITE: N_('联防阶段'),
  SETTLE: N_('结算'), FINAL_ASSAULT: N_('最终攻势'), HIDDEN_CORE: N_('隐秘核心'), DUMMY: N_('打桩环节'), RESULT: N_('模拟结束'),
};

// Board geometry on the 19x21 stage grid (row 0 = bottom). See DESIGN §3. The stage may be wider than COLS: the sim
// allocates a grid of MAX_COLS stride and every battle is bounded by its own `rect` (see the 联防 map, DESIGN §6.1).
export const GEO = Object.freeze({
  ROWS: 19, COLS: 21,
  // The widest stage built: the linear 联防 map grows 8 columns per helper (4 helpers ⇒ 35 columns). A stage's rows
  // shorter than this read as impassable (sim/grid.js EMPTY_TILE), so ordinary 21-wide maps are untouched.
  MAX_COLS: 35,
  FIELD: { r0: 9, r1: 12, c0: 2, c1: 10 },        // own deployable board region
  NORMAL_RECT: { r0: 9, r1: 12, c0: 0, c1: 10 },  // simulation rect for a normal battle
  UNITE_RECT: { r0: 9, r1: 12, c0: 0, c1: 20 },   // default (2-helper) 联防 rect; a bigger roster widens it
  BOSS_RECT: { r0: 0, r1: 5, c0: 0, c1: 20 },
  // Mirror axis of the Final Assault right half (board col c → BOSS_MIRROR_COL − c): the boss field stays 21 wide, so
  // this is FIXED — it is NOT COLS − 1 once MAX_COLS widens the sim stride.
  BOSS_MIRROR_COL: 20,
  HAND_ROW: 7, HAND_SIZE: 10,                      // hand slot idx = col 0..9
  TEMP_ROW: 8, TEMP_C0: 4, TEMP_SIZE: 5,           // temp slot idx 0..4 = cols 4..8
  PARTNER_COL_OFFSET: 8,
});

export const AREA = Object.freeze({ BOARD: 'board', HAND: 'hand', TEMP: 'temp', OUTSIDE: 'outside' });

export const PIECE_KIND = Object.freeze({ CHESS: 'chess', ITEM: 'item', TOKEN: 'token' });

/**
 * Whether the placed piece of a skill's summon (赫默's 医疗探机, 巫恋's 诅咒娃娃) also deploys once, for free, at the
 * battle start. true = the PRTS reading (卫戍协议/帮助 §作战阶段: "所有手动部署的召唤物，无视所属干员的持有状态…作战开始时
 * 立即部署一次", example 赫默's drone), settled by the user on 2026-10-01 after playtest #6 (DESIGN §20); false = the
 * playtest #4 reading ("是赫默开技能释放一次，不是开局直接就部署了"): it takes its tile only when the owner's skill gives one.
 * Either way the piece re-appears on its tile each time the owner's skill gives one.
 * One switch for everything that depends on it: the sim (server/sim/content/tokens.js dockSkillSummons) and the summon
 * card's hint (public/js/ui/detailPanel.js summonDeployHint). docs/PLAYING.md §4 and docs/SIM.md (token pieces) state
 * the rule in prose — test/ui/playtest6_summons.test.js fails until they match the value.
 */
export const SKILL_SUMMON_START_DEPLOY = true;

/**
 * Official per-bond layer cap (docs/research/11-limits-official.md §1): the client's
 * `Torappu.Battle.AutoChessBattleConst.MAX_GARRISON_STACK = 999`, and its bond counter (`AddBondCount`) stores
 * `min(L + n, 999)` — each bond stops at 999 on its own; the community reports bonds sitting at 999 while fed (巴哈姆特
 * 12534 "每把都能999层", 12316 "999謝"; research 02 §layers). The only implementation of the cap (DESIGN §20.12). Every
 * writer of a bond's layers goes through `layerGainRoom`: the prep-side gains (server/match/player/economy.js addLayers —
 * 特质, items, bands, 机变 cards, bonds), the settle of the in-battle gains (server/match/match/settle.js) and the live in-battle
 * copy (server/sim/battle/economy.js addLayers, as the client's AddBondCount) — and the dev tools' direct writes (tools/matchrun.mjs
 * --layers, tools/balance.mjs applyBoard); a gain at the cap adds 0 (no onLayers, no 'layer'
 * event), and the client-result check (server/match/fields.js) bounds a reported gain by the room left. Milestones paid
 * per N layers (远见, 奇迹, 维多利亚 …) stop with the count. 0 / Infinity = no cap.
 */
export const BOND_LAYER_CAP = 999;

/**
 * The layers a gain of `n` actually adds to a bond holding `before` under `cap` (default BOND_LAYER_CAP): min(n, cap − before),
 * never negative (a count already at or over the cap gains 0 and is never lowered); 0 for a non-positive / non-finite `n`
 * except +Infinity (= "the room left"). A sandbox match overrides `cap` (its own 盟约层数上限 knob).
 */
export function layerGainRoom(before, n, cap = BOND_LAYER_CAP) {
  if (!(n > 0)) return 0;
  const c = cap > 0 ? cap : Infinity;
  const b = Number.isFinite(before) && before > 0 ? before : 0;
  return Math.max(0, Math.min(n, c - b));
}

/** 沙盒模式 (this build): the enemy-HP multiplier knob's ceiling (怪物血量倍率上限 100×). */
export const SANDBOX_HP_MUL_MAX = 100;

// ---- 无尽模式 (娱乐玩法, this build; author 2026-10-11) --------------------------------------------------------
/**
 * 无尽模式: a fixed 4-player 娱乐 room that skips the 14-round flow — normal rounds run forever, the team fights on ONE
 * shared LP pool fixed at 1, and when it is spent the run ends in a 打桩环节 (PHASE.DUMMY) whose cumulative damage is
 * the score. Numbers are heavily re-scaled (enemies and operators both weakened). See server/match/match/endless.js.
 */
export const ENDLESS = Object.freeze({
  PLAYERS: 4,           // 固定四人房 (AI teammates disabled)
  START_LP: 20,         // 队伍共享总血量 (作者 2026-10-13: 1 → 20); 耗尽 → 联防 → 失败转入打桩
  EQUIP_PER_CHESS: 3,   // 每个干员可装备栏位 (作者 2026-10-13: 2 → 3; **仅无尽狂潮**, 其它模式仍用数据里的 2)
  LAYER_CAP: 0,         // 盟约层数上限: 0 = 无上限 (layerGainRoom / invariants 把 <=0 当无上限)
  POOL_MUL: 1.5,        // 牌库副本数 ×1.5 (固定 4 人房，覆盖大队伍规则的按人数倍率; SharedPool.copyMul)
  ENEMY_MUL: 1,         // 怪物 hp + atk × (only those two stats) — 作者 2026-10-12: 变回 ×1 (原值)
  ENEMY_ATK_CAP: 1,     // 怪物 atk 的缩放上限: 攻击力乘到 1×(原值) 后不再随回合成长; 之后只涨血量
  TERRAIN_DMG_MUL: 0.01,// 地形伤害 (活性源石 / 深水) ×
  UNIT_MUL: 1,          // 干员(含召唤物) hp + atk × — 1 = 原值(不缩放)
  // 怪物血量成长: hpMul(r) = ENEMY_MUL × GROWTH_STEP^(r−GROWTH_FROM)。作者 2026-10-12: 怪物初始 ×1 (原值)，**第 1 回合起**
  // 就开始上涨 (GROWTH_FROM 5 → 1)。约每回合 ×1.2152 (+21.5%)。
  GROWTH_FROM: 1,       // 第 1 回合起开始成长 (author 2026-10-12: 5 → 1)
  GROWTH_STEP: 1.2152,  // 每回合 ×1.2152 (+21.5%)
  // 成长倍率上限: 指数在极高回合会失控 (1.2152^r)，R134 起血池越过 2^53 后整数精度丢失、且会越过协议上限使上报帧被丢弃
  // (社区反馈 2026-10-14 的无尽「打不掉血」)。封顶后 (≈R123 起) 血量/血池不再增长，所有战斗数值都 < 2^53 可精确表示。
  GROWTH_CAP: 2e10,
  FUNDS_BONUS: 2,       // 每回合资金 +2 (在固定资金基础上)
  // 经济/商店 (author 2026-10-12, 细化): 无尽里**资金跨回合保留**(endPrep 不清零)，每 SHOP_EVERY 回合弹出一次
  // 「经济商店」(与「选藏品」同样的弹窗)—— 用资金买「转职」(每个盟约一张, 图标 = 该盟约图标) 与「装备」，买到的进**下方备战席**。
  FUNDS_KEPT: true,        // 资金跨回合保留 (存钱)
  SHOP_EVERY: 10,          // 每 10 回合弹出一次经济商店
  ECON_TRANSFER_SLOTS: 3,  // 弹窗里「转职」货位数 (每个盟约一张: 图标 = 盟约图标)
  ECON_EQUIP_SLOTS: 2,     // 弹窗里「装备」货位数
  ECON_RELIC_SLOTS: 2,     // 弹窗里「藏品」货位数 (花资金直接买一件藏品, 与 3 选 1 藏品是另一条获取途径)
  // 定价 (author 2026-10-13 改): **固定价** —— 不随回合涨 (旧版每 10 回合 ×1.6, 后期买不起)。资金消耗口改由「刷新费」承担。
  ECON_TRANSFER_PRICE: 60, // 转职固定价 (作者 2026-10-13: 60)
  ECON_EQUIP_PRICE: Object.freeze({ 1: 8, 2: 12, 3: 18, 4: 26, 5: 36, 6: 48 }), // 装备按阶固定价 (tier 1..6)
  ECON_RELIC_PRICE: Object.freeze({ white: 20, blue: 35, gold: 60, color: 110 }), // 藏品按稀有度固定价 (白/蓝/金/彩)
  // 刷新 (author 2026-10-13): 「刷新」按钮重新抽一批货; 价格 = ECON_REFRESH_BASE × ECON_REFRESH_MUL^已刷新次数 (首次 1, 每次翻倍)。
  // **每个商店重置为 1** (新货架 → refreshes=0)。
  ECON_REFRESH_BASE: 1,
  ECON_REFRESH_MUL: 2,
  // 专属盟约「本命盟约」权重: 商店刷新出该盟约干员的概率 × (author 2026-10-12)
  CORE_BOND_SHOP_MUL: 3,
  // 怪物攻/防成长 (author 2026-10-13 重调): 攻击力**每回合成长 (比血量慢)**，但**上限跟着「干员血量倍率」走**
  //   —— 干员靠叠层/藏品把血拉起来时, 怪物攻击也同步(略慢)地涨, 所以**永远打得出伤害、又不会一击秒杀**。
  //   enemyAtkMul(r) = min( ENEMY_ATK_GROWTH_STEP^(r−1), max(1, ENEMY_ATK_HP_TRACK × 干员血量倍率) )
  //     · 前半: 每回合 ×1.10 (+10%), **无硬上限** —— 只要没撞到干员血量的比例线就一直涨, 保证后期有威胁。
  //     · 后半: 不超过「干员血量倍率 × ENEMY_ATK_HP_TRACK」—— 比例 <1, 攻击增长始终少于干员血量增长, 不秒杀。
  //     · 早期干员没叠血时 干员血量倍率≈1 → 攻击≈原值; 干员越肉, 攻击能涨得越高。
  //   enemyDefMul(r) = min(ENEMY_DEF_GROWTH_STEP^(r−1), ENEMY_DEF_MUL_CAP)  (涨得更慢, 只是让干员 dps 追赶)
  // 首领的「高伤技能」走技能自身倍率结算, 不受此基本攻上限影响, 仍能造成致命伤害。
  ENEMY_ATK_GROWTH_STEP: 1.10, // 每回合 ×1.10 (+10%) —— 远低于血量的 +21.5%
  ENEMY_ATK_HP_TRACK: 0.8,     // 攻击倍率上限 = 干员血量倍率 × 此值 (<1 → 攻击增长恒少于血量增长)
  ENEMY_DEF_GROWTH_STEP: 1.06, // 每回合 ×1.06 (+6%) —— 最慢
  ENEMY_DEF_MUL_CAP: 4,        // 防御倍率上限
  // 肉鸽化 (author 2026-10-12): 装备改为「藏品」——每 RELIC_EVERY 关给 1 个藏品 (3 选 1)，每 DECISION_EVERY 关给 1 次
  // 通用决策 (3 选 1)，第 1 回合从核心盟约专属决策里 8 选 1 (彩色·互斥)。藏品/决策都是「全局生效、与盟约联动」。
  RELIC_ENABLED: true,
  RELIC_EVERY: 5,       // 每 5 关给 1 个藏品 (作者 2026-10-12: 2 → 5)
  DECISION_EVERY: 10,   // 每 10 关给 1 次通用决策 (作者 2026-10-12: 5 → 10, 跟商店同拍)
  RELIC_EQUIP_FUNDS: 3, // (旧) 「获得时给装备」改成发资金 —— 已改为下面的「给主盟约叠层」
  // 「获得时给装备」的干员特质/策略: 无尽里改成给「该干员主盟约」叠层, 数量 = 干员阶数 × 此值 (作者 2026-10-12)
  TRAIT_BOND_LAYERS_PER_TIER: 2,
  // 维多利亚盟约的「每25层获得一件维式重锤」: 无尽里改成「每 VICTORIA_RELIC_STEP 层获得一件随机藏品」, 至多 VICTORIA_RELIC_MAX 件 (作者 2026-10-12)
  VICTORIA_RELIC_STEP: 500,
  VICTORIA_RELIC_MAX: 5,
  // 维多利亚 tier6: 每拥有1件藏品给【维多利亚】干员加攻, 按藏品品阶递增 (白/蓝/金/彩) —— 藏品无「进阶」概念 (作者 2026-10-12)
  VICTORIA_RELIC_ATK: Object.freeze({ white: 0.3, blue: 0.5, gold: 0.8, color: 1.2 }),
  BATTLE_TIME_MUL: 2,   // 局内战斗时限 ×2 (每回合的准备/作战倒计时)
  ARCHIVE_ROUNDS: Object.freeze([7, 9, 11, 13]), // 这些回合开局各发一个「人事部档案」
  ARCHIVE_ITEM: 'chess_item_6_08_e',             // 人事部文档 (装备时最大可部署 +1)
  // 战斗内「最多叠加 N 层」的天赋/技能堆叠上限解除 (只作用于我方干员/召唤物): 战斗 flags.noStackLimit
  // 作者 2026-10-12「回退无尽狂潮所有干员特质到原版」→ 关闭 (干员/召唤物天赋·技能恢复原版叠加上限)
  UNLIMITED_STACKS: false,
  // 持续叠加据守「每场战斗/作战至多 N 层/次」上限解除 (加盟约层数类): 战斗 flags.noPerBattleCap
  UNLIMITED_PER_BATTLE_CAP: false,
  // 盟约(阵营)战斗加成的「至多」上限解除 (拉特兰攻击至多+200%、卡西米尔攻击至多+{层数}…): 战斗 flags.noBondCap
  UNLIMITED_BOND_CAP: true,
  // 叠盟约特质 (garrison) 的「盟约层数」收益 ×N (仅无尽狂潮; 不动资金/道具/招募). **当前 = 1 (关闭)**.
  // [2026-10-12] 曾试 ×10, 作者反馈「不太好、不平衡」→ 回退成 1× (关闭)。留此开关以便日后调平衡:
  //   改成 >1 即生效; 作用范围 = 只放大「给盟约层数」的特质, 按触发分两类
  //   (prep 走 effectsMeta, battle 走 sim/content/garrisons/battle.js):
  //   LAYER_TRAIT_META_EVENTS   = 获得时 / 进入休整期时 / 休整期结束时 (garrison.eventType)
  //   LAYER_TRAIT_BATTLE_EVENTS = 战斗中开启技能时 / 击倒敌人时 / 被击倒时 (garrison.effectKey)
  //   不含: 刷新时 / 售出时 / 敌人冻结 / 消耗弹药 / 每叠加N层类效果.
  LAYER_TRAIT_MUL: 1,
  LAYER_TRAIT_META_EVENTS: Object.freeze(['SERVER_GAIN', 'SERVER_PREP_START', 'SERVER_PREP_FIN']),
  LAYER_TRAIT_BATTLE_EVENTS: Object.freeze([
    'act1autochess_gar_event_useskill',       // <战斗中>开启技能时…
    'act1autochess_gar_event_selfkillenemy',  // <战斗中>击倒敌人时…
    'act1autochess_gar_event_selfdead',       // <战斗中>自身被击倒时…
  ]),
  DEPLOY_CAP: 12,       // 部署人数上限
  DUMMY_SECONDS: 30,    // 打桩环节时长 (游戏秒，受战斗速度影响)
  DUMMY_ENEMY: 'enemy_1007_slime', // 中央那根桩 = 源石虫 (打不死、只累计伤害)
  DUMMY_HP: 1e12,       // 桩的血量(极大，30s 内打不死)
  DUMMY_MODEL_SCALE: 5, // 桩的模型放大倍率 (岁相体型；可调)
  // 桩只免疫「位移类」效果 —— 推 / 拉 / 直接位移由 staticBody 兜住（`_displaceable` 直接挡掉，见 endless.js 的
  // enemyOverrides），这里只再挡会让它自己走动的两个状态：诱导（attract, 走向目标点）与恐惧（fear, 四散逃跑）。
  // 其余负面效果（眩晕/冻结/沉睡/浮空/减速/沉默/缴械/麻痹/束缚/战栗…）现在**照常生效**（author 2026-10-12：原先
  // 免疫全部负面效果太宽，改成只免疫推拉那类位移；木桩本就是静止的靶子，控住它没有意义、但其余 debuff 应能叠上）。
  DUMMY_IMMUNE: Object.freeze([
    'attract', // 诱导: 走向目标点 (会在场上走动 → 位移类)
    'fear',    // 恐惧: 四散逃跑 (失控移动 → 位移类)
  ]),
  // 悬赏敌人 (author 2026-10-12): 从 BOUNTY_FROM 回合起，每一波额外加入「随机悬赏卡敌人」(choices.json cards.bounty
  // 的全部 enemyKey 池)，数量 = 1 + floor((r − BOUNTY_FROM) / BOUNTY_STEP) —— 每 BOUNTY_STEP 回合多一只；全队本轮共用同一组。
  BOUNTY_FROM: 20,
  BOUNTY_STEP: 10,
  BOUNTY_POOL: null,    // null = 运行时从 gd.choices.cards.bounty 的 enemyKey 去重取池
  // 首领战 (author 2026-10-12): 从 BOSS_ROUND_FROM 起，每 BOSS_ROUND_STEP 回合进入一次真正的首领战 (final-assault 流程)；
  // 打完继续下一回合。R ≤ BOSS_POOL_LIMIT 用 R14 (常规首领) 池，R ≥ BOSS_POOL_SWITCH 起改用 R15 (隐藏首领) 池。
  BOSS_ROUND_FROM: 10,  // 第 10 回合起 (author 2026-10-12: 20 → 10)
  BOSS_ROUND_STEP: 10,  // 每 10 回合一次 (R10/20/30…)
  BOSS_POOL_LIMIT: 100,  // 该回合(含)以下用常规首领池
  BOSS_POOL_SWITCH: 110, // 该回合(含)以上用隐藏首领池
  BOSS_SECONDS: 180,    // 无尽首领战的关底倒计时(秒) —— R20/30/… 无 roundCfg, 作为 bossLevelTime 的兜底
  BOSS_TRASH_X: 5,      // 无尽首领血池 ≈ 名义常规小怪血量的这个倍数 (author 2026-10-12「boss ≈ 小怪 5 倍」)
  NOMINAL_ENEMY_HP: 10000, // 「名义常规小怪」基础血量 (首领血池目标用; 非某种具体怪)
  IDLE_KICK_ROUNDS: 2,  // 连续多少回合无已连接人 → 踢出该座位
  LEADERBOARD_TOP: 5,   // 每个无尽榜保留前 5 支队伍
});

/**
 * Official boss-hit limit "限伤" (docs/research/11-limits-official.md §2): `AutoChessBattleConst.MAX_BATTLE_DAMAGE =
 * 300000`. In a boss battle outside training — our battle kinds 'boss' (Final Assault) and 'hidden' (Hidden Core) — a
 * single hit on a leader (`AutoChessBattleUtil.IsBossEnemy`: an enemyId of activity_table autoChessData.bossInfoDict
 * = data/bosses.json `enemyKey`; in the sim the tag-'boss' units: those leaders and their mirrored copies, never parts,
 * escorts or drones) whose `ceil(final damage)` ≥ this is CANCELLED: 0 damage, nothing credited to the shared pool
 * (`AutoChessStepModeManager._OnBossEnemyTakeDamage` → `modifier.Cancel()`). It is not a clamp: a hit of 299999 lands.
 * Checked in server/sim/damage.js (dealDamage after DEF / RES and every multiplier, before shields; Battle.loseHp — not
 * the 胄 drone link's pool share, `noHitLimit`, DESIGN §25.13.4). Minions, normal rounds and 联防 are unaffected.
 * 0 / Infinity = off.
 */
export const BOSS_HIT_LIMIT = 300000;

// Snapshot unit flag bits (DESIGN §8.2)
export const UF = Object.freeze({
  BLOCKED: 1, STUNNED: 2, FROZEN: 4, STEALTH: 8, SKILL: 16, SHIELD: 32, INVULN: 64, COLD: 128, SLEEP: 256, FLYING: 512,
});

export const ANIM = Object.freeze({ IDLE: 0, MOVE: 1, ATTACK: 2, SKILL: 3, DIE: 4, STUN: 5, DEPLOY: 6 });

export const ERR = Object.freeze({
  BAD_MSG: 'BAD_MSG',             // malformed / unknown message
  RATE: 'RATE',                   // rate limited
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_STARTED: 'ROOM_STARTED',
  NOT_HOST: 'NOT_HOST',
  NOT_READY: 'NOT_READY',
  WRONG_PHASE: 'WRONG_PHASE',
  NO_FUNDS: 'NO_FUNDS',
  HAND_FULL: 'HAND_FULL',
  BOARD_FULL: 'BOARD_FULL',
  BAD_TILE: 'BAD_TILE',
  BAD_TARGET: 'BAD_TARGET',
  SOLD_OUT: 'SOLD_OUT',
  MAX_LEVEL: 'MAX_LEVEL',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  ALREADY: 'ALREADY',
  TEMP_NOT_EMPTY: 'TEMP_NOT_EMPTY',
  ELIMINATED: 'ELIMINATED',
  SPECTATOR: 'SPECTATOR',         // a spectator seat only watches (MAX_SPECTATORS)
  AI_LIMIT: 'AI_LIMIT',           // the room's AI-teammate cap (MAX_AI_SEATS) is reached
  REVIVE_USED: 'REVIVE_USED',     // this player already used their once-per-match teammate revive
  REVIVE_LP: 'REVIVE_LP',         // not enough own LP to pay the revive cost
  EXTENSION_OFF: 'EXTENSION_OFF', // the room's host has not enabled that 玩法扩展 (room.setOptions)
  INTERNAL: 'INTERNAL',
});

export const ERR_TEXT = {
  BAD_MSG: N_('无效的请求'), RATE: N_('操作过于频繁'), NOT_IN_ROOM: N_('你不在房间中'), ROOM_NOT_FOUND: N_('未找到该同盟密钥对应的房间'),
  ROOM_FULL: N_('房间已满'), ROOM_STARTED: N_('模拟已开始'), NOT_HOST: N_('只有房主可以操作'), NOT_READY: N_('仍有玩家未就绪'),
  WRONG_PHASE: N_('当前阶段无法进行该操作'), NO_FUNDS: N_('资金不足'), HAND_FULL: N_('整备区已满'), BOARD_FULL: N_('已达到部署上限'),
  BAD_TILE: N_('无法部署在该位置'), BAD_TARGET: N_('无效的目标'), SOLD_OUT: N_('已售出'), MAX_LEVEL: N_('调度中心已达最高等级'),
  NOT_YOUR_TURN: N_('尚未轮到你'), ALREADY: N_('已完成该操作'), TEMP_NOT_EMPTY: N_('临时整备区不为空'), ELIMINATED: N_('你已被淘汰'),
  SPECTATOR: N_('观战中无法进行该操作'), AI_LIMIT: N_('AI 队友已达上限（每局最多 3 名）'),
  REVIVE_USED: N_('本局已经复活过队友了'), REVIVE_LP: N_('生命值不足，无法复活队友（需要 10 点以上）'),
  EXTENSION_OFF: N_('房主未开启玩法扩展「复活队友」'),
  INTERNAL: N_('服务器内部错误'),
};

// ---- Emotes (交流, research 09 §4) -----------------------------------------------------------------------------
// The 36 official in-match emotes: display_meta_table emoticonData, scene AUTOCHESS_BATTLE, 6 themes × 6, one wheel
// page per theme in activity_table autoChessData.enabledEmoticonThemeIdList order, emotes by sortId. `g.emote { id }`
// / `m.emote { playerId, id }` carry the official emoji id. Generated reference: data/emotes.json
// (tools/build-emotes.mjs); test/ui/emotes.test.js keeps this table identical to it.
// Official emotes have no text (desc is null): `label` is ours and only ever an aria-label, never displayed.
// Art: extracted from a local client (tools/local-extract) to /assets/local/emoticon/<dir>/<picId>.png and listed in
// data/local-assets.json group `emoticon/<dir>`; also downloaded from the public mirror by tools/fetch-assets.mjs
// (tools/assets/plan.mjs UI_EXTRAS → data/assets.json ui['emoticon/<dir>/<picId>'], GitHub issue #42). The UI takes the
// local picture first, then the mirror copy, and shows a neutral glyph when neither is there. The picId is not
// derived from the id (autochess_battle_fooldoctor_03…06 → pic_fooldoctor_04/05/06/08_battle).
const emo = (id, sortId, picId, label) => Object.freeze({ id, sortId, picId, label });
export const EMOTE_THEMES = Object.freeze([
  { themeId: 'emoticon_autochess_basic', dir: 'basic', sortId: 100000, isBasic: true, name: N_('表情套组：卫戍协议'), emotes: [
    emo('autochess_battle_happy', 1001, 'pic_happy_battle', N_('开心')),
    emo('autochess_battle_scared', 1002, 'pic_scared_battle', N_('害怕')),
    emo('autochess_battle_sorry', 1003, 'pic_sorry_battle', N_('对不起')),
    emo('autochess_battle_thanks', 1004, 'pic_thanks_battle', N_('谢谢')),
    emo('autochess_battle_thinking', 1005, 'pic_thinking_battle', N_('思考')),
    emo('autochess_battle_nice_cooperate', 1006, 'pic_cooperate_battle', N_('合作愉快')),
  ] },
  { themeId: 'emoticon_originium_slug', dir: 'slug', sortId: 1001, isBasic: false, name: N_('表情套组：虫动'), emotes: [
    emo('slug_autochess_battle_nice_work', 2001, 'pic_nice_work_battle', N_('合作愉快！')),
    emo('slug_autochess_battle_thanks', 2002, 'pic_thanks_battle', N_('谢谢！')),
    emo('slug_autochess_battle_sorry', 2003, 'pic_sorry_battle', N_('对不起！')),
    emo('slug_autochess_battle_bye', 2004, 'pic_bye_battle', N_('再见！')),
    emo('slug_autochess_battle_distrust', 2005, 'pic_distrust_battle', '？？？'),
    emo('slug_autochess_battle_very_soon', 2006, 'pic_very_soon_battle', N_('很快就好！')),
  ] },
  { themeId: 'emoticon_autochess_basic_2', dir: 'basic_2', sortId: 100001, isBasic: true, name: N_('表情套组：卫戍协议'), emotes: [
    emo('autochess_battle_noproblem', 1007, 'pic_noproblem_battle', N_('没问题！')),
    emo('autochess_battle_respect', 1008, 'pic_respect_battle', N_('敬礼！')),
    emo('autochess_battle_call', 1009, 'pic_call_battle', N_('欢呼！')),
    emo('autochess_battle_playingcool', 1010, 'pic_playingcool_battle', N_('酷！')),
    emo('autochess_battle_sad', 1011, 'pic_sad_battle', N_('伤心')),
    emo('autochess_battle_dying', 1012, 'pic_dying_battle', N_('快死了')),
  ] },
  { themeId: 'emoticon_foolsday_doctor', dir: 'fooldoctor', sortId: 1002, isBasic: false, name: N_('表情套组：博士士'), emotes: [
    emo('autochess_battle_fooldoctor_01', 1020, 'pic_fooldoctor_01_battle', N_('博士士 1')),
    emo('autochess_battle_fooldoctor_02', 1021, 'pic_fooldoctor_02_battle', N_('博士士 2')),
    emo('autochess_battle_fooldoctor_03', 1022, 'pic_fooldoctor_04_battle', N_('博士士 3')),
    emo('autochess_battle_fooldoctor_04', 1023, 'pic_fooldoctor_05_battle', N_('博士士 4')),
    emo('autochess_battle_fooldoctor_05', 1024, 'pic_fooldoctor_06_battle', N_('博士士 5')),
    emo('autochess_battle_fooldoctor_06', 1025, 'pic_fooldoctor_08_battle', N_('博士士 6')),
  ] },
  { themeId: 'emoticon_foolsday_amiya', dir: 'foolamiya', sortId: 1003, isBasic: false, name: N_('表情套组：米米子'), emotes: [
    emo('autochess_battle_foolamiya_01', 1040, 'pic_foolamiya_01_battle', N_('米米子 1')),
    emo('autochess_battle_foolamiya_02', 1041, 'pic_foolamiya_02_battle', N_('米米子 2')),
    emo('autochess_battle_foolamiya_03', 1042, 'pic_foolamiya_03_battle', N_('米米子 3')),
    emo('autochess_battle_foolamiya_04', 1043, 'pic_foolamiya_04_battle', N_('米米子 4')),
    emo('autochess_battle_foolamiya_05', 1044, 'pic_foolamiya_05_battle', N_('米米子 5')),
    emo('autochess_battle_foolamiya_06', 1045, 'pic_foolamiya_06_battle', N_('米米子 6')),
  ] },
  { themeId: 'emoticon_foolsday_wisdel', dir: 'foolwisdel', sortId: 1004, isBasic: false, name: N_('表情套组：维维美'), emotes: [
    emo('autochess_battle_foolwisdel_01', 1060, 'pic_foolwisdel_01_battle', N_('维维美 1')),
    emo('autochess_battle_foolwisdel_02', 1061, 'pic_foolwisdel_02_battle', N_('维维美 2')),
    emo('autochess_battle_foolwisdel_03', 1062, 'pic_foolwisdel_03_battle', N_('维维美 3')),
    emo('autochess_battle_foolwisdel_04', 1063, 'pic_foolwisdel_04_battle', N_('维维美 4')),
    emo('autochess_battle_foolwisdel_05', 1064, 'pic_foolwisdel_05_battle', N_('维维美 5')),
    emo('autochess_battle_foolwisdel_06', 1065, 'pic_foolwisdel_06_battle', N_('维维美 6')),
  ] },
].map((t) => Object.freeze({ ...t, emotes: Object.freeze(t.emotes) })));
/** Every emote with its theme: `{ id, sortId, picId, label, themeId, dir }`, in wheel order. */
export const EMOTE_CATALOG = Object.freeze(EMOTE_THEMES.flatMap((t) => t.emotes.map((e) => Object.freeze({ ...e, themeId: t.themeId, dir: t.dir }))));
/** The 36 official emote ids (protocol whitelist: `EMOTES.includes(id)`). */
export const EMOTES = Object.freeze(EMOTE_CATALOG.map((e) => e.id));
const EMOTE_INDEX = new Map(EMOTE_CATALOG.map((e) => [e.id, e]));
/** Catalog record of an emote id, or null (safe for any input, including '__proto__'). */
export const emoteInfo = (id) => (typeof id === 'string' && EMOTE_INDEX.get(id)) || null;
// id-keyed maps without a prototype: a wire id like '__proto__' / 'toString' looks up undefined, never an Object method
const emoteMap = (pick) => Object.freeze(Object.assign(Object.create(null), Object.fromEntries(EMOTE_CATALOG.map((e) => [e.id, pick(e)]))));
/** Emote id → theme id. */
export const EMOTE_THEME = emoteMap((e) => e.themeId);
/** Emote id → our aria-label (never displayed). */
export const EMOTE_LABEL = emoteMap((e) => e.label);
/** data/local-assets.json group of an emote's art (`emoticon/<dir>`), or null. */
export const emoteArtGroup = (id) => { const e = emoteInfo(id); return e ? `emoticon/${e.dir}` : null; };
/** Canonical URL of an emote's extracted art (`/assets/local/emoticon/<dir>/<picId>.png`), or null for unknown ids. */
export const emoteArtPath = (id) => { const e = emoteInfo(id); return e ? `/assets/local/emoticon/${e.dir}/${e.picId}.png` : null; };
export const EMOTE_COOLDOWN_MS = 1000; // activity_table autoChessData.constData.chatCD (s)
export const EMOTE_BUBBLE_MS = 3000;   // constData.chatTime (s): how long a bubble stays up
// 局内文字聊天（作者 2026-10-11）：在「交流」表情面板里加一个输入框，发出去的文字**像表情一样横穿屏幕**。
// 单条上限（协议与客户端都按此校验，字符数）与横穿时长（比表情久一点，够读完）。冷却复用 EMOTE_COOLDOWN_MS。
export const CHAT_MAX_LEN = 60;
export const CHAT_FLOAT_MS = 6000;
// 大厅聊天 (this build): the lobby's own message board cap — a bit longer than an in-match line, still one screenful.
export const LOBBY_CHAT_MAX_LEN = 120;
