// server/sim/content/bosses.js — scripted leaders (boss_1…boss_11) and their parts (DESIGN §7, research 05 §5, 06 §10.1).
//
// install(battle) ensures the enemy dispatch hooks (enemies.js) and attaches a boss kit to every spawned leader / part
// listed in BOSS_KITS. Damage dealt TO a leader routes to the shared boss pool through the engine (tag 'boss' +
// sharedBoss); parts that "传递伤害" push the damage they take into the pool with a 无来源 battle.loseHp(leader, …)
// credited to the attacker (PART_TRANSFER = 1, "等量"). Numbers come from the (template-overridden) talent / skill blackboards; the rest are named
// constants ([ASSUMED] or PRTS-sourced). Boss HP rules ("<20 %", "≤50 %") read the leader's HP ratio, which the engine
// syncs from the shared pool, so both mirrored copies switch phase together.
//
// Wave template: branches / extraRoutes / devices / patrol steps are read from the template the battle was built
// from — `opts.waveTemplate|template|templateId|waveId` when the match passes it, else inferred from data/waves.json
// (the template whose leader spawn matches and whose route list equals battle.routes). Without a template the
// fallbacks spawn summons at the leader and route them to the nearest goal. Branch spawns keep their literal key
// unless the match passes the round's placeholder replacements as `opts.slotKeys` ({ NF: key, N: key, … }).
//   · patrol: a leader / part walking `patrol` steps loops them (never reaches the goal: 卢西恩 lpr 30, 铳, 碎铳之簧).
//   · 'boss_battle_multi_player' (铳, 卢西恩): with ≥2 players on the field the mirrored copy is spawned from the branch
//     (skipped if the match already spawned a second copy, or opts.bossMirror === false).
//   · 可移动领袖模板 (movableLeader + halfWalk, 作者 2026-10-11, 参考卢西恩): a leader that walks mirrors itself on a
//     2-player field — one copy per team, each patrolling its OWN half; solo → one copy toward the occupied (left) half.
//     A kit calls it from spawn() at the moment the unit should start moving (kitSyskad: at spawn; kitPatriot: at 毁灭姿态).
//     Both copies share the pool (tag 'boss' → sharedBoss) and fall together; the mirror's kit spawn() sees `mem.mirrorLeader`.
//
// Leaders (see each kit for details):
//   boss_1/8 假想敌：胄      random arts beam (range 8); 灭顶之灾 one 刺胄之弹 at the highest-ATK operator in range (8-hit
//                            flying shell, 3×3 stun + phys DoT on arrival); <20 %: damage ×0.5 (no extra shell: PRTS
//                            能力修正); 死亡集群 drones — a drone that dies costs the leader 2 % of its max HP = the shared
//                            pool's (DRONE_LINK_BASE, [ASSUMED] reading), past 限伤 (a share, no hit). boss_8 adds 斩胄之剑 /
//                            破胄之锤.
//   斩胄之剑 / 破胄之锤      初始模式: hover invulnerable next to 胄, AoE attacks (锤 150 % ATK). 出击模式: blink to the
//                            level's blink route, fly at the lowest-ATK operator (3×3 stun + DoT); 15 hits shoot it
//                            down (瘫痪: stun 10 s, ground unit, damage ×1.3). Either way a new 初始模式 copy with its HP
//                            replaces it at home. Every damage it takes costs 胄 as much (PART_TRANSFER, 无来源, 等量) —
//                            grounded per both texts, during the dive per the PRTS talent [ASSUMED]. The shell, 剑 and
//                            锤 are 失衡免疫 + 静态刚体 (PRTS 天赋): no push or pull moves them.
//   boss_2/9 假想敌：铳      unblockable; highest-DEF target in range; erosion; ASPD ramp (+80 × 5) on the same target
//                            (floor 20); 最终之罚 charge at the highest-DEF ground unit (disabled by the h07_02 override).
//                            boss_9: damage ×0.2 while springs live, 盲信之誓 links (100 phys/s on the lines), 末日布道 dash.
//   碎铳之簧 a/b/c           arts barrier (absorbs arts after RES; phys ×0.1, counter phys + erosion) / element shield
//                            (phys+arts ×0.1, broken by its own element burst; every (spCost+1)-th attack a bouncing erosion
//                            shot) / 5-hit shield (every (spCost+1)-th attack a ten-hit combo); unblockable while shielded;
//                            shield back 25 s after breaking; every damage taken costs 铳 as much (PART_TRANSFER, 无来源)
//                            and, split, the other springs.
//   boss_3/10 假想敌：管     summons 余音 (dark) every 40 s (20 s < 50 %); normal attacks strike dark 余音 (their pulse hurts
//                            operators); 裂管之奏 3 strikes on every dark 余音 (AoE arts + apoptosis). boss_10 + 假想敌：弦
//                            (invulnerable, gold 余音, 断弦之奏 AoE + flips them dark; leaves with 管).
//   余音                     10-hit unit, block ≥ 2 only; gold (ASPD +50) / dark (ATK +50 %, slower) forms that swap after
//                            10 strikes; pulses on every hit taken; 合奏 every 5 s.
//   boss_4 盐风主教昆图斯     2 highest-DEF targets (+ neural); 3 growth stages (33 % HP lost or 75 s / 200 s): 大潮 global
//                            arts + neural, 崩坍 delayed strikes on 2/4/8 highest-DEF units, 断裂生殖 tentacles (stun),
//                            物种爆发 LP loss (stage 3).
//   boss_5 卢西恩            evade 40 % while unblocked, DEF pen 40 %, neural on hit; AoE skill (radius 2); blinks past its
//                            blocker leaving a 不祥幻影 (same kit minus blink). Template overrides (0.2 / 0.12) apply.
//   boss_6 阿利斯泰尔        王权号令 (SP 1/s, plus-shaped 200 % strike + random equipment drop); 莫非王土 animates the
//                            latest equipment on the field (2 s after it appears, then once per 王权号令 cycle) (sword strike / directional vest + barrier / wand disarm); ≤50 %: DEF +100 %,
//                            RES +45, animates 2; 斥退 at 999 s.
//   boss_7 “萨米的意志”      冰凌 (its normal attack) hits a whole column; 自然涌动 stun + arts DoT; <50 %: damage taken
//                            ×(1−0.6), 2 targets; Doom at 600 s (LP −30). Targets via fairOrder (two players alternate).
//   boss_11 伊莎玛拉，腐化之心 (project-side, PRTS; no official level — tools/custom-content.mjs)
//                            初始形态 heals 3 allies per "attack" (data dmgType NONE disarms the engine attack); 腐化 summons
//                            2 伊莎玛拉之泪 on random deployable tiles (本项目), a tear with no target charges the leader (+25 SP/3 s); at SP 120
//                            变身 — tears vanish, ATK ×0.625 / DEF ×0.3 / RES ×0.5 / move ×0.8 / interval ×0.5 and the
//                            attack becomes 3-target TRUE damage; <50 %: ATK +50 % and 2 extra tears; 首次被击倒: 重生 5 s at
//                            2 % of the shared pool (the `taken` hook refills the pool before the kill).
// The huge leaders (SELF_BOUND: 胄 ×2, 管 ×2, 昆图斯, 阿利斯泰尔, 萨米的意志 — the 巨型单位 with a data `hitArea`) are
// 自缚 + 无法被阻挡 (PRTS 天赋): a persistent noMove + unblockable buff from spawn, so they never walk their route.
// Every leader (tag boss) ignores 侵蚀 gauge damage ("最终攻势中，敌方领袖不会受到侵蚀损伤").
// An airborne (起飞) operator is no selection of a ground leader or part (对地规避: canTargetAlly, the damage pipeline,
// the area selectors); still reach it (`ignoreSelect`): the 刺胄之弹 / 剑 / 锤 blasts (flying units, 无来源 DoT; 掷剑 /
// 掷锤 pick their operator "（无视无法选择）"), the 盲信之誓 chains ("无视无法选择"), the 法术护盾 counter on its attacker
// (a direct pick) and the ticks of a debuff already on it (【自然涌动】: a tick selects nobody).
// Every area effect of a leader or part — pulses, strikes around an echo, blasts, charges and tramples, crosses, columns,
// whole-field skills — selects with enemies/helpers.js areaAllies / areaAlliesInTiles / fieldAllies (targeting.js
// areaSelectable): no 隐匿 operator, the one blocking the unit included (GitHub #97), no untargetable or sleeping one, no 起飞 one for a
// ground unit; 迷彩 is not checked (splash-type, 中点判定 / 格子判定 or "无视迷彩" on PRTS; the rest [ASSUMED], DESIGN
// §22.12). Only 【盲信之誓】 ("无视无法选择、迷彩") takes everyone on its lines.
// LP effects ('lpLoss' hook + result.lpLoss) must be applied by the match (see the report of this module's owner).
// fx kinds: 'beam' 'shell' 'explode' 'telegraph' 'charge' 'link' 'dash' 'column' 'tide' 'rockfall' 'tentacle' 'equip'
//   'sword' 'vest' 'blink' 'summon' 'grow' 'phase' 'lpLoss' (x, y + extra {id, r, tiles, kind, tx, ty …}).

import { MOVE_SCALE } from '../constants.js';
import { aggroCmp, areaSelectable } from '../targeting.js';
import { compileRoute } from '../ai.js';
import { normalizeRoute } from '../simdata.js';
import { DIRS, frontOf } from '../dir.js';
import { PROJECTILE_SPEEDS } from '../constants.js';
import {
  ensureInstalled, abOf, attach, T, elem, hurt, targetsNear, allTargets, byPriority, areaAllies, areaAlliesInTiles, fieldAllies,
  remainingRoute, stayRoute, stepToward, setHits, hitCount, lpLoss, blinkForward, canCast, absorbArts, nthOf, setForm, zone,
} from './enemies.js';

// ---------------------------------------------------------------------------------------------------------------
// constants

/**
 * Share of the damage a 剑/锤 or a 碎铳之簧 takes that its leader loses: 1, 等量 — PRTS talents (“斩胄之剑” / “破胄之锤”
 * "受到伤害时令假想敌：胄受到等量的无来源生命流失"; 碎铳之簧 (all three) "…令全场范围内仇恨值最高的1名假想敌：铳受到等量的无来源
 * 生命流失"); the enemy data carries no ratio blackboard (the handbook's "以一定比例" is that 1). The loss is 无来源 (hooks see
 * no source; the attacker keeps the credit — stats, the per-player pool tally) and follows EVERY damage taken: a
 * 剑/锤 only takes damage outside its invulnerable 初始模式 (its 出击模式 dive and 【瘫痪】). The two official texts
 * disagree on the dive: the PRTS talent says "受到伤害时" (any damage), the in-game handbook (data/enemies.json abilities,
 * PRTS 能力) "被击落时受到伤害以一定比例传递" (only once shot down) — the dive hits passing on is [ASSUMED] (the talent
 * text; ≤ 15 hits per dive). A loss passed on to a leader is one hit for 限伤 (sim/damage.js leaderHitCancelled, via
 * Battle.loseHp). v2.5: 0.5 [ASSUMED], and a 剑/锤 passed damage on only while grounded (DESIGN §20.10, §20.13).
 */
export const PART_TRANSFER = 1;
/** The 斩胄之剑 / 破胄之锤 share — the same PRTS 等量 as PART_TRANSFER (kept as a name for the blade kit and its tests). */
export const BLADE_TRANSFER = PART_TRANSFER;
/** 破胄之锤 normal attack: 150 % ATK (PRTS 天赋 "普通攻击对攻击范围内的所有我方单位造成攻击力150%的物理普通伤害"; 斩胄之剑 100 %). */
const BLADE_ATK_SCALE = Object.freeze({ enemy_9015_acstmb: 1.5 });
/**
 * Level branches of each part (act1autochess_h08_01 / _s): 斩胄之剑 spawns on the start of `left_hand_origin` (3,12),
 * 破胄之锤 on `right_hand_origin` (3,8). `<hand>_blink` = the preset route 掷剑 blinks to (its start; PRTS "将自身路径改为
 * 关卡预设路径并闪现至路径起点"), `<hand>_origin` = the route the new 初始模式 copy is summoned on ("以关卡预设路径召唤").
 */
const BLADE_HAND = Object.freeze({ enemy_9014_acstma: 'left_hand', enemy_9015_acstmb: 'right_hand' });
/**
 * 死亡集群: a drone that dies (PRTS 能力修正 "该无人机单位死亡时", whoever kills it) costs 胄 `hp_ratio` (2 %) of "最大生命值"
 * (PRTS 假想敌：胄 "该妖怪死亡时令假想敌：胄受到最大生命值2%的真实伤害"). WHICH max HP is not documented [ASSUMED reading]:
 *   'pool' (default, = v2.5): the leader's max HP as the battle shows it — the shared pool (the engine syncs the unit's
 *          HP to it). It is the same HP the "自身生命值低于20%" talent reads, and that one must read the pool (the
 *          unit's data 600 000 is above the co-op 标准 pool 247 500 and above every solo pool, where a fixed 600 000
 *          would never drop below 20 %). A drone = 2 % of the leader bar in every mode and difficulty (终极 72 000).
 *   'unit': the in-battle unit's data max HP (600 000 / hidden 1 200 000, 不死) — 12 000 / 24 000 per drone at every
 *          difficulty: 0.33 % of the 终极 bar but 19 % of the solo 标准 bar (61 875), so drones decide solo fights.
 * Round 2 of the boss-HP review tried 'unit'; the review measured the solo regression, so the default is back to 'pool'.
 * 限伤 (shared/constants.js BOSS_HIT_LIMIT): the share is no hit and passes the limit (Battle.loseHp `noHitLimit`).
 * Since the pool counts every player alive at the fight's start (DESIGN §25.13.4, the owner's decision of 2026-10-06),
 * the hidden 胄 终极 pool reaches 21 600 000 / 28 800 000 with 3 / 4 players — a drone 432 000 / 576 000, which the
 * limit (ceil ≥ 300000) would cancel, so drones would stop counting exactly in the largest fights. [ASSUMED]: the
 * official client checks every damage modifier on a leader (research 11 §2.1) and PRTS calls the drone's 2 % 真实伤害,
 * but which max HP it reads is not documented; the remake reads the pool and keeps the 2 % share.
 */
export const DRONE_LINK_BASE = 'pool';
/** 卢西恩 / 不祥幻影 AoE radius (PRTS "半径2"). */
const LUCIEN_AOE_RADIUS = 2;
/** 余音 on-hit pulse radius (PRTS 1.6) and 合奏 radii per form (PRTS gold 0.8 / dark 1.6). */
const ECHO_PULSE_RADIUS = 1.6;
const ECHO_ENSEMBLE_RADIUS = Object.freeze({ gold: 0.8, dark: 1.6 });
/** "只能被阻挡数大于等于2的单位阻挡". */
const ECHO_BLOCK_WEIGHT = 2;
/** 裂管之奏 strike spacing (s). */
const PIPE_STRIKE_GAP = 0.4;
/** 断裂生殖 tentacle: stun duration and reach around its device tile [ASSUMED]. */
const TENTACLE_STUN = 5, TENTACLE_RADIUS = 1;
/** 崩坍 delay (PRTS 1 s), targets per growth stage (PRTS 2/4/8) and 物种爆发 delay (PRTS 4 s). */
const ROCKFALL_DELAY = 1, ROCKFALL_TARGETS = [2, 4, 8], DOOM_DELAY = 4;
/** 铳: minimum attack speed (PRTS "最低20") and charge hit radius (PRTS 0.35 — also “碎铳之簧”'s 追逐模式 trample). */
const ASPD_FLOOR = 20, CHARGE_RADIUS = 0.35;
/** 盲信之誓 link half-width (PRTS 0.5). */
const LINK_WIDTH = 0.5;
/** 碎铳之簧 bullet bounce falloff / reach [ASSUMED], combo = 十连击; tag of the damage share passed between springs. */
const SPRING_BOUNCE_FALLOFF = 0.85, SPRING_BOUNCE_RANGE = 2, SPRING_COMBO_HITS = 10, SPRING_SHARE_TAG = 'springShare';
/**
 * Leaders that are 自缚 and cannot be blocked — the 天赋 line of every 巨型单位 page (PRTS 假想敌：胄 (both copies) "自缚、
 * 不可阻挡", 假想敌：管 (+ 隐秘核心) / 盐风主教昆图斯 / 阿利斯泰尔，帝国余晖 / “萨米的意志” "自缚 … 无法被阻挡"). 自缚 (PRTS
 * 异常效果 UNMOVABLE_PRIVATE) = 无法移动, like 束缚 but never recognised as 束缚: flag noMove, not bind. They stand where
 * they spawn whatever their route says (the official routes walk to a goal; only the talent holds them), so their
 * hit area (body.js) stays on the pipe block. These are exactly the enemies with a data `hitArea`.
 */
export const SELF_BOUND = Object.freeze([
  'enemy_9013_acstmk', 'enemy_9013_acstmk_2', 'enemy_9021_acduml', 'enemy_9021_acduml_2', 'enemy_1521_dslily',
  'enemy_9032_aclionk', 'enemy_9033_acdeer',
  'enemy_1526_sfsui',   // 岁相 (boss_14)：巨型单位（hitArea 4.95×2.95），自缚 + 不可阻挡
]);
/** 阿利斯泰尔: enemy SP per second [ASSUMED] and 莫非王土 delay after each 王权号令 [ASSUMED]. */
const ENEMY_SP_PER_SEC = 1, ANIMATE_DELAY = 2;
const EQUIP_KEYS = Object.freeze(['enemy_10028_vtswd', 'enemy_10029_vtshld', 'enemy_10030_vtwand']);
const SHELL_KEY = 'enemy_9016_acstmr', ECHO_KEY = 'enemy_9023_acdums', PHANTOM_KEY = 'enemy_2017_csphts';

// ---------------------------------------------------------------------------------------------------------------
// per-battle state, template resolution

const STATE = new WeakMap();
function stOf(b) {
  let st = STATE.get(b);
  if (!st) { st = { tpl: undefined, mirrored: new Set() }; STATE.set(b, st); }
  return st;
}

const pairEq = (a, b) => Array.isArray(a) && Array.isArray(b) && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/** The wave template this battle was built from (or null). */
export function templateOf(b) {
  const st = stOf(b);
  if (st.tpl !== undefined) return st.tpl;
  const o = b.opts || {};
  for (const cand of [o.waveTemplate, o.template, o.templateId, o.waveId]) {
    if (!cand) continue;
    const t = typeof cand === 'string' ? b.data.getWave(cand) : cand;
    if (t && typeof t === 'object') { st.tpl = t; return t; }
  }
  let best = null, bestScore = 0;
  const ids = typeof b.data.waveIds === 'function' ? b.data.waveIds() : [];
  for (const id of ids) {
    const w = b.data.getWave(id);
    if (!w || !Array.isArray(w.spawns) || !Array.isArray(w.routes)) continue;
    if (!w.spawns.some((s) => s && s.tag === 'boss' && BOSS_KITS[s.key ?? s.enemyKey])) continue;
    if (w.routes.length !== b.routes.length) continue;
    let score = 1;
    if (w.routes.every((r, i) => { const n = normalizeRoute(r); const m = b.routes[i]; return m && pairEq(n.start, m.start) && pairEq(n.end, m.end); })) score += 8;
    if (/_s$/.test(id) === (b.players.length <= 1)) score += 1;
    if (score > bestScore) { best = w; bestScore = score; }
  }
  st.tpl = bestScore >= 9 ? best : null;
  return st.tpl;
}

const legSig = (legs) => legs.map((l) => `${l.t}:${l.r ?? ''},${l.c ?? ''},${l.time ?? ''}`).join('|');

/** Raw template route an enemy is walking (matched on compiled legs). */
function rawRouteOf(b, e, tpl) {
  if (!tpl || !e.route || !Array.isArray(e.route.legs)) return null;
  const sig = legSig(e.route.legs);
  for (const r of [...(tpl.routes || []), ...(tpl.extraRoutes || [])]) {
    if (!r) continue;
    try { if (legSig(compileRoute(normalizeRoute(r), b.rect)) === sig) return r; } catch { /* skip */ }
  }
  return null;
}

/** Fallback route from a position to the nearest goal. */
function toGoal(b, x, y, motion = 'WALK') {
  const ends = b.grid.specialTiles('end');
  let best = ends[0] ?? [Math.round(y), Math.round(x)], bd = Infinity;
  for (const p of ends) { const d = Math.hypot(p[0] - y, p[1] - x); if (d < bd) { bd = d; best = p; } }
  return { motion, start: [y, x], end: best, checkpoints: [] };
}

/** The extra route of a template branch's first spawn (or null). */
function branchRoute(tpl, name) {
  const br = tpl && tpl.branches && tpl.branches[name];
  const s = Array.isArray(br) && Array.isArray(br[0]) ? br[0][0] : null;
  return (s && tpl.extraRoutes && tpl.extraRoutes[s.routeIndex]) || null;
}

/** Spawn one phase of a template branch. Returns the spawned enemies. */
function branchSpawn(b, tpl, name, phaseIdx, { fallback = null, mods = null, at = null } = {}) {
  const br = tpl && tpl.branches && tpl.branches[name];
  if (!Array.isArray(br) || !br.length) return fallback ? fallback() : [];
  const phase = br[Math.max(0, Math.min(phaseIdx, br.length - 1))] || [];
  const out = [];
  for (const s of phase) {
    if (!s || (s.action && String(s.action).toUpperCase() !== 'SPAWN')) continue;
    // placeholder slots (NF/N…) of branch spawns: the match may pass the round's replacements as opts.slotKeys
    const key = (s.slot && b.opts && b.opts.slotKeys && b.opts.slotKeys[s.slot]) || s.key || s.enemyKey;
    if (!key || !String(key).startsWith('enemy_')) continue;
    const route = tpl.extraRoutes && tpl.extraRoutes[s.routeIndex];
    for (let i = 0; i < Math.max(1, s.count ?? 1); i++) {
      const u = b.spawnEnemy(key, { route: route || (at ? toGoal(b, at.x, at.y) : undefined), pos: route ? undefined : at ? [at.y, at.x] : undefined, tag: s.tag ?? null, countInTotal: s.unharmful ? false : undefined, mods });
      if (u) out.push(u);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// install

export function install(battle) {
  ensureInstalled(battle);
  battle.on('enemySpawn', ({ enemy }) => onSpawn(battle, enemy), { priority: 90 });
  // "最终攻势中，敌方领袖不会受到侵蚀损伤" (PRTS 卫戍协议：盟约/PRTS盟约记录 规则; research 06 §10.1): leaders ignore erosion gauge damage
  battle.on('elementHit', (c) => { if (c.target && c.target.isBoss && c.dmg.element === 'erosion') c.dmg.cancel = true; }, { priority: 100 });
}
export function registerMeta() {}

function onSpawn(b, e) {
  const kit = BOSS_KITS[e.defId];
  if (typeof kit !== 'function') return;
  if (SELF_BOUND.includes(e.defId)) b.addBuff(e, { key: 'boss:selfBound', persist: true, flags: { noMove: true, selfBound: true, unblockable: true } });
  const tpl = templateOf(b);
  const ab = abOf(b, e);
  let list = [];
  try { list = kit(ab, e, b, tpl) || []; } catch (err) { b._handlerError('content:bosses', e, err); }
  attach(b, e, list);
  // patrol loop for leaders / parts
  const raw = rawRouteOf(b, e, tpl);
  if (raw && Array.isArray(raw.steps) && raw.steps.some((s) => s && s.t === 'patrol')) attach(b, e, [patrolLoop()]);
  // mirrored leader for 2 players (boss_battle_multi_player)
  if (e.isBoss || e.tag === 'boss') mirror(b, e, tpl);
}

function patrolLoop() {
  return {
    tick(b, e) {
      const R = e.route;
      if (!R || !Array.isArray(R.legs) || R.legs.length < 2) return;
      if (R.legIdx >= R.legs.length - 1) { R.legIdx = 0; R.pts = null; R.waitLeft = null; }
    },
  };
}

/**
 * 挂一条**永不脱逃**的循环巡逻路线（作者 2026-10-11）。比 `patrolLoop` 稳：`advanceRoute` 在「走完一条腿」后会在**同一
 * tick 里带着余量继续处理下一腿**，所以「最后一腿是 `final`」时，它可能在 tick 内直接跨进并走完最后一腿 → `if (leg.final)
 * b.leak(e)`（门 t47 全跑出场地、阿米娅 t561 也脱逃过一次，都撞的这个）。这里**不给 `end`（不生成 final 腿）**，改为在
 * 末尾放一条 `WAIT`：到达只是等待，绝不算脱逃；一个 tick 里到 WAIT 就回卷到第 0 腿。
 * @param {any} b @param {any} e @param {{type:string, pos?:number[]}[]} checkpoints MOVE/APPEAR/… 航点（不加末尾 WAIT）
 * @returns {boolean} 路线可用吗
 */
export function loopRoute(b, e, checkpoints) {
  const cps = [...(Array.isArray(checkpoints) ? checkpoints : []), { type: 'WAIT', time: 0.2 }];
  const legs = compileRoute({ motion: 'WALK', start: [e.tileR, e.tileC], checkpoints: cps }, b.rect);
  if (!Array.isArray(legs) || legs.length < 2) return false;
  e.route = { legs, legIdx: 0, pts: null, ptIdx: 0, suffix: null, version: -1, waitLeft: null };
  if (!e.mem.loopAttached) {   // 幂等：同一个单位重复调用只挂一次回卷 tick（只换路线）
    attach(b, e, [{
      tick(b2, e2) {
        const R = e2.route;
        if (!R || !Array.isArray(R.legs) || R.legs.length < 2) return;
        if (R.legIdx >= R.legs.length - 1) { R.legIdx = 0; R.pts = null; R.ptIdx = 0; R.suffix = null; R.waitLeft = null; }
      },
    }]);
    e.mem.loopAttached = true;
  }
  return true;
}

function mirror(b, e, tpl) {
  const st = stOf(b);
  const br = tpl && tpl.branches && tpl.branches.boss_battle_multi_player;
  if (!Array.isArray(br) || !br.length || st.mirrored.has(e.defId) || (b.opts && b.opts.bossMirror === false)) return;
  if (b.players.length < 2 || e.mem.mirror) return;
  st.mirrored.add(e.defId);
  for (const s of br[0] || []) {
    const key = s.key ?? s.enemyKey;
    if (key !== e.defId) continue;
    b.after(Math.max(0, (s.time ?? 0) - b.time), () => {
      if (b.aliveEnemies().filter((o) => o.defId === key && o.isBoss).length >= 2) return; // the match already did it
      const route = tpl.extraRoutes && tpl.extraRoutes[s.routeIndex];
      const u = b.spawnEnemy(key, { route: route || undefined, tag: 'boss', mods: e.mods });
      if (u) u.mem.mirror = true;
    });
  }
}

/** 可移动领袖模板：boss 战场左右半场的列跨度（BOSS_RECT 21 列，col 10|11 为界，mirror 轴 col 20）。 */
export const BOSS_HALF_COLS = Object.freeze({ L: [2, 9], R: [11, 18] });

/**
 * 可移动领袖模板（作者 2026-10-11，对齐官方 boss_battle_multi_player，参考卢西恩）：**领袖镜像两份、各守半场**。
 * - 2 人 boss 场：本领袖巡逻**自己那半场**，并由它补一个**镜像的另一半本体**（同 defId、tag 'boss' → 自动共享同一血池，
 *   spawns.js），两个各守半场。
 * - 单人场：只有一个本体，朝有人的（左）半场巡逻。
 * 后续任何会走动的领袖都从这里走（kitSyskad / kitPatriot 已套用）：kit 的 spawn() 里
 *   `const mv = movableLeader(b, e2, halfWalk);`（`mv.mirror` 表示本体是镜像那份）。
 * 幂等：可多次调用（第一次便补上镜像本体；此后再调只刷新路线，不会补第三个）。伊莎出生即调用；爱国者出生即调用
 * （补镜像，让它能跟本体**一起**播转阶段动作）＋进入毁灭姿态时再调一次。
 * @param {any} b @param {any} e2 the leader unit
 * @param {(b:any, e:any, half:'L'|'R')=>object|null} buildWalk the half's route (`{ checkpoints:[{type:'MOVE',pos:[r,c]}] }`)
 * @returns {{ mirror: boolean }} whether this unit is the mirrored copy
 */
export function movableLeader(b, e2, buildWalk) {
  const two = b.players.length >= 2;
  const isMirror = e2.mem.mirrorLeader === true;
  const half = isMirror ? 'R' : 'L';
  const walk = buildWalk(b, e2, half);
  if (walk && Array.isArray(walk.checkpoints) && walk.checkpoints.length >= 2) {
    loopRoute(b, e2, walk.checkpoints);   // 永不脱逃的循环巡逻（loopRoute 幂等，只换路线）
  } else {
    // 没有可用的半场路线：把 spawn 默认的「走到逃生点（末腿 final）」路线换成**原地等待**——否则首领（尤其**复制体**）
    // 一解除 hold 就会沿着这条默认路线走出图外（= 突然消失、只剩本体；作者 2026-10-11）。首领绝不用脱逃路线。
    e2.route = { legs: [{ t: 'wait', time: 1e9 }], legIdx: 0, pts: null, ptIdx: 0, suffix: null, version: -1, waitLeft: null };
  }
  if (two && !isMirror) {
    b.after(0.15, () => {
      if (b.enemies.filter((o) => o.alive && o.isBoss && o.defId === e2.defId).length >= 2) return; // already two (the match's own mirror)
      const R = b.rect || { c0: 0, c1: 20 };
      const [r0, r1] = BOSS_HALF_COLS.R;
      const row = Math.round(e2.tileR);
      const walkable = (c) => !b.grid || typeof b.grid.groundPassable !== 'function' || b.grid.groundPassable(row, c);
      // 镜像列 = 关于 map 中心轴（col c0+c1）对称的列 —— 主本体在中间时镜像也落在中间附近（作者 2026-10-11）；
      // 若该列不可走则向两侧找最近的**可走**列（否则镜像原地卡死）。
      const mid = Math.max(r0, Math.min(r1, Math.round(R.c0 + R.c1 - Math.round(e2.tileC))));
      let mc = mid;
      if (!walkable(mc)) {
        for (let d = 1; d <= r1 - r0 && !walkable(mc); d++) {
          const hit = [mid - d, mid + d].find((c) => c >= r0 && c <= r1 && walkable(c));
          if (hit != null) mc = hit;
        }
      }
      const u = b.spawnEnemy(e2.defId, { pos: [row, mc], tag: 'boss', mods: e2.mods, bossMirror: true, ownerPlayerId: e2.ownerId, sourcePlayerId: e2.sourcePlayerId });
      if (u) {
        movableLeader(b, u, buildWalk);   // 镜像那份**立刻**拿到自己的半场路线（无可用路线则原地等待）——绝不用 spawn 的默认逃生路线
        b.fx('summon', { x: u.x, y: u.y, id: e2.id, key: e2.defId, n: 1 });
      }
    });
  }
  return { mirror: isMirror };
}

/**
 * A half-field patrol route: walk outward to the half's reachable edge and back, then inward to the middle boundary and
 * back (原路返回, 绕墙不穿墙) — the shape the leaders used for the whole field, confined to `half` so two leaders never
 * overlap. Scans the row for a REACHABLE column at each end (a half's outermost tile is often a wall), so it never
 * returns null just because the far tile is blocked. Builds `{ motion, start, end, checkpoints }` for movableLeader.
 * @param {any} b @param {any} e2 @param {'L'|'R'} half
 */
export function halfWalk(b, e2, half) {
  const [h0, h1] = BOSS_HALF_COLS[half] ?? BOSS_HALF_COLS.L;
  const R = b.rect || { r0: 0, r1: 5 };
  const g = b.grid, sr = Math.round(e2.tileR), sc = Math.round(e2.tileC);
  const dirOut = half === 'L' ? -1 : 1;
  /** From (row, sc) walk in `dir` to the FARTHEST reachable column of the half (scanning from the half's edge inward). */
  const rowPath = (row, dir) => {
    const limit = dir < 0 ? h0 : h1;
    for (let tc = limit; dir > 0 ? tc > sc : tc < sc; tc -= dir) {
      let p = null;
      try { p = g.findPath(row, sc, row, tc); } catch { p = null; }
      if (p && p.length >= 2) return p;
    }
    return null;
  };
  let pOut = rowPath(sr, dirOut), pIn = rowPath(sr, -dirOut), toRow = null;
  if (!pOut && !pIn) {
    // the unit's own row has no horizontal path in this half (walls / a non-walk band): step to a nearby walkable row
    for (let d = 1; d <= 4 && !pOut && !pIn; d++) {
      for (const rr of [sr + d, sr - d]) {
        if (rr < R.r0 || rr > R.r1) continue;
        const a = rowPath(rr, dirOut), bi = rowPath(rr, -dirOut);
        if (!a && !bi) continue;
        let pp = null;
        try { pp = g.findPath(sr, sc, rr, sc); } catch { pp = null; }
        if (!pp || pp.length < 2) continue;
        pOut = a; pIn = bi; toRow = pp;
        break;
      }
    }
  }
  if (!pOut && !pIn) return null;
  const cps = [];
  const push = (p) => { const last = cps[cps.length - 1]; if (!last || last.pos[0] !== p[0] || last.pos[1] !== p[1]) cps.push({ type: 'MOVE', pos: [p[0], p[1]] }); };
  const addReturn = (p) => { if (!p) return; for (const q of p) push(q); for (const q of p.slice(0, -1).reverse()) push(q); };
  if (toRow) for (const q of toRow) push(q);   // walk to the patrol row first
  addReturn(pOut);
  addReturn(pIn);
  if (cps.length < 2) return null;
  return { motion: 'WALK', start: [sr, sc], end: cps[cps.length - 1].pos, checkpoints: cps };
}

// ---------------------------------------------------------------------------------------------------------------
// shared bits

const opsOnly = (list) => list.filter((u) => u.kind === 'op');
const nearestOf = (b, e, pred) => {
  let best = null, bd = Infinity;
  for (const o of b.enemies) { if (!o.alive || o === e || !pred(o)) continue; const d = Math.hypot(o.x - e.x, o.y - e.y); if (d < bd) { bd = d; best = o; } }
  return best;
};
/** Apply a floor to an enemy whose data attack speed is 0 (skill-driven leaders: 铳/管/弦). */
function aspdFloor(b, e, extra = 0) {
  const rawAspd = e.def.raw && e.def.raw.stats ? Number(e.def.raw.stats.aspd) : NaN;
  if (!(rawAspd === 0)) return;
  b.addBuff(e, { key: 'boss:aspd', persist: true, mods: { aspd: Math.max(ASPD_FLOOR, rawAspd + extra) - e.base.aspd } });
}
/**
 * Engine target priority (blocker → taunt → latest deployed), made fair for two players on one boss field: within the top
 * priority tier the picks alternate between the players' units, starting with the other player each call. Both
 * players deploy at t = 0, so "latest deployed" alone would always single out the second player [ASSUMED fairness
 * rule]. `P.turn` keeps the rotation.
 */
export function fairOrder(b, e, list, P) {
  const l = byPriority(e, list);
  if (b.players.length < 2 || l.length < 2) return l;
  const key = (u) => `${e.blockedBy === u ? 0 : 1}|${u.s.taunt || 0}`;
  const top = key(l[0]);
  const tier = l.filter((u) => key(u) === top), rest = l.filter((u) => key(u) !== top);
  const ids = b.players.map((p) => p.playerId);
  P.turn = ((P.turn ?? -1) + 1) % ids.length;
  const queues = ids.map((pid) => tier.filter((u) => u.ownerId === pid));
  const out = [];
  for (let k = 0; out.length < tier.length && k < tier.length * ids.length + ids.length; k++) {
    const q = queues[(P.turn + k) % ids.length];
    if (q.length) out.push(q.shift());
  }
  for (const u of tier) if (!out.includes(u)) out.push(u);
  return out.concat(rest);
}

/**
 * Stun + phys DoT on the 3×3 around (r, c), credited to `src` (胄). The blast is a flying unit's — `by`: 刺胄之弹 /
 * 斩胄之剑 / 破胄之锤 (PRTS 行动方式 飞行) — and its damage 无来源, so 对地规避 does not stop it: `ignoreSelect` (an airborne
 * 起飞 ally in the 3×3 is stunned and hurt like the others, although the credited 胄 walks). It is still that unit's area
 * selection (PRTS: "令自身周围8格内的所有我方单位…" / "…无视迷彩，可对空", no 无视无法选择): areaAlliesInTiles of `by` — no
 * 隐匿 ally, the one blocking it included (GitHub #97; 掷剑 / 掷锤's "无视无法选择" is their pick of the operator they fly at, not the blast).
 */
function stunBlast(b, src, by, r, c, stun, dot, dur, kind) {
  b.fx('explode', { x: c, y: r, r: 1.5, kind, tiles: 'box' });
  for (const u of areaAlliesInTiles(b, by, r, c, 'box', 1)) {
    if (stun > 0) b.applyStatus(u, 'stun', { duration: stun, source: src, ignoreSelect: true });
    if (dot > 0 && dur > 0) b.addBuff(u, { key: `boss:${kind}Dot`, duration: dur, refresh: 'replace', interval: 1, visible: true,
      onTick: ({ battle, unit }) => battle.dealDamage(src, unit, { amount: dot, type: 'phys', canDodge: false, ignoreSelect: true, tags: ['enemyAbility', kind] }) });
  }
}
/** Distance from point p to segment a–b. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---------------------------------------------------------------------------------------------------------------
// 假想敌：胄 (boss_1 / boss_8) + 刺胄之弹 + 斩胄之剑 / 破胄之锤

function kitHelm(ab, e, b, tpl) {
  const s1 = ab.sk['1'], s2 = ab.sk['2'];
  const lowRatio = T(ab, '1.hp_ratio') ?? 0, lowScale = T(ab, '1.damage_scale') ?? 1;
  const P = { low: false };
  const range = () => e.base.rangeRadius || 8;
  // 灭顶之灾 "触发索敌和普通攻击相同：选择攻击范围内攻击力最高的1名我方干员" (PRTS 技能, both copies)
  const shellTargets = (b2) => opsOnly(targetsNear(b2, e, range()));
  return [
    {
      spawn(b2, e2, a, ab2) { ab2.atkType = 'arts'; },
      before(c, b2, e2) { const l = targetsNear(b2, e2, range()); if (l.length) c.targets = [b2.rng.pick(l)]; }, // 随机选择目标
      attack(c, b2, e2) { const t = c.targets[0]; if (t) b2.fx('beam', { x: e2.x, y: e2.y, from: e2.id, to: t.id, kind: 'helmRay' }); },
      iv: 0.25,
      tick(b2, e2) {
        if (P.low || !(e2.hpRatio < lowRatio)) return;
        P.low = true;                                     // <20 %: damage taken ×0.5 (no extra shell: see 灭顶之灾)
        b2.addBuff(e2, { key: 'boss:helmGuard', persist: true, visible: true, mods: { physTakenMul: lowScale, artsTakenMul: lowScale } }); // 物理与法术伤害降低
        b2.fx('phase', { x: e2.x, y: e2.y, id: e2.id, kind: 'helmLow' });
      },
    },
    s1 && {
      cd: s1.cd, icd: s1.icd, cond: (b2) => shellTargets(b2).length > 0,
      // 【灭顶之灾】 one shell, also below 20 %: the handbook's "额外发射<刺胄之弹>" is wrong in game (PRTS 能力修正 原因 6
      // "描述与游戏实际表现不符合": "【灭顶之灾】不会额外发射") and no blackboard holds a second shell (skill 1 has none)
      fire(b2, e2) {
        const t = shellTargets(b2).sort((p, q) => q.s.atk - p.s.atk || aggroCmp(p, q))[0];
        if (t) fireShell(b2, e2, t);
      },
    },
    s2 && {
      cd: s2.cd, icd: s2.icd,
      // 【死亡集群】: a drone on the branch route; when it dies (PRTS 能力修正 "该无人机单位死亡时", whoever kills it) the leader
      // loses hp_ratio × max HP. Drone HP: `summon.hp_ratio` (隐秘核心 only) scales it [ASSUMED: the summon's max HP]; the
      // `max_hp` 0.5 both copies carry is not read [ASSUMED] — no source says what it does (PRTS 技能 lists the 2 % only,
      // the 妖怪 page has no summon rule, the level gives the 妖怪 no override; as an attribute key it would be +50 %).
      fire(b2, e2) {
        const hpMul = s2.bb['summon.hp_ratio'] > 0 ? s2.bb['summon.hp_ratio'] : null;
        const key = s2.bs.enemy_key ?? 'enemy_1005_yokai';
        const drones = branchSpawn(b2, tpl, s2.bs.branch_id ?? 'boss_summon_enemy', 0, {
          mods: hpMul ? { hpMul } : null, at: { x: e2.x, y: e2.y },
          fallback: () => [b2.spawnEnemy(key, { pos: [e2.y, e2.x], route: toGoal(b2, e2.x, e2.y, 'FLY'), mods: hpMul ? { hpMul } : null })].filter(Boolean),
        });
        b2.fx('summon', { x: e2.x, y: e2.y, id: e2.id, key, n: drones.length });
        const ratio = s2.bb.hp_ratio ?? 0;
        for (const d of drones) attach(b2, d, [{
          death(c, b3) {
            if (c.reason !== 'killed' || !(ratio > 0)) return;                 // a leak is no death
            const boss = e2.alive ? e2 : b3.aliveEnemies().find((o) => o.isBoss && o.defId === e2.defId);
            const by = c.killer && c.killer.side === 'ally' ? c.killer : null;  // credited to the killing operator
            if (boss) { b3.loseHp(boss, droneLinkBase(boss) * ratio, { source: by, noHitLimit: true }); b3.fx('beam', { x: d.x, y: d.y, from: d.id, to: boss.id, kind: 'droneLink' }); }
          },
        }]);
      },
    },
  ];
}

/**
 * Max HP the 死亡集群 drone link reads (DRONE_LINK_BASE): 'pool' = the leader's shown max HP (the shared pool), 'unit' =
 * the unit's data max HP (template × spawn hpMul).
 */
export function droneLinkBase(boss, base = DRONE_LINK_BASE) {
  if (base !== 'unit' || !boss.def || !(boss.def.maxHp > 0)) return boss.s.maxHp;
  const m = boss.mods && Number(boss.mods.hpMul);
  return boss.def.maxHp * (Number.isFinite(m) && m > 0 ? m : 1);
}

/** Launch a 刺胄之弹 from `boss` at `target`'s tile. */
function fireShell(b, boss, target) {
  const tr = target.tileR, tc = target.tileC;
  const sh = b.spawnEnemy(SHELL_KEY, { pos: [boss.y, boss.x], route: { motion: 'FLY', start: [boss.y, boss.x], end: [tr, tc], steps: [{ t: 'wait', s: 99999 }] }, tag: 'part', countInTotal: false, ownerPlayerId: boss.ownerId });
  if (!sh) return null;
  sh.mem.ab.shell = { tr, tc, boss };
  b.fx('shell', { x: boss.x, y: boss.y, id: sh.id, tx: tc, ty: tr, r: 1.5, kind: 'helmShell' });
  return sh;
}

function kitShell(ab, e) {
  const stun = T(ab, 'killed.duration') ?? 0, dot = T(ab, 'killed.value') ?? 0;
  return [{
    spawn(b, e2) {
      setHits(e2, e2.def.maxHp); hitCount(b, e2, true);                       // 需要数次攻击击倒
      b.addBuff(e2, { key: 'boss:shellGuard', persist: true, flags: { noDisplace: true } }); // 失衡免疫 (PRTS 天赋; also 静态刚体)
    },
    tick(b, e2, a, dt) {
      const s = e2.mem.ab.shell;
      if (!s || a.done) return;
      if (!stepToward(e2, s.tc, s.tr, e2.s.moveSpeed * MOVE_SCALE * dt)) return;
      a.done = true;                                            // arrival: 3×3 long stun + phys DoT
      stunBlast(b, s.boss && s.boss.alive ? s.boss : e2, e2, s.tr, s.tc, stun, dot, stun, 'helmShell');
      b.kill(e2, null);
    },
  }];
}

/**
 * “斩胄之剑” / “破胄之锤” (PRTS 天赋 + 技能 掷剑 / 掷锤; numbers from skill 1's blackboard).
 *   初始模式 ('hover'): 无敌 + 自缚 [ASSUMED: also untargetable, so operators spend no attacks on it]; AoE physical attack
 *     on every ally in its range (锤 150 % ATK, BLADE_ATK_SCALE).
 *   掷剑 (skill 1 cd / icd, an operator on the field) → 出击模式 ('dive'): no normal attack, vulnerable; blinks to the start
 *     of its `<hand>_blink` route and flies at the tile of the lowest-ATK operator (无视无法选择).
 *   Arriving (no 【瘫痪】): `stun` s stun + `dot_damage`/s for `dot_duration` s on the 3×3 around it, then it is replaced.
 *   Once, after `max_hit_cnt` damage instances: 【瘫痪】 ('down') — `special_stun_duration` s, but it ends with its own
 *     `stun` s stun ("该晕眩结束时也会结束【瘫痪】"): ground unit, damage taken ×`damage_scale`; when it ends, replaced.
 *   Replaced: a new 初始模式 copy with its current HP is summoned on its `<hand>_origin` route (at home without a template),
 *     then it is killed (强制击杀自身; a part: no kill count, no bounty). The copy is a new unit [ASSUMED: only its HP is
 *     inherited] — its 掷剑 starts from the initial cooldown again, so the data's cooldown (80 s) never comes into play.
 *   Every damage it takes is lost by 假想敌：胄 too (BLADE_TRANSFER = PART_TRANSFER 1, 无来源, credited to the attacker).
 */
function kitBlade(ab, e, b, tpl) {
  const s = ab.sk['1'];
  const bb = s ? s.bb : {};
  const hand = BLADE_HAND[e.defId];
  const P = { state: 'hover', home: { x: e.x, y: e.y }, hits: 0, target: null };
  const leader = (b2) => nearestOf(b2, e, (o) => o.isBoss && /enemy_9013_acstmk/.test(o.defId));
  const hover = (b2, on) => {
    if (on) b2.addBuff(e, { key: 'boss:hover', persist: true, visible: true, flags: { invulnerable: true, untargetable: true } });
    else b2.removeBuff(e, 'boss:hover');
  };
  const replace = (b2, e2) => { // 以关卡预设路径召唤一个继承自身生命值的初始模式的 copy，随后强制击杀自身
    P.state = 'gone';
    e2.motion = 'FLY';
    const origin = hand ? branchRoute(tpl, `${hand}_origin`) : null;
    const home = [P.home.y, P.home.x];
    const n = b2.spawnEnemy(e2.defId, {
      route: origin || { motion: 'FLY', start: home, end: home, steps: [{ t: 'wait', s: 99999 }] }, pos: origin ? undefined : home,
      tag: e2.tag, countInTotal: false, mods: e2.mods, ownerPlayerId: e2.ownerId,
    });
    if (n) { n.hp = Math.min(n.s.maxHp, e2.hp); b2.fx('blink', { x: n.x, y: n.y, id: n.id, fx: e2.x, fy: e2.y }); }
    b2.kill(e2, null);
  };
  const shotDown = (b2, e2) => { // 【瘫痪】
    P.state = 'down';
    e2.motion = 'WALK';                                              // 变为地面单位（不改变寻路方式）
    const stun = bb.stun ?? 0;
    b2.applyStatus(e2, 'stun', { duration: stun, source: null, force: true });
    b2.addBuff(e2, { key: 'boss:downed', duration: Math.min(bb.special_stun_duration ?? stun, stun), visible: true,
      mods: { dmgTakenMul: bb.damage_scale ?? 1 }, onExpire: () => { if (e2.alive && P.state === 'down') replace(b2, e2); } });
    b2.fx('phase', { x: e2.x, y: e2.y, id: e2.id, kind: 'shotDown' });
  };
  return [
    {
      spawn(b2, e2) {
        hover(b2, true);
        // 自缚 (moved by hand) · 不可阻挡 · 失衡免疫 (PRTS 天赋 "{{特殊机制|静态刚体}}，不可阻挡、失衡免疫…" — data `staticBody` too)
        b2.addBuff(e2, { key: 'boss:anchor', persist: true, flags: { noMove: true, selfBound: true, unblockable: true, noDisplace: true } });
        if (BLADE_ATK_SCALE[e2.defId]) e2.profile.atkScale = BLADE_ATK_SCALE[e2.defId];
      },
      // 范围物理伤害 — "普通攻击对攻击范围内的所有我方单位造成…物理普通伤害": a normal attack on every operator it can target
      // (canTargetAlly: no 隐匿 or 迷彩 one — it is never blocked —, PRTS 选择器: a normal attack does not ignore 迷彩; until
      // 0.1.2 it took them all, `ranged: false`)
      before(c, b2, e2) { const l = targetsNear(b2, e2, e2.base.rangeRadius || 1.6); if (l.length) c.targets = l; },
      taken(c, b2, e2) {
        if (c.amount > 0) { // 受到伤害时令假想敌：胄受到等量的无来源生命流失 (【瘫痪】; 出击模式 [ASSUMED], see PART_TRANSFER)
          const L = leader(b2);
          const src = c.source || c.credit;                                    // a 无来源 burst still passes on (credited)
          if (L) b2.loseHp(L, c.amount * BLADE_TRANSFER, { source: src && src.side === 'ally' ? src : null, from: c.dmg, sourceless: true });
        }
        if (P.state === 'dive' && e2.alive && ++P.hits >= (bb.max_hit_cnt ?? Infinity)) shotDown(b2, e2); // 仅1次
      },
      tick(b2, e2, a, dt) {
        if (P.state !== 'dive' || !canCast(e2)) return;                         // a stunned blade does not fly on
        const t = P.target;
        if (!stepToward(e2, t.c, t.r, e2.s.moveSpeed * MOVE_SCALE * dt)) return;
        // arrival: 3×3 stun + DoT (无来源: credited to 胄, as the shell's), then the 初始模式 copy takes over
        stunBlast(b2, leader(b2) || e2, e2, t.r, t.c, bb.stun ?? 0, bb.dot_damage ?? 0, bb.dot_duration ?? 0, 'bladeDive');
        replace(b2, e2);
      },
    },
    s && {
      cd: s.cd, icd: s.icd, cond: (b2) => P.state === 'hover' && opsOnly(allTargets(b2, e)).length > 0, // 存在至少1名可选我方干员
      fire(b2, e2) { // 【掷剑】/【掷锤】 → 出击模式
        const t = opsOnly(b2.allies()).sort((p, q) => p.s.atk - q.s.atk || aggroCmp(p, q))[0];
        if (!t) return;
        P.state = 'dive'; P.hits = 0; P.target = { r: t.tileR, c: t.tileC };
        hover(b2, false);
        b2.addBuff(e2, { key: 'boss:sortie', persist: true, flags: { disarm: true } }); // 出击模式：不进行普通攻击
        const blink = hand ? branchRoute(tpl, `${hand}_blink`) : null;
        if (blink && Array.isArray(blink.start)) {
          const from = { x: e2.x, y: e2.y };
          e2.x = blink.start[1]; e2.y = blink.start[0];
          b2.fx('blink', { x: e2.x, y: e2.y, id: e2.id, fx: from.x, fy: from.y });
        }
        b2.fx('charge', { x: e2.x, y: e2.y, id: e2.id, tx: t.tileC, ty: t.tileR, kind: 'bladeDive' });
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 假想敌：铳 (boss_2 / boss_9) + 碎铳之簧

const isGun = (o) => /enemy_9017_achunt/.test(o.defId);
const isSpring = (o) => /enemy_90(18|19|20)_actrp/.test(o.defId);

function kitGun(ab, e, b) {
  const hidden = /_2$/.test(e.defId);
  const step = T(ab, '2.attack_speed') ?? 0, maxN = T(ab, '2.max_stack_cnt') ?? 0;
  const P = { last: null, n: 0, charge: null };
  const range = () => e.base.rangeRadius || 2;
  const setAspd = (b2) => aspdFloor(b2, e, step * P.n);
  const s1 = ab.sk['1'], s2 = ab.sk['2'], s3 = ab.sk['3'];
  const groundTargets = (b2) => allTargets(b2, e).filter((u) => u.ground);
  const list = [
    {
      spawn(b2, e2) { b2.addBuff(e2, { key: 'boss:unblockable', persist: true, flags: { unblockable: true } }); setAspd(b2); },
      before(c, b2, e2) { const l = targetsNear(b2, e2, range()); if (l.length) c.targets = [l.sort((p, q) => q.s.def - p.s.def || aggroCmp(p, q))[0]]; }, // 优先攻击防御力最高的单位
      attack(c, b2) {
        const t = c.targets[0];
        if (t === P.last) P.n = Math.min(maxN, P.n + 1); else { P.last = t; P.n = 0; }
        setAspd(b2);
      },
      dealt(c, b2, e2) { elem(b2, e2, c.target, 'erosion', e2.s.atk * (T(ab, '1.ep_damage_ratio') ?? 0)); }, // 攻击时附带侵蚀损伤
      tick(b2, e2, a, dt) {
        const ch = P.charge;
        if (!ch) return;
        const t = ch.target;
        const sp = (e2.s.moveSpeed + (T(ab, '3.move_speed') ?? 0)) * MOVE_SCALE * dt;
        const nx = e2.x, ny = e2.y;
        const arrived = stepToward(e2, t.x, t.y, sp);
        if (!b2.grid.groundPassable(Math.round(e2.y), Math.round(e2.x))) { e2.x = nx; e2.y = ny; }
        // "对进入自身0.35半径范围内的我方单位（包括飞行单位）造成一次…": an area selection (areaAllies)
        for (const u of areaAllies(b2, e2, e2.x, e2.y, CHARGE_RADIUS)) if (!ch.hit.has(u)) { ch.hit.add(u); hurt(b2, e2, u, e2.s.atk * (T(ab, '3.atk_scale') ?? 1), 'phys'); }
        if (arrived || b2.time >= ch.until || (e2.x === nx && e2.y === ny)) {
          P.charge = null;
          b2.removeBuff(e2, 'boss:charge');
          if (e2.route) e2.route.pts = null;
        }
      },
    },
    s1 && {
      cd: s1.cd, icd: s1.icd, cond: (b2) => groundTargets(b2).length > 0 && !P.charge,
      fire(b2, e2) { // 【最终之罚】 charge at the highest-DEF ground unit
        const t = groundTargets(b2).sort((p, q) => q.s.def - p.s.def || aggroCmp(p, q))[0];
        if (!t) return;
        const dur = T(ab, '3.duration') ?? 0;
        P.charge = { target: { x: t.x, y: t.y }, until: b2.time + dur, hit: new Set() };
        b2.addBuff(e2, { key: 'boss:charge', duration: dur, visible: true, flags: { noMove: true, disarm: true } });
        b2.fx('charge', { x: e2.x, y: e2.y, id: e2.id, tx: t.x, ty: t.y, kind: 'finalPenance' });
      },
    },
  ];
  if (hidden) {
    list.push({
      iv: 0.25,
      tick(b2, e2) { // 【未尽的告解】 physical / arts damage taken ×4.damage_scale while the 碎铳之簧 it came with remain
        const springs = b2.enemies.some((o) => o.alive && isSpring(o));
        if (springs) { const m = T(ab, '4.damage_scale') ?? 1; b2.addBuff(e2, { key: 'boss:confession', duration: 0.35, refresh: 'replace', mods: { physTakenMul: m, artsTakenMul: m } }); }
      },
    });
    if (s3) list.push({
      iv: s3.bb.interval ?? 1,
      tick(b2, e2) { // 【盲信之誓】 links: phys per second on operators standing on a line ("无视无法选择、迷彩": 起飞 too)
        for (const sp of b2.enemies) {
          if (!sp.alive || !isSpring(sp)) continue;
          b2.fx('link', { x: e2.x, y: e2.y, from: e2.id, to: sp.id, kind: 'faithLink', dur: s3.bb.interval ?? 1 });
          for (const u of b2.allies()) if (segDist(u.x, u.y, e2.x, e2.y, sp.x, sp.y) <= LINK_WIDTH) hurt(b2, e2, u, s3.bb.value ?? 0, 'phys', { ignoreSelect: true, tags: ['faithLink'] });
        }
      },
    });
    if (s2) list.push({
      cd: s2.cd, icd: s2.icd, cond: (b2) => b2.enemies.some((o) => o.alive && isSpring(o)),
      fire(b2, e2) { // 【末日布道】 springs dash to 铳, invulnerable, trampling operators
        // PRTS “碎铳之簧” 追逐模式 "不进行普通攻击": `disarm` for the dash (until 0.1.3 it kept shooting while it ran)
        for (const sp of b2.enemies) {
          if (!sp.alive || !isSpring(sp) || !sp.mem.ab) continue;
          sp.mem.ab.dash = { until: b2.time + (s2.bb.dog_duration ?? 0), mul: 1 + (s2.bb.move_speed ?? 0), gun: e2, hit: new Set() };
          b2.addBuff(sp, { key: 'boss:dash', duration: s2.bb.dog_duration ?? 0, visible: true, flags: { invulnerable: true, noMove: true, unblockable: true, disarm: true } });
          b2.fx('dash', { x: sp.x, y: sp.y, id: sp.id, tx: e2.x, ty: e2.y });
        }
      },
    });
  }
  return list;
}

function kitSpring(ab, e) {
  const kind = /9018/.test(e.defId) ? 'arts' : /9019/.test(e.defId) ? 'element' : 'hits';
  const scale = T(ab, '1.damage_scale') ?? 1, regen = T(ab, '1.regenerate_duration') ?? 0;
  const P = { up: false, barrier: 0, hits: 0, downAt: null };
  const gun = (b) => nearestOf(b, e, (o) => isGun(o));
  const raise = (b) => {
    P.up = true;
    if (kind === 'arts') P.barrier = e.s.maxHp * (T(ab, '1.shield_ratio') ?? 0);
    if (kind === 'hits') P.hits = T(ab, '1.block_damage_max_times') ?? 0;
    b.addBuff(e, { key: 'boss:springShield', persist: true, visible: true, flags: { unblockable: true } }); // 护盾生效时，自身无法被阻挡
    b.fx('phase', { x: e.x, y: e.y, id: e.id, kind: `spring_${kind}` });
  };
  const drop = (b) => { P.up = false; P.downAt = b.time; b.removeBuff(e, 'boss:springShield'); b.fx('shieldBreak', { x: e.x, y: e.y, id: e.id }); };
  const sk = ab.sk['1'];
  return [
    {
      spawn(b) { raise(b); },
      hitIn(c, b, e2) {
        if (!P.up) return;
        const ty = c.dmg.type;
        if (kind === 'arts') {                           // 法术屏障: absorbs arts (after RES, like a shield); phys ×0.1 + counter
          if (ty === 'arts') {
            P.barrier -= absorbArts(c, P.barrier);
            if (P.barrier <= 1e-6) { P.barrier = 0; drop(b); }
          } else if (ty === 'phys') {
            c.dmg.mul *= scale;
            // the counter "对来源造成…无来源物理附加伤害" picks its attacker directly — no selection, so an airborne 起飞
            // attacker takes it too (PRTS 异常效果 无法选择: "'直接选中'的能力…不受这些仅在选择时生效的异常效果制约")
            const s = c.source, o = { ignoreSelect: true, tags: ['springCounter'] };
            if (s && s.side === 'ally' && s.alive) { hurt(b, e2, s, e2.s.atk * (T(ab, '1.atk_scale') ?? 0), 'phys', o); elem(b, e2, s, 'erosion', e2.s.atk * (T(ab, '1.ep_damage_ratio') ?? 0), o); }
          }
        } else if (kind === 'element') {                 // 元素护盾: phys/arts heavily reduced
          if (ty === 'phys' || ty === 'arts') c.dmg.mul *= scale;
        } else if (ty === 'phys' || ty === 'arts' || ty === 'true') { // 频次护盾: negates N hits
          c.dmg.cancel = true;
          if (--P.hits <= 0) drop(b);
        }
      },
      burst(c, b) { if (kind === 'element' && P.up) drop(b); },  // 自身元素损伤爆发时，护盾消失
      taken(c, b, e2) {
        if (!(c.amount > 0)) return;
        if (c.dmg.tags && c.dmg.tags.includes(SPRING_SHARE_TAG)) return;       // a share never passes on again
        const s0 = c.source || c.credit;                                       // a 无来源 burst still passes on (credited)
        const src = s0 && s0.side === 'ally' ? s0 : null;
        // 【盲信之誓】 受到伤害时令假想敌：铳受到等量的无来源生命流失 (PRTS); the even split to the other springs follows the
        // 隐秘核心 handbook ("传递给<假想敌：铳>和场上其他<“碎铳之簧”>") — not in the PRTS talent, [ASSUMED] amount
        const g = gun(b);
        if (g) b.loseHp(g, c.amount * PART_TRANSFER, { source: src, from: c.dmg, sourceless: true });
        const others = b.enemies.filter((o) => o.alive && o !== e2 && isSpring(o));
        for (const o of others) b.loseHp(o, (c.amount * PART_TRANSFER) / others.length, { source: src, from: c.dmg, tags: [SPRING_SHARE_TAG], sourceless: true });
      },
      tick(b, e2, a, dt) {
        if (!P.up && P.downAt != null && b.time - P.downAt >= regen) raise(b);
        const d = e2.mem.ab.dash;
        if (!d) return;
        const g = d.gun && d.gun.alive ? d.gun : gun(b);
        const arrived = !g || stepToward(e2, g.x, g.y, e2.s.moveSpeed * d.mul * MOVE_SCALE * dt) || Math.hypot(g.x - e2.x, g.y - e2.y) < 1;
        // 追逐模式 "对进入自身0.35半径范围内的我方单位（包括飞行单位）造成一次攻击力100%的物理普通伤害" (until 0.1.3: radius 0.5)
        for (const u of areaAllies(b, e2, e2.x, e2.y, CHARGE_RADIUS)) if (!d.hit.has(u)) { d.hit.add(u); hurt(b, e2, u, e2.s.atk, 'phys'); }
        if (arrived || b.time >= d.until) { e2.mem.ab.dash = null; b.removeBuff(e2, 'boss:dash'); if (e2.route) e2.route.pts = null; }
      },
    },
    // while shielded, every (spCost+1)-th attack (enemy SP +1 per attack, as 粉碎攻坚手's official text) adds the shield's
    // special attack on that attack's target
    (kind === 'element' || kind === 'hits') && sk && {
      attack(c, b, e2, a) {
        if (!P.up) return;
        a.n = (a.n ?? 0) + 1;
        if (a.n % nthOf(sk)) return;
        const t0 = c.targets.find((u) => u && u.alive);
        if (!t0) return;
        if (kind === 'element') { // bouncing element bullet: `times` targets, weaker after each bounce
          const times = sk.bb.times || 1, ratio = sk.bb.ep_damage_ratio || 0;
          let t = t0;
          const hit = new Set();
          for (let k = 0; k < times && t; k++) {
            hit.add(t);
            b.fx('beam', { x: e2.x, y: e2.y, from: e2.id, to: t.id, kind: 'springBullet' });
            elem(b, e2, t, 'erosion', e2.s.atk * ratio * Math.pow(SPRING_BOUNCE_FALLOFF, k));
            const prev = t;
            t = areaAllies(b, e2, prev.x, prev.y, SPRING_BOUNCE_RANGE).filter((u) => !hit.has(u)).sort((p, q) => Math.hypot(p.x - prev.x, p.y - prev.y) - Math.hypot(q.x - prev.x, q.y - prev.y) || aggroCmp(p, q))[0];
          }
        } else { // 十连击
          b.fx('beam', { x: e2.x, y: e2.y, from: e2.id, to: t0.id, kind: 'springCombo' });
          for (let i = 0; i < SPRING_COMBO_HITS && t0.alive; i++) hurt(b, e2, t0, e2.s.atk * (sk.bb.atk_scale || 0), 'phys');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 假想敌：管 (boss_3 / boss_10) + 假想敌：弦 + “余音”

const echoesOf = (b, form) => b.enemies.filter((o) => o.alive && o.defId === ECHO_KEY && o.mem.ab && o.mem.ab.form === form);

/** Switch an echo's form. */
export function setEchoForm(b, echo, form) {
  const ab = echo.mem.ab;
  if (!ab) return;
  ab.form = form;
  ab.strikes = 0;
  const mods = form === 'gold' ? { aspd: T(ab, '1.attack_speed') ?? 0 } : { atkPct: T(ab, '2.atk') ?? 0, moveMul: 1 - (T(ab, '2.move_speed') ?? 0) };
  b.addBuff(echo, { key: 'boss:echoForm', persist: true, visible: true, mods });
  b.fx('phase', { x: echo.x, y: echo.y, id: echo.id, kind: `echo_${form}` });
}

/** An echo takes a strike/hit: pulse around it (PRTS “余音” "受到伤害时对半径1.6范围内的我方单位造成…": an area selection of the
 *  echo — no unblocking 隐匿 operator) and count towards the form switch. */
export function echoHit(b, echo) {
  const ab = echo.mem.ab;
  if (!ab || !echo.alive) return;
  const atk = echo.s.atk;
  b.fx('explode', { x: echo.x, y: echo.y, r: ECHO_PULSE_RADIUS, kind: 'echoPulse' });
  for (const u of areaAllies(b, echo, echo.x, echo.y, ECHO_PULSE_RADIUS)) {
    hurt(b, echo, u, atk * (T(ab, '3.atk_scale') ?? 0), 'arts');
    elem(b, echo, u, 'apoptosis', atk * (T(ab, '3.ep_damage_ratio') ?? 0));
  }
  const need = ab.form === 'gold' ? T(ab, '1.hit_times_to_switch') : T(ab, '2.hit_times_to_switch');
  ab.strikes = (ab.strikes ?? 0) + 1;
  if (need > 0 && ab.strikes >= need) setEchoForm(b, echo, ab.form === 'gold' ? 'dark' : 'gold');
}

function kitEcho(ab, e) {
  const s = ab.sk.Skill;
  return [
    {
      spawn(b, e2) { setHits(e2, e2.def.maxHp); hitCount(b, e2, true); e2.blockWeight = ECHO_BLOCK_WEIGHT; setEchoForm(b, e2, 'dark'); },
      taken(c, b, e2) { const s = c.source || c.credit; if (s && s.side === 'ally') echoHit(b, e2); }, // 受到伤害时以自身为中心造成一次范围伤害 (a 无来源 burst too)
    },
    s && {
      cd: s.cd, icd: s.icd,
      fire(b, e2) { // 合奏
        const gold = e2.mem.ab.form === 'gold';
        const r = gold ? ECHO_ENSEMBLE_RADIUS.gold : ECHO_ENSEMBLE_RADIUS.dark;
        const ratio = gold ? T(ab, '4.ep_damage_ratio_passion') ?? 0 : T(ab, '4.ep_damage_ratio_depassion') ?? 0;
        b.fx('explode', { x: e2.x, y: e2.y, r, kind: gold ? 'ensembleGold' : 'ensembleDark' });
        for (const u of areaAllies(b, e2, e2.x, e2.y, r)) { hurt(b, e2, u, e2.s.atk, 'arts'); elem(b, e2, u, 'apoptosis', e2.s.atk * ratio); }
      },
    },
  ];
}

/** 管 / 弦 core: summon loop, strikes on its own form of 余音, skill. */
function pipeCore(ab, e, b, tpl, { form, prefix }) {
  const hi = T(ab, `1.${prefix}_t_1[high_hp].interval`) ?? 40, lo = T(ab, `1.${prefix}_t_1[low_hp].interval`) ?? hi, thr = T(ab, '1.hp_ratio') ?? 0;
  const key = ab.tS['1.enemy_key'] ?? ECHO_KEY;
  const P = { acc: 0, atk: Infinity };   // first strike as soon as an echo of its form exists (engine attack rule)
  const summon = (b2, e2) => {
    const got = branchSpawn(b2, tpl, 'summon_enemy', 0, { at: { x: e2.x, y: e2.y }, fallback: () => [b2.spawnEnemy(key, { pos: [e2.y, e2.x], route: toGoal(b2, e2.x, e2.y) })].filter(Boolean) });
    for (const u of got) if (u.defId === ECHO_KEY && form === 'gold') setEchoForm(b2, u, 'gold');
    b2.fx('summon', { x: e2.x, y: e2.y, id: e2.id, key, n: got.length });
  };
  return {
    spawn(b2, e2) { e2.profile.noAttack = true; aspdFloor(b2, e2); },
    tick(b2, e2, a, dt) {
      P.acc += dt;
      if (P.acc >= (e2.hpRatio < thr ? lo : hi)) { P.acc = 0; summon(b2, e2); }
      if (!canCast(e2, false)) return;
      P.atk += dt;
      if (P.atk < e2.s.interval) return;
      const t = b2.rng.pick(echoesOf(b2, form));                 // 优先攻击…形态余音
      if (!t) return;
      P.atk = 0;
      e2.lastAttackAt = b2.time;
      e2.stats.attacks++;
      b2.fx('beam', { x: e2.x, y: e2.y, from: e2.id, to: t.id, kind: `${prefix}Strike` });
      echoHit(b2, t);
    },
  };
}

function kitPipe(ab, e, b, tpl) {
  const s = ab.sk['1'];
  return [
    pipeCore(ab, e, b, tpl, { form: 'dark', prefix: 'acduml' }),
    {
      death(c, b2) { for (const o of b2.aliveEnemies()) if (o.defId === 'enemy_9022_acdumm') b2.kill(o, null); }, // 弦 leaves with 管
    },
    s && {
      cd: s.cd, icd: s.icd, cond: (b2) => echoesOf(b2, 'dark').length > 0,
      fire(b2, e2) { // 【裂管之奏】 three strikes on every dark echo
        const r = s.bb.range_radius ?? 0, ep = s.bb.ep_damage_ratio ?? 0;
        for (const echo of echoesOf(b2, 'dark')) for (let k = 0; k < 3; k++) b2.after(k * PIPE_STRIKE_GAP, () => {
          if (!e2.alive || !echo.alive) return;
          b2.fx('explode', { x: echo.x, y: echo.y, r, kind: 'pipeStrike' });
          for (const u of areaAllies(b2, e2, echo.x, echo.y, r)) { hurt(b2, e2, u, e2.s.atk, 'arts'); elem(b2, e2, u, 'apoptosis', e2.s.atk * ep); }
          echoHit(b2, echo);
        }, { owner: e2 });
      },
    },
  ];
}

function kitString(ab, e, b, tpl) {
  const s = ab.sk['1'];
  return [
    pipeCore(ab, e, b, tpl, { form: 'gold', prefix: 'acdumm' }),
    { spawn(b2, e2) { b2.addBuff(e2, { key: 'boss:eternal', persist: true, flags: { invulnerable: true, untargetable: true } }); } }, // 永久无敌
    s && {
      cd: s.cd, icd: s.icd, cond: (b2) => echoesOf(b2, 'gold').length > 0,
      fire(b2, e2) { // 【断弦之奏】 AoE on every gold echo, which then turns dark
        const r = s.bb.range_radius ?? 0, ep = s.bb.ep_damage_ratio ?? 0;
        for (const echo of echoesOf(b2, 'gold')) {
          b2.fx('explode', { x: echo.x, y: echo.y, r, kind: 'stringStrike' });
          for (const u of areaAllies(b2, e2, echo.x, echo.y, r)) { hurt(b2, e2, u, e2.s.atk, 'arts'); elem(b2, e2, u, 'apoptosis', e2.s.atk * ep); }
          setEchoForm(b2, echo, 'dark');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 盐风主教昆图斯 (boss_4)

function kitQuintus(ab, e, b, tpl) {
  const P = { stage: 0, t0: null, stageAt: null, tent: 0 };
  const stageSkills = [['Tidewater', 'Rockfall', 'SummonTentac'], ['TidewaterG1', 'RockfallG1', 'SummonTentacG1'], ['TidewaterG2', 'RockfallG2', 'SummonTentacG2', 'Doom']];
  const skills = [];
  const atkRatio = T(ab, 'epdamage.attack@ep_damage_ratio') ?? 0;
  const mk = (name, stage) => {
    const s = ab.sk[name];
    if (!s) return null;
    const kind = name.replace(/G\d$/, '');
    const a = { cd: s.cd, icd: s.icd, stage, cond: () => P.stage === stage, fire: (b2, e2) => QUINTUS[kind](b2, e2, s, P, tpl) };
    skills.push(a);
    return a;
  };
  const list = [{
    spawn(b2, e2) { P.t0 = b2.time; P.stageAt = b2.time; e2.profile.maxTargets = 2; },
    before(c, b2, e2) { // 同时攻击防御最高的两个单位
      const l = targetsNear(b2, e2, e2.base.rangeRadius || 99).sort((p, q) => q.s.def - p.s.def || aggroCmp(p, q));
      if (l.length) c.targets = l.slice(0, 2);
    },
    dealt(c, b2, e2) { elem(b2, e2, c.target, 'neural', e2.s.atk * atkRatio); },
    iv: 0.25,
    tick(b2, e2) {
      const lost = 1 - e2.hpRatio;
      if (P.stage === 0 && (lost >= (T(ab, 'growup1.hp_ratio') ?? 1) || b2.time - P.t0 >= (T(ab, 'growup1.interval') ?? Infinity))) grow(b2, e2, 1);
      else if (P.stage === 1 && (lost >= 2 * (T(ab, 'growup2.hp_ratio') ?? 1) || b2.time - P.stageAt >= (T(ab, 'growup2.interval') ?? Infinity))) grow(b2, e2, 2);
    },
  }];
  const grow = (b2, e2, n) => {
    P.stage = n; P.stageAt = b2.time;
    b2.addBuff(e2, { key: 'boss:grow', persist: true, visible: true, mods: { atkPct: T(ab, `atkup${n}.atk`) ?? 0 } });
    for (const a of skills) if (a.stage === n) a.left = a.icd;   // the new form's skills start from their initial cooldown
    b2.fx('grow', { x: e2.x, y: e2.y, id: e2.id, stage: n });
  };
  stageSkills.forEach((names, i) => names.forEach((n) => list.push(mk(n, i))));
  return list;
}

const QUINTUS = {
  Tidewater(b, e, s) { // 【大潮】 "对场上所有我方单位…": every operator it can select (fieldAllies): arts + neural
    b.fx('tide', { x: e.x, y: e.y, id: e.id });
    for (const u of fieldAllies(b, e)) { hurt(b, e, u, e.s.atk * (s.bb.atk_scale ?? 0), 'arts'); elem(b, e, u, 'neural', e.s.atk * (s.bb.ep_damage_ratio ?? 0)); }
  },
  Rockfall(b, e, s, P) { // 【崩坍】 delayed strikes on the N highest-DEF units
    const n = ROCKFALL_TARGETS[Math.min(P.stage, ROCKFALL_TARGETS.length - 1)];
    const ts = allTargets(b, e).sort((p, q) => q.s.def - p.s.def || aggroCmp(p, q)).slice(0, n);
    for (const t of ts) {
      b.fx('rockfall', { x: t.x, y: t.y, id: t.id, dur: ROCKFALL_DELAY });
      b.after(ROCKFALL_DELAY, () => { if (e.alive && t.alive) hurt(b, e, t, e.s.atk * (s.bb.atk_scale ?? 0), 'phys'); }, { owner: e });
    }
  },
  SummonTentac(b, e, s, P, tpl) { // 【断裂生殖】 tentacles at the template devices (phase i on the i-th cast)
    const br = tpl && tpl.branches && tpl.branches[s.bs.branch_id ?? 'dslily_dstnta'];
    let spots = [];
    if (Array.isArray(br) && br.length) {
      const phase = br[Math.min(P.tent, br.length - 1)] || [];
      const devs = (tpl.devices || []);
      for (const a of phase) { const d = devs.find((x) => x.alias === a.key); if (d && d.pos) spots.push(d.pos); }
    }
    if (!spots.length) { const t = b.rng.pick(allTargets(b, e)); if (t) spots = [[t.tileR, t.tileC]]; }
    P.tent++;
    for (const [r, c] of spots) {
      b.fx('tentacle', { x: c, y: r, r: TENTACLE_RADIUS, dur: TENTACLE_STUN });
      for (const u of areaAllies(b, e, c, r, TENTACLE_RADIUS)) b.applyStatus(u, 'stun', { duration: TENTACLE_STUN, source: e });
    }
  },
  Doom(b, e, s) { // 【物种爆发】
    b.fx('telegraph', { x: e.x, y: e.y, r: 99, dur: DOOM_DELAY, kind: 'speciesBurst', id: e.id });
    b.after(DOOM_DELAY, () => { if (e.alive) lpLoss(b, Math.abs(s.bb.value ?? 0), 'speciesBurst', e); }, { owner: e });
  },
};

// ---------------------------------------------------------------------------------------------------------------
// 卢西恩，“猩红血钻” (boss_5) + 不祥幻影

function lucienCore(ab, e) {
  const pen = T(ab, 'penetrate.def_penetrate') ?? 0, prob = T(ab, 'evade.prob') ?? 0, epr = T(ab, 'combat.attack@ep_damage_ratio') ?? 0;
  const s = ab.sk.aoe;
  return [
    {
      spawn(b, e2) { if (pen > 0) b.addBuff(e2, { key: 'boss:pierce', persist: true, mods: { defIgnorePct: pen } }); },
      tick(b, e2, a) { // 未被阻挡时有几率闪避物理与法术攻击
        const on = !e2.blockedBy && prob > 0;
        if (on === a.on) return;
        a.on = on;
        if (on) b.addBuff(e2, { key: 'boss:evade', persist: true, mods: { dodgePhys: prob, dodgeArts: prob } });
        else b.removeBuff(e2, 'boss:evade');
      },
      dealt(c, b, e2) { elem(b, e2, c.target, 'neural', e2.s.atk * epr); },
    },
    s && {
      // cast with a target in the radius (PRTS 技能 "需要目标"; 不祥幻影 "仅在半径2范围内存在我方单位时触发"): the trigger
      // selection (targetsNear — PRTS 选择器 "所有触发选择器通常不无视迷彩"): an airborne (起飞) operator evades a ground
      // leader (对地规避 — counting her spent the skill on nobody, §21.22), nor does an unblocking 隐匿 or 迷彩 one count
      cd: s.cd, icd: s.icd, cond: (b) => targetsNear(b, e, LUCIEN_AOE_RADIUS).length > 0,
      fire(b, e2) {
        // "该技能伤害无视迷彩": an area selection (areaAllies) — a 迷彩 operator is hit, an unblocking 隐匿 one not
        b.fx('explode', { x: e2.x, y: e2.y, r: LUCIEN_AOE_RADIUS, kind: 'crimsonAoe' });
        for (const u of areaAllies(b, e2, e2.x, e2.y, LUCIEN_AOE_RADIUS)) { hurt(b, e2, u, e2.s.atk * (s.bb.atk_scale ?? 0), 'phys'); elem(b, e2, u, 'neural', e2.s.atk * (s.bb.ep_damage_ratio ?? 0)); }
      },
    },
  ];
}

function kitLucien(ab, e) {
  const s = ab.sk.blink;
  return [...lucienCore(ab, e), s && {
    cd: s.cd, icd: s.icd, cond: () => !!e.blockedBy,
    fire(b, e2) { // blink past the blocker, leaving a 不祥幻影 on its path
      const route = remainingRoute(e2);
      const from = blinkForward(b, e2, s.bb.dist ?? 1.5);
      if (!from) return;
      const ph = b.spawnEnemy(PHANTOM_KEY, { pos: [from.y, from.x], route, ownerPlayerId: e2.ownerId, sourcePlayerId: e2.sourcePlayerId });
      if (ph) b.fx('summon', { x: from.x, y: from.y, id: e2.id, key: PHANTOM_KEY, n: 1 });
    },
  }];
}

// ---------------------------------------------------------------------------------------------------------------
// 阿利斯泰尔，帝国余晖 (boss_6)

function kitLion(ab, e, b) {
  const eq = ab.sk.equip, eqA = ab.sk.equipA, st = ab.sk.store, stA = ab.sk.storeA, su = ab.sk.Suicide;
  const P = { sp: 0, adv: false, nextAnim: null, wand: false };
  const wandDef = b.data.getEnemy('enemy_10030_vtwand');
  const disarm = wandDef && wandDef.talent ? wandDef.talent['1.disarmed_duration'] ?? 0 : 0;
  const range = () => e.base.rangeRadius || 3.4;
  const cost = eq ? (eq.sp > 0 ? eq.sp : 25) : Infinity;
  /** Equipment lying on this field, oldest first. */
  const equipment = (b2) => b2.enemies.filter((q) => q.alive && EQUIP_KEYS.includes(q.defId)).sort((p, q) => p.spawnSeq - q.spawnSeq);
  const decree = (b2, e2) => { // 【王权号令】 plus-shaped strike + random equipment
    const sk = P.adv && eqA ? eqA : eq;
    const t = b2.rng.pick(targetsNear(b2, e2, range()));
    if (!t) return false;
    const r0 = t.tileR, c0 = t.tileC;
    const tiles = [[r0, c0], [r0 + 1, c0], [r0 - 1, c0], [r0, c0 + 1], [r0, c0 - 1]];
    b2.fx('telegraph', { x: c0, y: r0, r: 1, kind: 'royalDecree', tiles: 'plus', id: e2.id });
    for (const u of areaAlliesInTiles(b2, e2, r0, c0, 'plus', 1)) hurt(b2, e2, u, e2.s.atk * ((sk && sk.bb.atk_scale) || 0), 'phys');
    const taken = equipment(b2);
    const free = tiles.filter(([r, c]) => b2.grid.inRect(r, c) && b2.grid.isLow(r, c) && b2.grid.groundPassable(r, c) && !b2.unitAt(r, c)
      && !taken.some((q) => Math.round(q.y) === r && Math.round(q.x) === c));
    const spot = b2.rng.pick(free);
    if (spot) {
      const key = b2.rng.pick(EQUIP_KEYS);
      const q = b2.spawnEnemy(key, { pos: spot, route: { motion: 'FLY', start: spot, end: spot, steps: [{ t: 'wait', s: 99999 }] }, tag: 'part', countInTotal: false, ownerPlayerId: e2.ownerId });
      if (q) b2.fx('equip', { x: spot[1], y: spot[0], id: q.id, key });
    }
    return true;
  };
  const animate = (b2, e2) => { // 【莫非王土】 the latest equipment (2 at ≤50 %)
    const n = P.adv && stA ? stA.bb.max_target ?? 2 : 1;
    const sk = P.adv && stA ? stA : st;
    for (const q of equipment(b2).slice(-n)) {
      if (q.defId === 'enemy_10028_vtswd') {
        const t = b2.rng.pick(targetsNear(b2, e2, range()));
        if (t) { b2.fx('sword', { x: q.x, y: q.y, from: q.id, to: t.id }); hurt(b2, e2, t, e2.s.atk * ((sk && sk.bb.atk_scale) || 0), 'phys'); }
      } else if (q.defId === 'enemy_10029_vtshld') {
        const side = Math.sign(q.x - e2.x) || -1;
        b2.addBuff(e2, { key: 'boss:vest', shield: (sk && sk.bb.dynamic) || 0, persist: true, visible: true, data: { side, cut: (sk && sk.bb.damage_resistance) || 0 } });
        b2.fx('vest', { x: e2.x, y: e2.y, id: e2.id, side });
      } else if (q.defId === 'enemy_10030_vtwand') {
        P.wand = true;   // [substitute for 黄金回响]: next attack becomes arts and disarms its target
        b2.fx('equip', { x: q.x, y: q.y, id: q.id, key: q.defId, kind: 'wand' });
      }
      b2.kill(q, null);
    }
  };
  return [
    {
      tick(b2, e2, a, dt) {
        if (!P.adv && e2.hpRatio <= (T(ab, 'advance.hp_ratio') ?? 0)) { // ≤50 %: DEF +100 %, RES +45, animate two
          P.adv = true;
          b2.addBuff(e2, { key: 'boss:advance', persist: true, visible: true, mods: { defPct: T(ab, 'advance.def') ?? 0, resFlat: T(ab, 'advance.magic_resistance') ?? 0 } });
          b2.fx('phase', { x: e2.x, y: e2.y, id: e2.id, kind: 'lionAdvance' });
        }
        if (!canCast(e2, false)) return;
        P.sp += dt * ENEMY_SP_PER_SEC;
        if (P.sp >= cost && decree(b2, e2)) P.sp = 0;
        // 【莫非王土】: ANIMATE_DELAY s after equipment first lies on the field, then once per 王权号令 cycle
        const has = equipment(b2).length > 0;
        if (!has) { P.nextAnim = null; return; }
        if (P.nextAnim == null) P.nextAnim = b2.time + ANIMATE_DELAY;
        if (b2.time >= P.nextAnim) { animate(b2, e2); P.nextAnim = b2.time + (Number.isFinite(cost) ? cost : ANIMATE_DELAY); }
      },
      hitIn(c, b2, e2) { // vest: damage from its side ×(1 − damage_resistance) while the barrier holds
        const v = e2.findBuff('boss:vest');
        if (v && v.shield > 0 && c.source && Math.sign(c.source.x - e2.x) === v.data.side) c.dmg.mul *= 1 - v.data.cut;
      },
      hitOut(c, b2, e2) { if (P.wand && c.dmg.isAttack) c.dmg.type = 'arts'; },
      dealt(c, b2, e2) { if (!P.wand) return; P.wand = false; if (disarm > 0) b2.applyStatus(c.target, 'disarm', { duration: disarm, source: e2 }); },
    },
    su && {
      cd: su.cd, icd: su.icd,
      fire(b2, e2) { // 【斥退】 "对场上所有我方单位…": every operator it can select (fieldAllies)
        b2.fx('telegraph', { x: e2.x, y: e2.y, r: 99, kind: 'repel', id: e2.id });
        for (const u of fieldAllies(b2, e2)) hurt(b2, e2, u, e2.s.atk * (su.bb.atk_scale ?? 0), 'arts');
        lpLoss(b2, Math.abs(su.bb.value ?? 0), 'repel', e2);
      },
    },
  ];
}

function kitEquip() {
  return [{ spawn(b, e) { b.addBuff(e, { key: 'boss:equip', persist: true, flags: { invulnerable: true, untargetable: true, noMove: true } }); } }];
}

// ---------------------------------------------------------------------------------------------------------------
// “萨米的意志” (boss_7)

function kitDeer(ab, e) {
  const dr = T(ab, 'Madness.damage_resistance') ?? 0;
  const atkN = T(ab, 'Madness.enemy_smdeer_mad[attack].max_cnt') ?? 1, skN = T(ab, 'Madness.enemy_smdeer_mad[skill].max_target') ?? 1;
  const lasso = ab.sk.Lasso, doom = ab.sk.Doom;
  const P = { low: false, acc: Infinity };   // like engine attacks, the first 冰凌 comes as soon as it has a target
  return [
    {
      spawn(b, e2) { e2.profile.noAttack = true; },
      tick(b, e2, a, dt) {
        if (!P.low && e2.hpRatio < 0.5) { // <50 %: damage taken reduced, extra targets
          P.low = true;
          b.addBuff(e2, { key: 'boss:madness', persist: true, visible: true, mods: { physTakenMul: 1 - dr, artsTakenMul: 1 - dr } }); // 物理和法术伤害降低
          b.fx('phase', { x: e2.x, y: e2.y, id: e2.id, kind: 'deerMadness' });
        }
        if (!canCast(e2, false)) return;
        P.acc += dt;
        if (P.acc < e2.s.interval) return;
        const cands = fairOrder(b, e2, allTargets(b, e2), P);
        if (!cands.length) return;
        P.acc = 0;
        const cols = [];
        for (const t of cands) { if (!cols.includes(t.tileC)) cols.push(t.tileC); if (cols.length >= (P.low ? atkN : 1)) break; }
        for (const c of cols) { // 【冰凌】 its normal attack: the whole column (an area selection: no unblocking 隐匿 operator)
          const hit = b.allies().filter((u) => u.tileC === c && areaSelectable(e2, u));
          b.fx('column', { x: c, y: e2.y, c, id: e2.id });
          for (const u of hit) b.dealDamage(e2, u, { amount: e2.s.atk, type: 'phys', isAttack: true });
        }
        e2.lastAttackAt = b.time;
        e2.stats.attacks++;
      },
    },
    lasso && {
      cd: lasso.cd, icd: lasso.icd, cond: (b) => allTargets(b, e).length > 0,
      fire(b, e2) { // 【自然涌动】 stun + arts per second
        const n = P.low ? skN : (lasso.bb.max_target ?? 1);
        const dur = lasso.bb.projectile_life_time ?? 0;
        for (const t of fairOrder(b, e2, allTargets(b, e2), P).slice(0, n)) {
          b.fx('beam', { x: e2.x, y: e2.y, from: e2.id, to: t.id, kind: 'naturalSurge', dur });
          b.applyStatus(t, 'stun', { duration: dur, source: e2 });
          b.addBuff(t, { key: 'boss:surge', duration: dur, interval: 1, visible: true,
            onTick: ({ battle, unit }) => battle.dealDamage(e2, unit, { amount: e2.s.atk * (lasso.bb.atk_scale ?? 0), type: 'arts', canDodge: false, ignoreSelect: true, tags: ['enemyAbility'] }) });
        }
      },
    },
    doom && {
      cd: doom.cd, icd: doom.icd,
      fire(b, e2) {
        b.fx('telegraph', { x: e2.x, y: e2.y, r: 99, kind: 'samiDoom', id: e2.id });
        for (const u of fieldAllies(b, e2)) hurt(b, e2, u, e2.s.atk * (doom.bb.atk_scale ?? 0), 'arts');
        lpLoss(b, Math.abs(doom.bb.value ?? 0), 'samiDoom', e2);
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 伊莎玛拉，腐化之心 (boss_11) + 伊莎玛拉之泪

/**
 * 伊莎玛拉，腐化之心 — the 4th 隐秘核心 leader (project-side, PRTS 敌人一览; the official act1autochess has no level
 * for it, tools/custom-content.mjs clones 假想敌：管's hidden level and swaps the leader + part).
 *  初始形态 (data enemy_2039_syskad): dmgType NONE — its "normal attack" is the PRTS 能力 "普通攻击能够同时治疗3名敌方
 *   单位", driven from tick() every `bat` s (the engine attack is disarmed: an enemy with data dmgType `none` spawns with
 *    profile.noAttack — Battle.spawnEnemy). It heals up to 3 allies in range, ATK each [ASSUMED: the ability names no ratio].
 *  【腐化】(skill `Corrupt`, CD 8 [本项目; 官方数据 CD 30] / ICD 8): summons 2 伊莎玛拉之泪 on random deployable tiles. A tear that finds no target
 *    charges the leader (+25 SP / 3 s). At SP 120 the skill `change` fires: 变身 — every tear vanishes ("变身时消失"),
 *    ATK ×0.625, DEF ×0.3, RES ×0.5, move ×0.8, attack interval ×0.5 (batPct −0.5) and the normal attack turns into
 *    3-target TRUE damage (profile.maxTargets 3, profile.dmgType 'true'; PRTS "同时攻击3个目标并造成真实伤害").
 *  <50 % HP (Berserk): ATK +50 % and two extra tears, once.
 *  首次被击倒 (Reborn, dur 5, hp_ratio 0.02): the leader's real HP is the shared pool, so the knock-out is caught in the
 *    `taken` hook — the pool is topped back to 2 % before damage.js' death check reads it (it runs right after the hook),
 *    the leader is 重生 (invulnerable / untargetable / unblockable / noMove / stun 5 s) and comes back in the form it
 *    died in. Only the first knock-out revives (PRTS 天赋 "首次被击倒后重生").
 */
const SYSKAD_KEY = 'enemy_2039_syskad', SYSKAD_TEAR = 'enemy_2040_syrott';
/** 初始形态 heals this many enemy units (PRTS "同时治疗3名敌方单位") in this radius around itself [ASSUMED radius]. */
const SYSKAD_HEAL_TARGETS = 3, SYSKAD_HEAL_RADIUS = 2.5;
/** 治疗量 = 自身攻击力 × 本系数（作者 2026-10-11：先降到 0.5，当场又改回 1 = 正常）。 */
const SYSKAD_HEAL_SCALE = 1;
/** 变身形态 attack reach (3-target TRUE damage): [ASSUMED] — the data carry no range for either form. */
const SYSKAD_FORM2_RADIUS = 2.5;
/** Tears summoned per 【腐化】 (本项目设定为 2；官方数据无计数) and by the <50 % talent (PRTS "额外召唤2个"). */
const SYSKAD_TEAR_PER_CAST = 1, SYSKAD_RAGE_TEARS = 2;   // 每次【腐化】只生成 1 个泪（作者 2026-10-11 改回 1；暴走天赋的 2 个不变）
/** 【腐化】 summons a 伊莎玛拉之泪 on this cooldown (s). 本项目设定为 8（官方数据为 CD 30 / ICD 8）。 */
const SYSKAD_CORRUPT_CD = 8;
/** A tear "attacks" the operators on / next to its tile (data rangeRadius 0) — the reach of its true damage. */
const SYSKAD_TEAR_RADIUS = 1;
/** 变身阶段血条 = 总血量 × 本系数（是**一段可直接打空的条**）：进二阶段锁定一阶段真血条、二阶段血条改写成 总血量×系数；
 *  二阶段被打空 → 回退一阶段，且**这一段（总血量×系数）永久扣血**（回退后血条 = 变身时真血条 − 该段），每循环一次往下扣
 *  一段 → 必定能打死（作者 2026-10-11：改 0.5→0.2、回退改为永久扣血，不再「回满血→锁血」）。 */
const SYSKAD_PHASE2_HP = 0.2;

/** Every living 伊莎玛拉 body (the charge target of a tear; ≥2 exist only with a mirrored multi-player leader). */
function syskadBosses(b) {
  const out = [];
  for (const o of b.enemies) if (o.alive && o.mem && o.mem.syskad) out.push(o);
  return out;
}

/**
 * Place `n` 伊莎玛拉之泪 on RANDOM deployable tiles of the field (PROJECT 2026-10-09: 原先只落在干员所在格，
 * 现改成随机落在「所有可部署格」——落在空格子上时它会为领袖充能）。同一波的泪不重复占同一格。
 */
function syskadSummonTears(b, e, n) {
  const R = b.grid.rect;
  const tiles = [];
  for (let r = R.r0; r <= R.r1; r++) for (let c = R.c0; c <= R.c1; c++) if (b.grid.canStand(r, c, { ranged: true })) tiles.push([r, c]);
  if (!tiles.length) return;
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const avail = tiles.filter(([r, c]) => !used.has(`${r},${c}`));
    const pool = avail.length ? avail : tiles;
    const [r, c] = b.rng.pick(pool);
    used.add(`${r},${c}`);
    const u = b.spawnEnemy(SYSKAD_TEAR, { pos: [r, c], tag: 'part', ownerPlayerId: e.ownerId, sourcePlayerId: e.sourcePlayerId });
    if (u) b.fx('summon', { x: c, y: r, id: e.id, key: SYSKAD_TEAR, n: 1 });
  }
}

/** 伊莎玛拉之泪: static; every 3 s it hurts the operators on it (TRUE damage) or charges the leader (+25 SP). */
function kitTear(ab, e) {
  const dmgIv = T(ab, 'Damage.interval') ?? 3, dmgScale = T(ab, 'Damage.atk_scale') ?? 1;
  const spIv = T(ab, 'RecoverSp.interval') ?? 3, spGain = T(ab, 'RecoverSp.sp') ?? 25;
  const P = { dmgAcc: 0, spAcc: 0 };
  return [
    {
      spawn(b, e2) { b.addBuff(e2, { key: 'boss:tearStill', persist: true, flags: { noMove: true } }); },
      tick(b, e2, a, dt) {
        P.dmgAcc += dt; P.spAcc += dt;
        // "每隔一段时间对目标造成真实伤害" — ONE target (PRTS 目标, singular): the operator standing on the tear (its
        // blocker), else the nearest one in reach. Hitting every operator in the radius multiplied the 500 by the
        // neighbourhood and melted the whole board within a couple of tears.
        const near = targetsNear(b, e2, SYSKAD_TEAR_RADIUS);
        const victim = e2.blockedBy && e2.blockedBy.alive && e2.blockedBy.deployed ? e2.blockedBy : (near[0] || null);
        if (victim) {
          if (P.dmgAcc < dmgIv) return;
          P.dmgAcc = 0;
          hurt(b, e2, victim, e2.s.atk * dmgScale, 'true', { tags: ['syskadTear'] });
        } else if (P.spAcc >= spIv) {   // "若攻击范围内无目标则为<伊莎玛拉，腐化之心>充能"
          P.spAcc = 0;
          // 阶段/技力态在所有本体之间共享（见 kitSyskad），所以只充能**一次**，别按本体数重复加
          const bosses = syskadBosses(b);
          const S = bosses.length ? bosses[0].mem.syskad : null;
          if (S && S.form === 'initial') { S.sp = Math.min(S.spMax, S.sp + spGain); b.fx('phase', { x: e2.x, y: e2.y, id: bosses[0].id, kind: 'syskadCharge' }); }
        }
      },
    },
  ];
}

function kitSyskad(ab, e) {
  const SP_MAX = (ab.sk.change && ab.sk.change.sp) || 120;
  const RAGE_HP = T(ab, 'Berserk.hp_ratio') ?? 0.5, RAGE_ATK = T(ab, 'Berserk.atk') ?? 0.5;
  const REBORN_DUR = T(ab, 'Reborn.duration') ?? 5, REBORN_HP = T(ab, 'Reborn.hp_ratio') ?? 0.02;
  const F = (k, d) => T(ab, `FetchAttributes.syskad_t[monster].${k}`) ?? d;
  const ATK_MUL = F('atk', 0.625), DEF_MUL = F('def', 0.3), RES_MUL = F('magic_resistance', 0.5);
  const MS_MUL = 1 + F('move_speed', -0.2), BAT_PCT = F('base_attack_time', 0.5) - 1;
  const corrupt = ab.sk.Corrupt;
  // **阶段/技力态在一个战场的所有本体之间共享**（双人首领场：伊莎镜像两份、共用同一条血池）。否则两份各按自己的技力
  // 变身/回退、各自把共享池改写成 20% / 真血条 → 血条在「满血 ↔ 20%」之间反复横跳；而且**后变身的那份会把已被改写成
  // 20% 的池当成「变身时的真血条」记下**（trueHp = 0.2×max）。共享载体挂在 pool 上——同一战场/隐藏核心的所有本体同池，
  // 因此天然同步（作者 2026-10-11 报的 bug：「回退后血条跟锁血一样、满血↔20% 反复横跳」）。
  const freshPhase = () => ({ sp: 0, spMax: SP_MAX, form: 'initial', raged: false, trueHp: null, phase2Bar: false });
  let P = freshPhase();
  e.mem.syskad = P;
  /** 每具本体的私有状态（重生只发生一次、治疗计时各自走）——不跨本体共享。 */
  const me = (e2) => e2.mem.syskadSelf || (e2.mem.syskadSelf = { reviving: false, revived: false, healAcc: 0 });
  /** 把闭包里的 P 指向本场的共享阶段态（首次访问时按 pool 建立）。所有本体同池 ⇒ 同一条 P。 */
  const bind = (e2) => {
    const p = e2.bossPool;
    if (p) { if (!p.syskadPhase) p.syskadPhase = freshPhase(); P = p.syskadPhase; }
    e2.mem.syskad = P;
    return P;
  };

  /** 二阶段形态（每具本体各自套用；共享阶段态由 change / tick 的 reconcile 保证一致）。 */
  const applyForm2 = (b, e2) => {
    if (!e2.findBuff('boss:syskadForm')) {
      b.addBuff(e2, { key: 'boss:syskadForm', persist: true, visible: true,
        mods: { atkMul: ATK_MUL, defMul: DEF_MUL, resMul: RES_MUL, moveMul: MS_MUL, batPct: BAT_PCT } });
    }
    // "同时攻击3个目标并造成真实伤害": arm the engine attack (the data's dmgType `none` disarmed it) and give the
    // transformed body the reach to hold three operators at once — the data carry rangeRadius 0 (melee) for both forms,
    // so the strike radius is [ASSUMED] (SYSKAD_FORM2_RADIUS), like 粉碎攻坚手 / 宿主士兵's 2.5 ability radius.
    e2.profile.noAttack = false;
    e2.profile.maxTargets = 3;      // "同时攻击3个目标"
    e2.profile.dmgType = 'true';    // "并造成真实伤害"
    e2.profile.melee = false;
    if (e2.base.rangeRadius < SYSKAD_FORM2_RADIUS) { e2.base.rangeRadius = SYSKAD_FORM2_RADIUS; e2.markDirty(); }
    setForm(b, e2, 'form2', 'phase');
  };
  /** 一阶段形态（回退 / 重生后）：撤掉二阶段加成，回到「攻击=治疗3名友军」。 */
  const applyForm1 = (b, e2, kind = 'revive') => {
    b.removeBuff(e2, 'boss:syskadForm');
    e2.profile.noAttack = true;
    e2.profile.maxTargets = 1;
    e2.profile.dmgType = 'none';
    e2.profile.melee = true;
    if (e2.base.rangeRadius > 0) { e2.base.rangeRadius = 0; e2.markDirty(); }
    setForm(b, e2, null, kind);
  };

  const change = (b, e2) => {   // 变身 (skill change, SP 120)
    bind(e2);
    if (P.form === 'form2') { applyForm2(b, e2); return; }   // 本场已变身：本份补齐二阶段形态
    P.form = 'form2';
    // 进二阶段：**锁定一阶段真血条**（记住变身时的血量），二阶段血条改为**总血量的 20%**（作者 2026-10-10/11）。
    // 血池跨战场共享 → 改的是同一条池对象；共享阶段态保证**只改写一次**（不会让第二具本体把 20% 再当成真血条）。
    const pool0 = e2.bossPool;
    if (pool0 && !P.phase2Bar) {
      P.trueHp = pool0.hp;
      P.phase2Bar = true;
      pool0.hp = Math.max(1, Math.round(pool0.maxHp * SYSKAD_PHASE2_HP));
      pool0.hold = true;   // 覆写期间挡住 4 Hz 的服务端血池同步，保住「20% 血条」的显示（否则会被冲回总血量）
      if (e2.s.maxHp) e2.hp = e2.s.maxHp * SYSKAD_PHASE2_HP;
    }
    for (const t of b.enemies.slice()) if (t.alive && t.defId === SYSKAD_TEAR) b.kill(t, null);   // "变身时消失"
    applyForm2(b, e2);
  };
  /** 二阶段被击倒 → 恢复一阶段真血条并**变回一阶段形态**，重新蓄力（之后还会再次变身，形成循环）。 */
  const revertToPhase1 = (b, e2, pool) => {
    bind(e2);
    P.phase2Bar = false;
    pool.hold = false;                               // 覆写结束：恢复服务端同步
    P.form = 'initial';
    P.sp = 0;                                        // 血条归零后重新蓄力，过一会儿再次变身
    // **二阶段被打掉的那段（总血量 ×0.2）永久扣血**（作者 2026-10-11）：回退一阶段的血条 = 变身时真血条 − 二阶段血条，
    // 而不是「回满」。这样每循环一次池就往下扣 20%、有净进度，最终一定打得死（否则变身常在满血触发 → 回退回满血 →
    // 无限循环，观感就是锁血）。血池降到 0 时 restore=0 ⇒ 保持 0 ⇒ 真死。
    const restore = Math.max(0, Math.round((P.trueHp ?? pool.maxHp) - pool.maxHp * SYSKAD_PHASE2_HP));
    // 回退只改**本地显示**、**不上报**回血（report:false）：二阶段那段伤害已如实上报、服务端池已随之扣掉「总血量×0.2」，
    // 回退后的真值 = 服务端池 = 真血条 − 那段 —— 如果再上报一次回血，服务端池会被**重复抬高**，随后 sync 又把显示冲回
    // 接近满血（作者 2026-10-11 报的「回退后血条又回满」）。裸池（无 refill 的情形）退回直接改 hp。
    if (typeof pool.refill === 'function') pool.refill(restore, { report: false });
    else pool.hp = Math.min(pool.maxHp, Math.max(0, restore));
    applyForm1(b, e2, 'revive');
    b.fx('phase', { x: e2.x, y: e2.y, id: e2.id, kind: 'syskadPhase1' });
  };
  const endRevive = (b, e2) => {
    const S = me(e2); S.reviving = false; S.revived = true;
    if (!e2.alive) return;
    if (P.form === 'form2') applyForm2(b, e2); else applyForm1(b, e2, 'revive');
  };
  const revive = (b, e2) => {   // 首次被击倒 → 重生 (the pool was just drained to 0; refill it before the death check)
    bind(e2);
    me(e2).reviving = true;
    const pool = e2.bossPool;
    pool.refill(pool.maxHp * REBORN_HP);
    e2.hp = e2.s.maxHp * Math.max(0, REBORN_HP);
    e2.profile.noAttack = true;
    b.addBuff(e2, {
      key: 'boss:syskadReborn', duration: REBORN_DUR, persist: true, visible: true,
      flags: { invulnerable: true, untargetable: true, unblockable: true, noMove: true, stun: true },
      onExpire: ({ battle }) => endRevive(battle, e2),
    });
    setForm(b, e2, 'reborn', 'telegraph', { r: 1, dur: REBORN_DUR, kind: 'reborn' });
  };

  return [
    {
      spawn(b, e2) {
        // 巡场（**可移动领袖模板**：镜像两份、各守半场，对齐官方 boss_battle_multi_player / 卢西恩）。2 人场由本体的
        // `movableLeader` 补一个镜像的另一半本体，两个各守半场；单人场只有本体、朝有人的（左）半场巡逻。原路返回、绕墙
        // 不穿墙；`patrolLoop` 无限循环（永不完成最后一腿 → 不会「走到终点脱逃」）。`mv.mirror` 供 kit 辨别镜像那份。
        bind(e2);
        e.mem.syskad = P;
        e2.mem.syskad = P;
        movableLeader(b, e2, halfWalk);
      },
      tick(b, e2, a, dt) {
        bind(e2);
        const S = me(e2);
        // 与共享阶段态对齐（双人场两份本体必须在同一形态）：先变身/先回退的那份负责改写共享态，另一份在这里补齐形态。
        if (P.form === 'form2') { if (!e2.findBuff('boss:syskadForm')) applyForm2(b, e2); }
        else if (e2.findBuff('boss:syskadForm')) applyForm1(b, e2, 'revive');
        if (P.form === 'initial') {   // the "normal attack": heal up to 3 allies
          S.healAcc += dt;
          if (S.healAcc >= e2.s.interval) {
            S.healAcc = 0;
            const hurtOnes = b.enemies.filter((o) => o.alive && o !== e2 && !o.bossPool && o.hpRatio < 1
              && Math.hypot(o.x - e2.x, o.y - e2.y) <= SYSKAD_HEAL_RADIUS)
              .sort((p, q) => p.hpRatio - q.hpRatio).slice(0, SYSKAD_HEAL_TARGETS);
            // the "attack" bookkeeping kitDeer's own attacks keep, so the HUD / attack clock read it as an attack
            if (hurtOnes.length) { for (const o of hurtOnes) b.heal(e2, o, e2.s.atk * SYSKAD_HEAL_SCALE); e2.lastAttackAt = b.time; e2.stats.attacks++; }
          }
        }
        // 暴走天赋只在**一阶段**触发（作者 2026-10-11）：二阶段血条被压到 20%，若也按 hpRatio<50% 判就会**每次变身**
        // 都误触发（召唤额外 2 个泪 + 攻速/攻击加成）。
        if (P.form === 'initial' && !P.raged && !S.reviving && e2.alive && e2.hpRatio < RAGE_HP) {
          P.raged = true;
          b.addBuff(e2, { key: 'boss:syskadRage', persist: true, visible: true, mods: { atkPct: RAGE_ATK } });
          b.fx('phase', { x: e2.x, y: e2.y, id: e2.id, kind: 'syskadRage' });
          syskadSummonTears(b, e2, SYSKAD_RAGE_TEARS);
        }
        if (P.form === 'initial' && P.sp >= P.spMax) change(b, e2);
      },
      // the leader's HP is the shared pool: catch the knock-out here, before damage.js reads `pool.hp` for the kill
      taken(c, b, e2) {
        bind(e2);
        const S = me(e2);
        const pool = e2.bossPool;
        if (!pool || pool.hp > 0) return;
        // 二阶段被击倒 → **恢复一阶段真血条、变回一阶段形态**，重新蓄力、之后再次变身（循环）——任何时候都生效、不触发重生。
        if (P.phase2Bar) { revertToPhase1(b, e2, pool); return; }
        // 一阶段被击倒 → 首次重生（回血池×2%、无敌），之后为真死。
        if (S.revived || S.reviving) return;
        revive(b, e2);
      },
    },
    corrupt && {
      cd: SYSKAD_CORRUPT_CD, icd: corrupt.icd,
      cond: (b) => { bind(e); return P.form === 'initial' && P.sp < P.spMax; },
      fire(b, e2) { syskadSummonTears(b, e2, SYSKAD_TEAR_PER_CAST); },
    },
  ];
}

/**
 * boss_12「爱国者」(enemy_1506_patrt, project-side; 官方 enemy_database)。tag sarkaz，行军姿态（初始，strength：ATK +20 % /
 * DEF +200）→ **血条清零、复活后**转「毁灭姿态」（shield：ATK +50 % / DEF ×2 / RES +100 %，免疫眩晕）并触发狂暴（immo_trigger[rage]：
 * 间隔 0.8 / 移速 +0.1 / 基攻 -0.4 / ATK +0.2 / DEF +200）；技能 throwspear[Rage]（cd20/icd15，atk_scale 1.35）；首次被击倒 → 重生。
 */
const PATRIOT_SHIELD = 'enemy_1081_sotisd_2'; // 游击队盾卫组长（爱国者生成时八格各一个）
const PATRIOT_SHIELD_HP = 0.30;                // 每名盾卫血量 = 领袖血池 × 0.30（作者 2026-10-11：由 0.15 上调）
const PATRIOT_SHIELD_DRAIN = 0.05;             // 一阶段每名盾卫倒下 → 爱国者流逝血池 × 0.05（作者 2026-10-10；2026-10-11 由 0.1 下调一半）
const PATRIOT_SHIELD_RES = 0.1;                // 一阶段每名盾卫倒下 → 全部抗性 −10%（累计，作者 2026-10-10）
// 二阶段（毁灭姿态）**免疫所有负面效果**——官方只写了免疫眩晕，作者要求扩成「所有负面状态」；本作状态目录
// （server/sim/buffs.js STATUS）里属于负面的键（控制 + 属性削减 + 脆弱）：
const PATRIOT_P2_IMMUNE = new Set([
  'stun', 'freeze', 'cold', 'sleep', 'levitate', 'groundbind', 'bind', 'attract',   // 控制
  'silence', 'disarm', 'fear', 'tremble', 'palsy', 'weaken',                          // 封锁/削弱
  'slow', 'sluggish', 'aspdDown', 'defDown', 'resDown',                               // 减速/属性削减
  'fragile', 'artsFragile', 'physFragile', 'elemFragile',                             // 脆弱
]);
function kitPatriot(ab, e) {
  const BB = (k, d) => { const v = T(ab, k); return v == null ? d : v; };
  // 行军姿态的增益（官方 blackboard `strength.atk` 0.2 / `strength.def` 200）——作者 2026-10-11：**降低一倍**（×0.5）。
  // 官方数据不动，只在 kit 里按比例缩放，注释可追溯。
  const PATRIOT_MARCH_SCALE = 0.5;
  const STR_ATK = BB('strength.atk', 0.2) * PATRIOT_MARCH_SCALE, STR_DEF = BB('strength.def', 200) * PATRIOT_MARCH_SCALE;
  const SH_ATK = BB('shield.atk', 0.5), SH_DEF = BB('shield.def', 2), SH_RES = BB('shield.magic_resistance', 1);
  const RG_MOVE = BB('immo_trigger[rage].move_speed', 0.1), RG_BAT = BB('immo_trigger[rage].base_attack_time', -0.4),
        RG_ATK = BB('immo_trigger[rage].atk', 0.2), RG_DEF = BB('immo_trigger[rage].def', 200);
  const REBORN_DUR = BB('reborn.duration', 60);
  const REBORN_INV = BB('reborn.patrt_t_state_2[reborn_invincible].duration', 15); // 重生无敌时长（官方 15s）
  const sk = (ab && ab.sk) || {};
  const THROW_SCALE = (sk['throwspear[Rage]'] && sk['throwspear[Rage]'].bb && sk['throwspear[Rage]'].bb.atk_scale) ?? 1.35;
  const THROW_CD = 20, THROW_ICD = 15; // 官方 cd20/icd15；build-data 的 skill 记录未带 cd → 这里固设
  const P = { raged: false, reviving: false, revived: false, boxed: false, unboxed: false, spawnR: null, spawnC: null, shieldsDown: 0, loopAttached: false };
  e.mem.patriot = P;
  /**
   * 解围后的走法：**在出生点衍生 3 格范围内随机挑一个可走格**，用流场求出真实可走路径走过去（绕墙、绝不穿墙）；
   * 走到后 tick 再掷下一个目标 —— 围着自己的出生点小范围游走（作者要求：不要转圈、不要全图）。
   */
  function wander(b, e2) {
    const g = b.grid, R2 = b.rect || {};
    const sr = P.spawnR ?? e2.tileR, sc = P.spawnC ?? e2.tileC;
    const cands = [];
    const hr = Math.round(e2.tileR), hc = Math.round(e2.tileC);
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
      if (!dr && !dc) continue;
      const tr = sr + dr, tc = sc + dc;
      if (tr < R2.r0 || tr > R2.r1 || tc < R2.c0 || tc > R2.c1) continue;
      // 目标必须离当前位置 **≥2 格**：太近的路线两腿会在一 tick 内走完（最后一腿 final → 漏怪），patrolLoop 来不及回卷
      if (Math.abs(tr - hr) + Math.abs(tc - hc) < 2) continue;
      if (!g.groundPassable(tr, tc)) continue;
      cands.push([tr, tc]);
    }
    for (let tries = 0; tries < 8 && cands.length; tries++) {
      const [tr, tc] = b.rng.pick(cands);
      let path = null;
      try { path = g.findPath(e2.tileR, e2.tileC, tr, tc, { ignoreObstacles: false }) || null; } catch { path = null; }
      if (!path || path.length < 2) continue;
      const pts = path.slice(1).map(([rr, cc]) => ({ type: 'MOVE', pos: [rr, cc] }));
      // 走 **loopRoute**（末腿 WAIT、永不脱逃、幂等挂回卷 tick）——旧的 `compileRoute({end})` 末腿是 `final`，靠
      // `patrolLoop` 回卷有同 tick 竞态（子节点注释：advanceRoute 可能在一个 tick 内跨进并走完末腿 → 领袖被判「走完
      // 终点」脱逃出场 = **模型消失、血池还有、战斗继续**；作者 2026-10-11 报告）。≤1 腿的候选丢弃再掷。
      if (!loopRoute(b, e2, pts)) continue;
      return;
    }
  }
  /** 一阶段每名盾卫倒下：爱国者**流逝血池 ×0.1**，并**全部抗性 −10%**（累计）。作者 2026-10-10。 */
  const onShieldDeath = (b, leader) => {
    P.shieldsDown = (P.shieldsDown ?? 0) + 1;
    const pool = leader.bossPool;
    if (pool && pool.hp > 0) {
      b.loseHp(leader, pool.maxHp * PATRIOT_SHIELD_DRAIN, { sourceless: true, noHitLimit: true, tags: ['patriotShield'] });
    }
    const keep = Math.pow(1 - PATRIOT_SHIELD_RES, P.shieldsDown);   // 0.9^n
    b.removeBuff(leader, 'boss:patriotResistBreak');
    b.addBuff(leader, { key: 'boss:patriotResistBreak', persist: true, visible: true, mods: { defMul: keep, resMul: keep } });
  };

  /**
   * 进入【毁灭姿态】（二阶段）。**总血量均分两段（作者 2026-10-11）：爱国者的血池降到 1/2** 就进二阶段（不再整池
   * 清零+回满）。挂上二阶段增益（shield / rage / 抗性归 0）、解除一阶段的围困 / 镜像 hold、改走半场巡逻、切 form2。
   * 按该单位自己的 `P.raged` 幂等；本体与镜像两份都要进入，所以对另一份也调用一次（见 `taken`）。
   */
  function enterDestroy(b, u) {
    const Pu = u.mem && u.mem.patriot;
    if (!Pu || Pu.raged) return;
    Pu.raged = true;
    b.removeBuff(u, 'boss:patriotBoxed');        // 一阶段被盾卫围住 → 解围
    b.removeBuff(u, 'boss:patriotMirrorHold');   // 镜像那份的 hold → 解除
    b.addBuff(u, { key: 'boss:patriotShield', persist: true, visible: true, mods: { atkPct: SH_ATK, defMul: SH_DEF, resMul: SH_RES } });
    b.addBuff(u, { key: 'boss:patriotRage', persist: true, visible: true, mods: { atkPct: RG_ATK, defFlat: RG_DEF, moveMul: 1 + RG_MOVE, batPct: RG_BAT } });
    // 【新·毁灭姿态】抗性**全部降低成 0**（作者 2026-10-10）
    b.addBuff(u, { key: 'boss:patriotNoResist', persist: true, visible: true, mods: { defMul: 0, resMul: 0 } });
    // 场上**存活的盾卫恢复全部血量**并**开始朝蓝门移动**（撤掉静止 + 给一条去终点的路线）——只有本体那一份持有盾卫
    for (const g of Pu.shields || []) {
      if (!g || !g.alive) continue;
      if (g.bossPool) g.bossPool.refill();   // 跨战场共享池一起回满
      g.hp = g.s.maxHp;
      b.removeBuff(g, 'boss:patriotShieldStill');
      const goal = toGoal(b, g.x, g.y);
      g.route = { legs: compileRoute(goal, b.rect), legIdx: 0, pts: null, ptIdx: 0, suffix: null, version: -1, waitLeft: null };
    }
    // 可移动领袖模板：**镜像两份、各守半场**（主本体守左半场，镜像守右半场；共享同一血池、随池空一起倒）。
    movableLeader(b, u, halfWalk);
    if (u.form !== 'form2') setForm(b, u, 'form2', 'phase');
  }

  return [
    {
      spawn(b, e2) {   // 行军姿态 + 周围八格各一个游击队盾卫组长（血量 = 爱国者的一半）；盾卫静止，爱国者被围住也静止
        b.addBuff(e2, { key: 'boss:patriotMarch', persist: true, visible: true, mods: { atkPct: STR_ATK, defFlat: STR_DEF } });
        // 二阶段免疫所有负面效果：进入毁灭姿态（P.raged）后，任何负面状态都被 beforeStatus 钩子取消（官方是免疫眩晕，
        // 作者要求扩成全部负面效果）。
        b.on('beforeStatus', (c) => { if (c.target === e2 && P.raged && PATRIOT_P2_IMMUNE.has(c.status)) c.cancel = true; }, { owner: e2 });
        P.shields = [];
        // 可移动领袖模板 (movableLeader)：**镜像的另一半本体**——只有行军姿态，不围困、不再生一套八盾卫（八盾卫是共享
        // 血池、只该有一组，围绕主本体）；毁灭姿态时随主本体各守半场巡逻。
        if (e2.mem.mirrorLeader) { b.addBuff(e2, { key: 'boss:patriotMirrorHold', persist: true, flags: { noMove: true } }); return; }
        // 主本体**保持在地图中间**（波次出生点；只按需整块平移到无干员的 3×3，不主动挪半场）；镜像本体由 movableLeader
        // 补在右半场镜像列，**出生时即补**（这样毁灭姿态时两份能一起播转阶段动作）。
        b.addBuff(e2, { key: 'boss:patriotBoxed', persist: true, flags: { noMove: true } });   // 被八格盾卫围住 → 不动
        P.boxed = true;   // 八名盾卫：**任意一名**倒下 → 出现缺口 → 爱国者开始移动
        const pool = e2.bossPool;
        const targetHp = Math.max(1, Math.round((pool && pool.maxHp ? pool.maxHp : e2.s.maxHp) * PATRIOT_SHIELD_HP));
        const baseHp = (b.data && typeof b.data.getEnemy === 'function' && b.data.getEnemy(PATRIOT_SHIELD)?.maxHp) || 25000;
        const hpMul = Math.max(1e-6, targetHp / baseHp);
        // 每条盾卫一条**跨战场共享血池**（b.sharedParts，爱国者：8 条；其他场地也削同一条）——没有共享池时退回独立血量
        const shared = Array.isArray(b.sharedParts) && b.sharedParts.length ? b.sharedParts : null;
        const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
        // 爱国者 + 8 盾卫 = 一个 3×3 整体九格：这 9 格都不能叠在干员身上。若爱国者原地这一块有干员，就把**整块**
        // 平移到最近的、9 格全程无干员占用的位置（爱国者跟着挪）。按出生点由近到远找，找不到就不挪（避免甩太远）。
        const R = b.rect || {};
        const isOp = (r, c) => b.allies().some((u) => u.alive && u.tileR === r && u.tileC === c);
        const passable = (r, c) => !b.grid || typeof b.grid.groundPassable !== 'function' || b.grid.groundPassable(r, c);
        const freeBlock = (r, c) => {
          // 中心必须可走（否则爱国者被挪到死角后 findPath 全失败，永远走不动——作者 2026-10-11）
          if (!passable(r, c)) return false;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const tr = r + dr, tc = c + dc;
            if (tr < R.r0 || tr > R.r1 || tc < R.c0 || tc > R.c1) return false;
            if (isOp(tr, tc)) return false;
          }
          return true;
        };
        let cr = e2.tileR, cc = e2.tileC;
        if (!freeBlock(cr, cc)) {
          const cand = [];
          for (let dr = -5; dr <= 5; dr++) for (let dc = -5; dc <= 5; dc++) cand.push([e2.tileR + dr, e2.tileC + dc]);
          cand.sort((a, x) => (Math.abs(a[0] - e2.tileR) + Math.abs(a[1] - e2.tileC)) - (Math.abs(x[0] - e2.tileR) + Math.abs(x[1] - e2.tileC)));
          const pick = cand.find(([r, c]) => freeBlock(r, c));
          if (pick) { cr = pick[0]; cc = pick[1]; }
        }
        if (cr !== e2.tileR || cc !== e2.tileC) { e2.tileR = cr; e2.tileC = cc; e2.x = cc; e2.y = cr; }  // 整块平移：爱国者随块挪
        P.spawnR = cr; P.spawnC = cc;   // 出生点（3×3 块中心）——解围后随机游走的基准
        DIRS.forEach(([dr, dc], i) => {
          const u = b.spawnEnemy(PATRIOT_SHIELD, {
            pos: [cr + dr, cc + dc], tag: 'escort', countInTotal: false,
            ownerPlayerId: e2.ownerId, sourcePlayerId: e2.sourcePlayerId,
            mods: shared ? null : { hpMul }, partPool: shared ? shared[i] : undefined,
          });
          if (u) {
            b.addBuff(u, { key: 'boss:patriotShieldStill', persist: true, flags: { noMove: true } });
            // 一阶段每名盾卫被消灭 → 爱国者流逝 10% 血池 + 全部抗性 −10%（作者 2026-10-10）
            attach(b, u, [{ death(c, b2) { if (c.reason === 'killed') onShieldDeath(b2, e2); } }]);
            P.shields.push(u);
          }
        });
        // 可移动领袖模板：**出生时即补上镜像的另一半本体**（毁灭姿态时两份一起播转阶段动作）。它只挂行军姿态 + hold，
        // 不围困、不再生一套八盾卫；毁灭姿态时 hold 解除、各守半场巡逻。路线此刻就挂好（未解围/未转阶段时被 noMove 挡住）。
        movableLeader(b, e2, halfWalk);
      },
      tick(b, e2, a, dt) {
        // 任意一名盾卫被消灭 → 出现缺口 → 爱国者解除围困、开始走动
        if (P.boxed && P.shields && P.shields.some((u) => !u.alive)) {
          P.boxed = false;
          P.unboxed = true;
          b.removeBuff(e2, 'boss:patriotBoxed');
          wander(b, e2);   // 解围即开走（不再原地 wait；也不跑全图/不转圈——出生点 3 格内随机走）
          P.nextWanderAt = b.time + 3.5;
          // 路线由 wander 里的 loopRoute 负责（末腿 WAIT、自带回卷 tick，永不脱逃）——不再另挂 patrolLoop（它的回卷
          // 有同 tick 竞态，正是「领袖被判走完终点而脱逃=模型消失」的根因）。
        }
        // 一阶段：每隔 ~3.5 s 掷下一个目标，在**出生点衍生 3 格范围内**随机游走（进入毁灭姿态后换成半场巡逻）
        if (P.unboxed && !P.raged && e2.alive && !P.reviving && b.time >= (P.nextWanderAt ?? 0)) {
          wander(b, e2);
          P.nextWanderAt = b.time + 3.5;
        }
        // 二阶段（毁灭姿态）**从「总血池降到 1/2」开始**（作者 2026-10-11：总血量均分两段），见 taken。
      },
      taken(c, b, e2) {   // 总血量均分两段：血池降到 1/2 → 进入【毁灭姿态】二阶段（无敌、本体与镜像一起转阶段；**不回满血**）
        if (P.revived || P.reviving) return;
        const pool = e2.bossPool;
        if (pool && pool.hp <= pool.maxHp / 2 + 1e-6) {   // 总血量分段（作者 2026-10-11）：1/2 处转阶段，不再整池清零+回满
          P.reviving = true;
          // 本体 + 镜像那份**一起**进入（各守半场巡逻）。
          enterDestroy(b, e2);
          for (const o of b.enemies) {
            if (o === e2 || !o.alive || !o.isBoss || o.defId !== e2.defId) continue;
            enterDestroy(b, o);                                   // 镜像那份也转阶段（转阶段动作同步）
            if (o.mem && o.mem.patriot) o.mem.patriot.reviving = true;   // 共享血池只复活一次：镜像那份不再触发复活
          }
          const inv = Math.min(REBORN_DUR, REBORN_INV);
          b.addBuff(e2, {
            key: 'boss:patriotReborn', duration: inv, persist: true, visible: true,
            flags: { invulnerable: true, untargetable: true, unblockable: true, noMove: true, stun: true },
            onExpire: ({ battle }) => { P.reviving = false; P.revived = true; if (e2.form !== 'form2') setForm(battle, e2, 'form2', 'phase'); },
          });
          setForm(b, e2, 'reborn', 'telegraph', { r: 1, dur: inv, kind: 'reborn' });
        }
      },
    },
    {
      cd: THROW_CD, icd: THROW_ICD,   // 投枪（官方 Patriot 全程投射；[毁灭姿态] 的 atk_scale 取 Rage 版 1.35）
      cond: (b) => e.alive && !P.reviving && !P.revived,
      fire(b, e2) {   // 目标不限 6 格内：取全图最近的可选干员（原 range 6 在演示里常无目标而沉默，改成必触发）
        const t = allTargets(b, e2).sort((a, x) => Math.hypot(a.x - e2.x, a.y - e2.y) - Math.hypot(x.x - e2.x, x.y - e2.y))[0];
        if (!t) return;
        // 看得见的投掷：① `atk` 事件让客户端把爱国者切到 Attack_1（投掷动作）；② 真实投射物（`spear`）飞向目标，
        // 命中时才结算伤害（照 暴鸰 droneBomb 的写法）——原来只发 `beam` fx，客户端 PROJ 表里没有对应 kind，什么都看不到。
        b._ev(['atk', e2.id, t.id, 'spear']);
        b.addProjectile({
          from: e2, target: t, speed: PROJECTILE_SPEEDS.spear, visual: 'spear', source: e2, hitDead: true,
          onHit: (c) => { const u = c.target || t; if (u && u.alive) hurt(b, e2, u, e2.s.atk * THROW_SCALE, 'phys'); },
        });
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// boss_13 “阿米娅” (project-side, PRTS BB 章): the puppeteer. 本体**永久无敌、不攻击、不可阻挡**；共享血池**只**由
// <幽影门扉> 被摧毁扣（每门 GATE_DRAIN=20 %）；门每秒沿朝向对友方法术 DPS + 治疗敌方；【幽影闪烁】把门顺转 90°；
// 【枯竭期许】8 向“微尘”给首个命中的干员挂强攻速减益；血池**首次归零 → 20 s 重生**（回满、无敌、强制刷无敌门+强制微尘）。
const AMIYA_GATE = 'enemy_148_amblls';
const AMIYA_GATES = 5;                 // 场上门的目标数量（作者 2026-10-10：一阶段 5 座、打死不再生成；二阶段每秒 1 座、满 5 座为止）
const AMIYA_GATE_HP = 0.2;             // 每门血量 = 血池 × 0.2（作者 2026-10-10：本体不可攻击，5 座门总血量 = 血池 100%）
const AMIYA_GATE_DRAIN = 0.1;          // 每门被摧毁扣血池 × 0.1（作者定；2026-10-11 由 0.2 下调一半）
const AMIYA_GATE_RANGE = 40;           // 门的射线沿朝向**打到整张图**（图宽/高 ≤ 21，40 足够穿到图边；作者：改成全图）
const AMIYA_GATE_ATK = 0.075;          // 每秒法伤 = 门 ATK × 0.075 ≈ 233/s（作者：0.05 还低，×1.5；官方 0.5 是配官方高血干员的）
const AMIYA_GATE_HEAL = 0.2;           // 每秒奶敌 = 门 ATK × 0.2（≈620/s；作者 2026-10-11：奶量翻倍、伤害不变）
const AMIYA_ROTATE_CD = 10, AMIYA_ROTATE_ICD = 8;   // 【幽影闪烁】（作者：改成 10 秒）
const AMIYA_DUST_CD = 20, AMIYA_DUST_ICD = 12;      // 【枯竭期许】
const AMIYA_DUST_ASPD = -80, AMIYA_DUST_DUR = 15;   // “微尘”：攻速 −80、15 s（官方 −90）
const AMIYA_REBORN_DUR = 20;
const AMIYA_DUST_VECS = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function kitAmiya(ab, e) {
  const P = { revived: false, reviving: false, gates: [], lastDeathTile: null, gateSeq: 0 };
  e.mem.amiya = P;
  /**
   * 门能落的格：以本体出生点为心、**周围不超过四格**（|dr|,|dc| ≤ 4，作者：原两格再放大两格），**排除干员所在格**（不能跟干员重叠）；
   * 离本体近的优先。跟出生点走 → 换地图也对，且不会甩到玩家打不到的后排。
   */
  const spots = (b) => {
    const taken = new Set();
    for (const u of b.allies()) if (u.alive) taken.add(u.tileR * 1000 + u.tileC);
    const R = b.rect || {};
    const g = b.grid;
    // 干员只能部署在场地**最后 4 行**（BOSS 场 rows 2–5）——门只落在这一带里，才保证够得到（作者 2026-10-11：有人
    // 反馈"有时打不到门"；此前 ±4 行会让门刷到部署带之外）。
    const rLo = Number.isFinite(R.r0) && Number.isFinite(R.r1) ? R.r1 - 3 : 2;
    const out = [];
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = e.tileR + dr, c = e.tileC + dc;
      if (r < R.r0 || r > R.r1 || c < R.c0 || c > R.c1) continue;        // 必须在场地范围内
      if (r < rLo) continue;                                              // 只能在干员能站/能打的部署带内
      if (taken.has(r * 1000 + c)) continue;                              // 不能叠干员
      if (!g.groundPassable(r, c)) continue;                              // **必须地块可通行**（作者：别生成在不可站立的格）
      out.push([r, c]);
    }
    out.sort((a, x) => (Math.abs(a[0] - e.tileR) + Math.abs(a[1] - e.tileC)) - (Math.abs(x[0] - e.tileR) + Math.abs(x[1] - e.tileC)));
    return out;
  };

  /** 门「中间那片」的列范围（场地中央 32%~68%，BOSS 场 6~14）——两队都够得到。 */
  const midCols = (R) => {
    const c0 = Number.isFinite(R.c0) ? R.c0 : 0, c1 = Number.isFinite(R.c1) ? R.c1 : 20;
    return [Math.round(c0 + (c1 - c0) * 0.32), Math.round(c0 + (c1 - c0) * 0.68)];
  };

  /**
   * 门的**中间带巡游**（作者 2026-10-11）：每座门在**自己那一行**、场地**中间那片列**里左右→原路往返，`patrolLoop`
   * 无限循环（永不走完最后一腿 → 不会脱逃）。找不到可走路径就退回原地不动。
   * @returns {boolean} 挂上巡游了吗
   */
  const gateRoam = (b, g) => {
    const R = b.rect || {};
    const [m0, m1] = midCols(R);
    const grid = b.grid;
    const startRow = Math.round(g.tileR), from = Math.round(g.tileC);
    const rLo = Number.isFinite(R.r0) && Number.isFinite(R.r1) ? R.r1 - 3 : (Number.isFinite(R.r0) ? R.r0 : 0);
    const rHi = Number.isFinite(R.r1) ? R.r1 : startRow;
    const path2 = (r0, c0, r1, c1) => { try { const p = grid.findPath(r0, c0, r1, c1); return p && p.length >= 2 ? p : null; } catch { return null; } };
    /** 在 `row` 的中间带左右往返的航点；这一行中间带被墙断开时返回 null。 */
    const backAndForth = (row) => {
      const pts = [];
      const add = (p) => { const last = pts[pts.length - 1]; if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p); };
      for (const tc of [m1, m0]) {
        const p = path2(row, from, row, tc);
        if (!p) continue;
        for (const q of p) add(q);
        for (const q of p.slice(0, -1).reverse()) add(q);
      }
      return pts.length >= 2 ? pts : null;
    };
    // 门所在行优先；它的中间带被墙断开（BOSS 场 rows 2–3 常这样）就换部署带里别的行——先走过去再巡游。
    const rows = [];
    for (let d = 0; d <= 3; d++) { rows.push(startRow + d); if (d) rows.push(startRow - d); }
    let pts = null;
    for (const row of rows) {
      if (row < rLo || row > rHi) continue;
      const seg = backAndForth(row);
      if (!seg) continue;
      if (row === startRow) { pts = seg; break; }
      const to = path2(startRow, from, row, from);
      if (!to) continue;
      pts = [...to, ...seg];
      break;
    }
    if (!pts) return false;
    return loopRoute(b, g, pts.map((p) => ({ type: 'MOVE', pos: [p[0], p[1]] })));
  };

  /** 刷一座 <幽影门扉>（挂在领袖血池上）；`invuln` = 重生期的无敌门。 */
  function spawnGate(b, tile, { invuln = false } = {}) {
    const pool = e.bossPool;
    const targetHp = Math.max(1, Math.round((pool && pool.maxHp ? pool.maxHp : e.s.maxHp) * AMIYA_GATE_HP));
    const baseHp = (b.data && typeof b.data.getEnemy === 'function' && b.data.getEnemy(AMIYA_GATE)?.maxHp) || 37000;
    const hpMul = Math.max(1e-6, targetHp / baseHp);
    // 每座门一条**跨战场共享血池**（作者 2026-10-10：跟爱国者的盾卫一样；maxHp = 领袖血池 × 0.15，见 config
    // boss_13.sharedShields/sharedShieldHp）。没有共享池时退回独立血量。
    const shared = Array.isArray(b.sharedParts) && b.sharedParts.length ? b.sharedParts : null;
    const partPool = shared ? shared[(P.gateSeq++) % shared.length] : undefined;
    const g = b.spawnEnemy(AMIYA_GATE, {
      pos: [tile[0], tile[1]], tag: 'escort', countInTotal: false,
      ownerPlayerId: e.ownerId, sourcePlayerId: e.sourcePlayerId,
      mods: shared ? null : { hpMul }, partPool,
    });
    if (!g) return null;
    // 门在**场地中间那片**巡游（作者 2026-10-11：有人反馈「有时打不到门」——原先钉死在本体出生点那一小片，本体靠
    // 一侧时另一队够不着）；找不到可走路径就退回原地不动。
    if (!gateRoam(b, g)) b.addBuff(g, { key: 'boss:gateStill', persist: true, flags: { noMove: true } });
    if (invuln) b.addBuff(g, { key: 'boss:gateInvuln', persist: true, visible: true, flags: { invulnerable: true, untargetable: true } });
    g.dir = 'LEFT';   // 初始朝左（干员所在半场）
    attach(b, g, [
      { iv: 1, tick(b3, g3) { gatePulse(b3, g3); } },
      { death(c, b3) { gateDeath(b3, c); } },
    ]);
    P.gates.push(g);
    return g;
  }

  /** 门每秒：沿朝向的**整条全图直线**打我方（法术）+ 奶附近的敌方。 */
  function gatePulse(b, g) {
    if (!g.alive) return;
    const dmg = g.s.atk * AMIYA_GATE_ATK, heal = g.s.atk * AMIYA_GATE_HEAL;
    const hits = [];
    for (let k = 1; k <= AMIYA_GATE_RANGE; k++) hits.push(frontOf(g.tileR, g.tileC, g.dir, k));
    for (const u of b.allies()) {
      if (!u.alive) continue;
      if (hits.some(([r, c]) => u.tileR === r && u.tileC === c)) hurt(b, g, u, dmg, 'arts');
    }
    b.fx('beam', { x: g.x, y: g.y, kind: 'gate', to: g.dir });
    let n = 0;
    for (const o of b.enemies) {
      if (!o.alive || o === g || o.bossPool || o.hp >= o.s.maxHp) continue;
      if (Math.abs(o.tileR - g.tileR) + Math.abs(o.tileC - g.tileC) > 3) continue;
      b.heal(g, o, heal);
      if (++n >= 3) break;
    }
  }

  /** 门被摧毁 → 领袖血池流失 20 %（无来源，过限伤）。记下被摧毁的格，好让补充生成避开它（不在原格“原地复活”）。 */
  function gateDeath(b, c) {
    if (c.reason !== 'killed') return;    // 漏过去不算击倒
    const g = c.unit;
    if (g) P.lastDeathTile = [g.tileR, g.tileC];
    const pool = e.bossPool;
    if (!pool || pool.hp <= 0) return;
    // 共享门池（`partPool`）在所有战场是**同一条池对象**：某座门一倒，各场地同一 tick 都会走这里 —— 用池上的
    // 标记只扣一次领袖血池（否则 N 个战场各扣 20 %）。二阶段重生时清掉标记（那时门池已回满，要能再扣一次）。
    const part = g && g.bossPool && g.bossPool !== pool ? g.bossPool : null;
    if (part) { if (part.gateDrained) return; part.gateDrained = true; }
    b.loseHp(e, pool.maxHp * AMIYA_GATE_DRAIN, { sourceless: true, noHitLimit: true, tags: ['amiyaGate'] });
  }

  /** 【枯竭期许】：以本体为心 8 向发射“微尘”，每条线上首个命中的干员攻速大减（不造成伤害）。 */
  function dust(b) {
    for (const [dr, dc] of AMIYA_DUST_VECS) {
      for (let k = 1; k <= 8; k++) {
        const r = e.tileR + dr * k, c = e.tileC + dc * k;
        const u = b.allies().find((x) => x.alive && x.tileR === r && x.tileC === c);
        if (u) { b.addBuff(u, { key: 'boss:amiyaDust', duration: AMIYA_DUST_DUR, refresh: 'replace', mods: { aspd: AMIYA_DUST_ASPD }, visible: true, status: 'aspdDown' }); break; }
      }
      b.fx('beam', { x: e.x, y: e.y, kind: 'dust', tx: e.tileC + dc * 8, ty: e.tileR + dr * 8 });
    }
  }

  /** 【幽影闪烁】：场上每座门顺时针转 90°，改变射向。 */
  function rotateGates(b) {
    for (const g of P.gates) {
      if (!g || !g.alive) continue;
      g.dir = DIRS[(DIRS.indexOf(g.dir) + 1) % 4];
      b.fx('phase', { x: g.x, y: g.y, id: g.id, form: 'gate' });
    }
  }

  /** 总血量均分两段：血池降到 1/2 → 20 s 重生（**不回满本体血池**、本体无敌），强制每秒刷无敌门 + 每 3 s 枯竭期许。 */
  function reborn(b) {
    P.reviving = true;
    b.addBuff(e, {
      key: 'boss:amiyaReborn', duration: AMIYA_REBORN_DUR, persist: true, visible: true,
      // 不加 `stun` —— 二阶段的门**由本体技能每秒刷一座**，眩晕会挡施法（作者 2026-10-10）。
      flags: { invulnerable: true, untargetable: true, unblockable: true, noMove: true },
      onExpire: ({ battle }) => {
        P.reviving = false; P.revived = true;
        for (const g of P.gates) if (g && g.alive) battle.removeBuff(g, 'boss:gateInvuln');   // 重生结束：门失去无敌
      },
    });
    setForm(b, e, 'reborn', 'telegraph', { r: 1, dur: AMIYA_REBORN_DUR, kind: 'reborn' });
    // 二阶段（作者 2026-10-10）：**由本体技能每秒生成一座门、满 5 座为止**（见下方 `cd:1` 的技能），门带共享血池、
    // 重生期间无敌。共享池用**同一批 5 条**、在此回满——二阶段再打空这 5 座 = 彻底击败。
    P.gateSeq = 0;
    P.p2spawned = 0;
    for (const p of b.sharedParts || []) { if (p) { p.refill(); p.gateDrained = false; } }   // 5 条门池回满、清“已扣”标记（跨战场共享，所有场地一起进二阶段）
    let m = 0;
    const t2 = b.every(3, () => { if (m < 3) { m++; dust(b); } });
    b.after(AMIYA_REBORN_DUR, () => { t2.cancel(); });
  }

  /** 二阶段技能：【幽影重重】每次在空缺格刷一座**无敌门**（每秒一座，最多 5 座）。 */
  function summonPhase2Gate(b) {
    if ((P.p2spawned ?? 0) >= AMIYA_GATES) return;
    const live = P.gates.filter((g) => g && g.alive);
    const free = spots(b).find((tile) => !live.some((g) => g.tileR === tile[0] && g.tileC === tile[1]));
    if (free) { spawnGate(b, free, { invuln: true }); P.p2spawned = (P.p2spawned ?? 0) + 1; }
  }

  return [
    {
      spawn(b, e2) {
        // 本体永久无敌、不可选中、**不被阻挡**（但没有 noMove —— 她要巡场移动）
        b.addBuff(e2, { key: 'boss:amiyaInvincible', persist: true, visible: true, flags: { invulnerable: true, untargetable: true, unblockable: true } });
        e2.profile.noAttack = true;
        // 巡场（作者：回来时要**按原路线返回**、不穿墙）：沿所在行用流场求出真实可走路径 —— 去一端、**原路返回**，再去
        // 另一端、原路返回，全程绕开墙体。范围是**门那片再缩一格**（见下），`loopRoute` 无限循环这条路。
        const r = e2.tileR, c = e2.tileC;
        const g = b.grid;
        const cps = [];
        const push = (p) => { const last = cps[cps.length - 1]; if (!last || last.pos[0] !== p[0] || last.pos[1] !== p[1]) cps.push({ type: 'MOVE', pos: [p[0], p[1]] }); };
        const goReturn = (tc) => {
          let p = null;
          try { p = g.findPath(r, c, r, tc) || null; } catch { p = null; }
          if (!p || p.length < 2) return;
          for (const q of p) push(q);                       // 去程（按流场路径）
          for (const q of p.slice(0, -1).reverse()) push(q); // 回程：**原路返回**
        };
        // 本体只在**门那片**里再**缩一格**的范围内巡逻（作者 2026-10-11：别跑太远）——门在中央 32%~68% 列（BOSS 场
        // 6~14），本体就走 7~13。原路返回、不穿墙；loopRoute 无限循环、永不脱逃。
        const [gMid0, gMid1] = midCols(b.rect || {});
        goReturn(gMid1 - 1);   // 右界内缩一格
        goReturn(gMid0 + 1);   // 左界内缩一格
        if (cps.length >= 2) loopRoute(b, e2, cps);   // 永不脱逃的循环巡逻（作者 2026-10-11：此前 t561 会脱逃）
        P.gates = [];
        P.gateSeq = 0;
        for (const tile of spots(b).slice(0, AMIYA_GATES)) spawnGate(b, tile);
      },
      tick(b) {
        // 一阶段**打死不再生成**（作者 2026-10-10）——只把阵亡的门从名单里剔除（供【幽影闪烁】等使用），不补刷。
        if (P.gates.some((g) => g && !g.alive)) P.gates = P.gates.filter((g) => g && g.alive);
      },
      taken(c, b, e2) {                       // 总血量均分两段：血池降到 1/2 → 重生（不整池清零+回满）
        if (P.revived || P.reviving) return;
        const pool = e2.bossPool;
        if (pool && pool.hp <= pool.maxHp / 2 + 1e-6) reborn(b);
      },
    },
    { cd: AMIYA_ROTATE_CD, icd: AMIYA_ROTATE_ICD, cond: (b) => e.alive && !P.reviving, fire: (b) => rotateGates(b) },
    { cd: AMIYA_DUST_CD, icd: AMIYA_DUST_ICD, cond: (b) => e.alive && !P.reviving, fire: (b) => dust(b) },
    // 【幽影重重】二阶段：本体技能**每秒刷一座门**（最多 5 座）——由技能触发（作者 2026-10-10）
    { cd: 1, icd: 1, cond: (b) => e.alive && P.reviving, fire: (b) => summonPhase2Gate(b) },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// boss_14「岁相」(enemy_1526_sfsui, project-side, 大炎·岁的映像)。**固定在场地中心、不移动**的大体系领袖（作者 2026-10-11），
// 朝向**朝下**；**无上下免伤**（作者取消官方天赋 Bristleback "受到来自上下两侧的伤害降低"）。三形态由**共享血池清零**推进：
//   一【远山惊雷】ThunderS  —— 对至多 3 个**远程**单位所在格小范围持续法术伤害（官方：3 个远程单位十字范围）；
//   二【天坠】PowerSlash    —— 对近战（阻挡 / 相邻）单位 2 段物理 + 持续**递增**法术（0.25 → +0.25 / 次 ×3）；
//   三【十方吐纳】DragonBreath —— 朝**下**的大范围持续法术伤害（本作不做"地面无法部署"，只做伤害）。
// 周期性召唤 <磷火>（enemy_1211_msfsui）——**不攻击、不可阻挡、需 10 次伤害击倒**；被岁相**吸收回技力**（+SP）。
// 血池清零：形态 1→2→3，**第三形态再清零才真死**（每次推进满血 + 短暂无敌"重现"）。
const SUI_WISP = 'enemy_1211_msfsui';
const SUI_FORMS = 3;
const SUI_WISP_CD = 12;
const SUI_MAX_WISPS = 3;
// 普通攻击距离：岁相数据 applyWay=RANGED 却 rangeRadius=0，又不可阻挡 ⇒ 拿不到目标、永不普攻（只有技能伤害）。
// 给一个攻击距离让它能普攻面前的干员（对齐 kitSyskad 的 profile.melee/rangeRadius 处理）。
const SUI_ATK_RANGE = 3.5;

/** <磷火>: 官方——不攻击、无法被阻挡、需 10 次伤害击倒；走到岁相处被吸收（岁相回技力）。 */
function kitSuiWisp(ab, e) {
  const P = { sp: T(ab, 'DevourMsfsui.sp') ?? 5 };
  e.mem.suiWisp = P;
  return [
    {
      spawn(b, e2) {
        e2.profile.noAttack = true;
        b.addBuff(e2, { key: 'boss:wispFree', persist: true, flags: { noBlock: true, unblockable: true } });
        setHits(e2, 10);         // 需 10 次伤害击倒
        hitCount(b, e2, true);   // 每次伤害只扣 1
      },
      tick(b, e2, a, dt) {
        if (!e2.alive) return;
        const boss = b.enemies.find((o) => o.alive && o.isBoss && o.mem && o.mem.sui);
        if (!boss) return;
        if (stepToward(e2, boss.x, boss.y, e2.s.moveSpeed * MOVE_SCALE * dt)) {
          boss.mem.sui.sp = Math.min(boss.mem.sui.spMax, (boss.mem.sui.sp || 0) + P.sp);   // 吸收 → 岁相回技力
          b.fx('devour', { x: boss.x, y: boss.y, id: boss.id });
          b.kill(e2, null);
        }
      },
    },
  ];
}

function kitSuiXiang(ab, e) {
  const BB = (k, d) => { const v = T(ab, k); return v == null ? d : v; };
  const REAPPEAR = BB('delay_to_appear', 2);
  const TH = (ab.sk && ab.sk.ThunderS1) || { bb: {} };
  const PS = (ab.sk && ab.sk.PowerSlashS2) || { bb: {} };
  const DRG = (ab.sk && ab.sk.DragonBreath) || { bb: {} };
  const TH_SCALE = (TH.bb && TH.bb.atk_scale) || 0.13;
  const PS_SCALE = (PS.bb && PS.bb.atk_scale) || 1.2;
  const PS_INIT = (PS.bb && PS.bb.atk_scale_init) || 0.25;
  const PS_ADD = (PS.bb && PS.bb.atk_scale_add) || 0.25;
  const DRG_SCALE = (DRG.bb && DRG.bb.atk_scale) || 0.5;
  const P = { form: 1, reviving: false, sp: 0, spMax: 100, nextWispAt: 0 };
  e.mem.sui = P;
  const passable = (b, r, c) => !b.grid || typeof b.grid.groundPassable !== 'function' || b.grid.groundPassable(r, c);
  // 左/右均衡取目标：首领场左右各半，技能不能只打一边。按「距中心列远近」把左右两队交替取出（最多 max 个）。
  const balanced = (list, center, max) => {
    const near = (a) => Math.abs(a.tileC - center);
    const L = list.filter((a) => a.tileC < center - 0.5).sort((x, y) => near(x) - near(y));
    const R = list.filter((a) => a.tileC > center + 0.5).sort((x, y) => near(x) - near(y));
    const M = list.filter((a) => Math.abs(a.tileC - center) <= 0.5);
    const out = [];
    const take = (u) => { if (u && out.length < max) out.push(u); };
    for (let i = 0; i < Math.max(L.length, R.length, M.length) && out.length < max; i++) {
      const l = L[i], r = R[i];
      if (l && r) { if (near(l) <= near(r)) { take(l); take(r); } else { take(r); take(l); } }
      else take(l || r);
      take(M[i]);
    }
    return out;
  };

  return [
    {
      spawn(b, e2) {
        // **固定在场地中心、不移动**（大体系；不套 movableLeader、无镜像）；朝向朝下；无上下免伤。
        const R = b.rect || { r0: 0, r1: 5, c0: 0, c1: 20 };
        const sc = Math.round((R.c0 + R.c1) / 2);
        let sr = R.r0;
        while (sr < R.r1 && !passable(b, sr, sc)) sr++;
        e2.tileR = sr; e2.tileC = sc; e2.x = sc; e2.y = sr;
        e2.dir = 'DOWN';
        b.addBuff(e2, { key: 'boss:suiStill', persist: true, visible: true, flags: { noMove: true, unblockable: true } });
        // 普通攻击：数据 applyWay=RANGED 却 rangeRadius=0，又不可阻挡 ⇒ 拿不到目标、永不普攻（只有技能伤害）。给个
        // 攻击距离，让它能普攻面前的干员（对称半径 ⇒ 左右公平）。对齐 kitSyskad 的 profile.melee / rangeRadius 处理。
        e2.profile.melee = false;
        if (!(e2.base.rangeRadius > 0)) { e2.base.rangeRadius = SUI_ATK_RANGE; e2.markDirty(); }
      },
      tick(b, e2, a, dt) {
        if (!e2.alive || P.reviving) return;
        if (b.time >= (P.nextWispAt ?? 0)) {
          const alive = b.enemies.filter((o) => o.alive && o.defId === SUI_WISP).length;
          const n = Math.max(0, SUI_MAX_WISPS - alive);
          const R = b.rect || { r0: 0, r1: 5, c0: 0, c1: 20 };
          const sc = Math.round(e2.tileC);
          for (let i = 0; i < Math.min(2, n); i++) {
            const dir = i % 2 === 0 ? -1 : 1;                       // 左 / 右交替出生（两边都要有磷火）
            const c = Math.min(R.c1, Math.max(R.c0, sc + dir * (4 + 3 * ((i / 2) | 0))));
            const u = b.spawnEnemy(SUI_WISP, { pos: [R.r1, c], tag: 'part', countInTotal: false, ownerPlayerId: e2.ownerId, sourcePlayerId: e2.sourcePlayerId });
            if (u) b.fx('summon', { x: u.x, y: u.y, id: e2.id, key: SUI_WISP, n: 1 });
          }
          P.nextWispAt = b.time + SUI_WISP_CD;
        }
      },
      taken(c, b, e2) {
        if (P.reviving) return;
        const pool = e2.bossPool;
        if (!pool || P.form >= SUI_FORMS) return;                 // 第三形态：血池清零 = 真死
        // 形态按血池「分段」推进（不是等整个血池清零再满血复活）：1→2 在血池降到 2/3、2→3 在 1/3，不死→归零才死。
        // 共享血池往往是 bloodPoint（几百万），等它整个清零要打很久，三形态根本看不到；分段推进让天坠/十方吐纳
        // 在正常对局里就能出现（参考 kitQuintus 的 hpRatio 分段）。不回满血、不上报回血。
        const bar = pool.maxHp / SUI_FORMS;
        if (pool.hp > pool.maxHp - bar * P.form + 1e-6) return;
        P.reviving = true;
        P.form += 1;
        setForm(b, e2, `form${P.form}`, 'phase');
        b.addBuff(e2, { key: 'boss:suiReappear', duration: REAPPEAR, persist: true, visible: true,
          flags: { invulnerable: true, untargetable: true, unblockable: true, noMove: true, stun: true },
          onExpire: ({ battle }) => { P.reviving = false; if (e2.form !== `form${P.form}`) setForm(battle, e2, `form${P.form}`, 'phase'); } });
      },
    },
    // 一【远山惊雷】：对至多 3 个远程单位所在格小范围持续法术
    {
      cd: 15, icd: 8, cond: () => e.alive && !P.reviving && P.form === 1,
      fire(b, e2) {
        const all = b.allies().filter((a) => a.alive && a.deployed);
        // 远程单位判定：干员的射程在 rangeGrid、不在 s.rangeRadius，所以优先看 profile.melee（和 ai.js 同一判据）
        const ranged = all.filter((a) => (a.profile && a.profile.melee === false) || (a.s && a.s.rangeRadius > 0.5));
        const picks = balanced(ranged.length ? ranged : all, e2.tileC, 3);   // 左右均衡
        // `atk` 事件 → 客户端播放岁相的【攻击】动作（否则技能只结算伤害、看不到抬手；对齐 kitPatriot 的投枪）
        if (picks[0]) b._ev(['atk', e2.id, picks[0].id, 'suiThunder']);
        const dmg = e2.s.atk * TH_SCALE;
        for (const u of picks) {
          b.fx('lightning', { from: e2.id, to: u.id, x: u.x, y: u.y });   // 岁相 → 各远程单位的惊雷（紫色闪电）
          zone(b, { x: u.x, y: u.y, r: 1.3, life: 3, iv: 0.5, kind: 'suiThunder', fxKind: 'suiThunder',
            tick: (us) => { for (const a of us) hurt(b, e2, a, dmg * 0.5, 'arts', { tags: ['suiThunder'] }); } });
        }
      },
    },
    // 二【天坠】：对近战（阻挡 / 相邻）单位 2 段物理 + 持续递增法术
    {
      cd: 18, icd: 8, cond: () => e.alive && !P.reviving && P.form === 2,
      fire(b, e2) {
        // 近战（阻挡/相邻）单位：岁相不可阻挡 ⇒ 常无阻挡者；改为对**左右两半各取最近一名**（两边都照顾）
        const all = b.allies().filter((a) => a.alive && a.deployed);
        const targets = e2.blockedBy && e2.blockedBy.alive ? [e2.blockedBy] : balanced(all, e2.tileC, 2);
        if (!targets.length) return;
        b._ev(['atk', e2.id, targets[0].id, 'suiSlash']);   // 播放【天坠】攻击动作
        for (const t of targets) {
          b.fx('suiSlash', { x: t.x, y: t.y, id: t.id });   // 目标格上的落体重击
          hurt(b, e2, t, e2.s.atk * PS_SCALE * 0.5, 'phys', { tags: ['suiSlash'] });
          hurt(b, e2, t, e2.s.atk * PS_SCALE * 0.5, 'phys', { tags: ['suiSlash'] });
          let k = 0;
          const h = b.every(1, () => {
            if (!t.alive) { h.cancel(); return; }
            hurt(b, e2, t, e2.s.atk * (PS_INIT + PS_ADD * k), 'arts', { tags: ['suiSlash'] });
            if (++k >= 3) h.cancel();
          });
        }
      },
    },
    // 三【十方吐纳】：朝下的大范围持续法术
    {
      cd: 30, icd: 12, cond: () => e.alive && !P.reviving && P.form === 3,
      fire(b, e2) {
        const R = b.rect || { r0: 0, r1: 5, c0: 0, c1: 20 };
        const rStart = Math.min(R.r1, Math.round(e2.tileR) + 1);
        // 朝下的大范围：覆盖**整个宽度**（左右两半都吃到），十方吐纳
        const cLo = R.c0, cHi = R.c1;
        // 左右各取最近一名作为吐息起点（两边都要看到火焰；攻击动作朝向左侧第一目标）
        const picks = balanced(b.allies().filter((a) => a.alive && a.deployed), e2.tileC, 2);
        b._ev(['atk', e2.id, picks[0] ? picks[0].id : null, 'suiBreath']);   // 播放【十方吐纳】攻击动作
        if (picks.length) for (const p of picks) b.fx('suiBreath', { id: e2.id, target: p.id, x: p.x, y: p.y, r: 1, dur: 1.4 });
        else b.fx('suiBreath', { id: e2.id, target: null, x: e2.x, y: e2.y, r: 1, dur: 1.4 });
        for (let c = cLo; c <= cHi; c += 2) b.fx('suiBreathColumn', { x: c, y: rStart });
        const dmg = e2.s.atk * DRG_SCALE;
        let left = 7;
        const h = b.every(0.5, () => {
          for (const a of b.allies()) {
            if (!a.alive || !a.deployed) continue;
            if (Math.round(a.tileR) >= rStart) hurt(b, e2, a, dmg * 0.5, 'arts', { tags: ['suiBreath'] });
          }
          left -= 0.5;
          if (left <= 0) h.cancel();
        });
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------

/** 把一只首领钉在自己那半场来回巡逻（永不脱逃；`halfWalk` 无可用路线时原地 wait，照 movableLeader）。 */
function pinHalf(b, e, half) {
  const walk = halfWalk(b, e, half);
  if (walk && Array.isArray(walk.checkpoints) && walk.checkpoints.length >= 2) { loopRoute(b, e, walk.checkpoints); return; }
  e.route = { legs: [{ t: 'wait', time: 1e9 }], legIdx: 0, pts: null, ptIdx: 0, suffix: null, version: -1, waitLeft: null };
}

// boss_15「梅菲斯特」(enemy_1507_mephi，作者 2026-10-12；**常规 R14** 首领，与浮士德同场共用一条血池)。
// 奶妈：**全场敌方自然回血速度加倍**（本作用「每秒给存活友军补一条短暂回血 buff」近似，[ASSUMED]）+ **普攻同时治疗至多 3 名
// 友军**（官方能力）；高法抗。守**左半场**巡逻（loopRoute + halfWalk('L')）。tag 'boss' → 与浮士德共用同一 sharedBoss 池。
const MEPHI_KEY = 'enemy_1507_mephi';   // 梅菲斯特（本体）
const FAUST_KEY = 'enemy_1508_faust';   // 浮士德（梅菲斯特的 kit 开场补刷，与本体算同一个 boss）
const MEPHI_HALF = 'L';
const MEPHI_RES_MUL = 2;          // 高法抗（官方「拥有很高的法术抵抗力」[ASSUMED 倍率]）
const MEPHI_HEAL_R = 6, MEPHI_HEAL_TARGETS = 3, MEPHI_HEAL_SCALE = 1.2;
const MEPHI_REGEN_RATIO = 0.01;   // 回血光环：每秒 maxHp 的 1%（近似「自然回血翻倍」）
function kitMephisto(ab, e) {
  const P = { healAcc: 0, regenAcc: 0 };
  e.mem.mephisto = P;
  return [
    {
      spawn(b, e2) {
        pinHalf(b, e2, MEPHI_HALF);
        b.addBuff(e2, { key: 'boss:mephistoRes', persist: true, visible: true, mods: { resMul: MEPHI_RES_MUL } });
        // 梅菲斯特 × 浮士德算**同一个 boss**（作者 2026-10-12）：本项目里波次只刷梅菲斯特，浮士德由这里开场补刷到右半场
        // （tag 'boss' → 与梅菲斯特共用同一条 sharedBoss 池；其 kitFaust 会被 onSpawn 自动挂上）。
        const R = b.rect || {}; const [c0, c1] = BOSS_HALF_COLS.R;
        const col = Math.round((c0 + c1) / 2);
        const row = Math.round(((R.r0 ?? 0) + (R.r1 ?? 5)) / 2);
        b.after(0.05, () => {
          if (b.enemies.some((o) => o.alive && o.defId === FAUST_KEY)) return;
          const u = b.spawnEnemy(FAUST_KEY, { pos: [row, col], tag: 'boss', mods: e2.mods, ownerPlayerId: e2.ownerId, sourcePlayerId: e2.sourcePlayerId });
          if (u) b.fx('summon', { x: u.x, y: u.y, id: e2.id, key: FAUST_KEY, n: 1 });
        });
      },
      tick(b, e2, a, dt) {
        if (!e2.alive) return;
        // 全场敌方自然回血翻倍（近似：每秒补一条 duration 2s 的回血 buff，暂停施法则自然失效）
        P.regenAcc += dt;
        if (P.regenAcc >= 1) {
          P.regenAcc = 0;
          for (const o of b.enemies) if (o.alive && o !== e2) {
            b.addBuff(o, { key: 'boss:mephistoRegen', duration: 2, source: e2, visible: false, mods: { hpRegenRatio: MEPHI_REGEN_RATIO } });
          }
        }
        // 「普攻同时治疗 3 名友军」：每 interval 治疗至多 3 名血量最低的受伤友军（发 atk 事件播抬手）
        P.healAcc += dt;
        if (P.healAcc >= (e2.s.interval || 2)) {
          P.healAcc = 0;
          const hurtOnes = b.enemies
            .filter((o) => o.alive && o !== e2 && !o.bossPool && o.hpRatio < 1 && Math.hypot(o.x - e2.x, o.y - e2.y) <= MEPHI_HEAL_R)
            .sort((x, y) => x.hpRatio - y.hpRatio).slice(0, MEPHI_HEAL_TARGETS);
          if (hurtOnes.length) {
            b._ev(['atk', e2.id, hurtOnes[0].id, 'none']);
            for (const o of hurtOnes) b.heal(e2, o, e2.s.atk * MEPHI_HEAL_SCALE);
            e2.lastAttackAt = b.time; e2.stats.attacks++;
          }
        }
      },
    },
  ];
}

// boss_16「浮士德」(enemy_1508_faust，作者 2026-10-12；**常规 R14** 首领，与梅菲斯特同场共用一条血池)。
// 狙击手：**无法被阻挡** + **登场短暂无敌**（官方）；**超远距物理狙击** + **能使攻击力加倍的特殊弩箭**（两条主动技能）。
// 守**右半场**巡逻（loopRoute + halfWalk('R')）。（官方第 3 招「周期性召唤弩炮台」暂未做——依赖装置素材，留 TODO。）
const FAUST_HALF = 'R';
const FAUST_SPAWN_INV = 6;        // 登场无敌秒数 [ASSUMED]
const FAUST_SNIPE_CD = 8, FAUST_SNIPE_ICD = 4, FAUST_SNIPE_SCALE = 1.2;
const FAUST_BOLT_CD = 22, FAUST_BOLT_ICD = 12, FAUST_BOLT_SCALE = 2.4;  // 「攻击力加倍」的特殊弩箭 [ASSUMED 2.4×]
// （官方第 3 招「召唤弩炮台」**不做**——作者 2026-10-12：算了，不要这弩炮了。）
function kitFaust(ab, e) {
  const speed = (PROJECTILE_SPEEDS && (PROJECTILE_SPEEDS.bolt || PROJECTILE_SPEEDS.arrow)) || 14;
  /** 最远（超远距狙击）的可选中我方干员。 */
  const farthest = (b, e2) => {
    const list = allTargets(b, e2);
    if (!list.length) return null;
    return list.reduce((best, u) => (Math.hypot(u.x - e2.x, u.y - e2.y) > Math.hypot(best.x - e2.x, best.y - e2.y) ? u : best), list[0]);
  };
  const shoot = (b, e2, t, scale) => {
    if (!t) return;
    b._ev(['atk', e2.id, t.id, 'bolt']);
    b.addProjectile({
      from: e2, target: t, speed, visual: 'bolt', source: e2, hitDead: true,
      onHit: (c) => { const u = c.target || t; if (u && u.alive) hurt(b, e2, u, e2.s.atk * scale, 'phys'); },
    });
  };
  return [
    {
      spawn(b, e2) {
        pinHalf(b, e2, FAUST_HALF);
        b.addBuff(e2, { key: 'boss:faustUnblockable', persist: true, visible: true, flags: { unblockable: true } });
        b.addBuff(e2, { key: 'boss:faustSpawnInv', duration: FAUST_SPAWN_INV, visible: true, flags: { invulnerable: true } });
      },
    },
    { cd: FAUST_SNIPE_CD, icd: FAUST_SNIPE_ICD, cond: () => e.alive, fire(b, e2) { shoot(b, e2, farthest(b, e2), FAUST_SNIPE_SCALE); } },
    { cd: FAUST_BOLT_CD, icd: FAUST_BOLT_ICD, cond: () => e.alive, fire(b, e2) { shoot(b, e2, farthest(b, e2), FAUST_BOLT_SCALE); } },
  ];
}

export const BOSS_KITS = Object.freeze({
  enemy_9013_acstmk: kitHelm,          // boss_1 假想敌：胄
  enemy_9013_acstmk_2: kitHelm,        // boss_8 假想敌：胄 (隐秘核心)
  enemy_9014_acstma: kitBlade,         // “斩胄之剑”
  enemy_9015_acstmb: kitBlade,         // “破胄之锤”
  enemy_9016_acstmr: kitShell,         // 刺胄之弹
  enemy_9017_achunt: kitGun,           // boss_2 假想敌：铳
  enemy_9017_achunt_2: kitGun,         // boss_9 假想敌：铳 (隐秘核心)
  enemy_9018_actrpa: kitSpring,        // “碎铳之簧” 法术护盾
  enemy_9019_actrpb: kitSpring,        // “碎铳之簧” 元素护盾
  enemy_9020_actrpc: kitSpring,        // “碎铳之簧” 频次护盾
  enemy_9021_acduml: kitPipe,          // boss_3 假想敌：管
  enemy_9021_acduml_2: kitPipe,        // boss_10 假想敌：管 (隐秘核心)
  enemy_9022_acdumm: kitString,        // 假想敌：弦
  enemy_9023_acdums: kitEcho,          // “余音”
  enemy_1521_dslily: kitQuintus,       // boss_4 盐风主教昆图斯
  enemy_2016_csphtm: kitLucien,        // boss_5 卢西恩，“猩红血钻”
  enemy_2017_csphts: lucienCore,       // 不祥幻影
  enemy_9032_aclionk: kitLion,         // boss_6 阿利斯泰尔，帝国余晖
  enemy_10028_vtswd: kitEquip,         // 未装配刀片 (inert until animated)
  enemy_10029_vtshld: kitEquip,        // 防护背心
  enemy_10030_vtwand: kitEquip,        // 冲击式施术单元
  enemy_9033_acdeer: kitDeer,          // boss_7 “萨米的意志”
  enemy_2039_syskad: kitSyskad,        // boss_11 伊莎玛拉，腐化之心 (隐秘核心)
  enemy_2040_syrott: kitTear,          // 伊莎玛拉之泪
  enemy_1506_patrt: kitPatriot,        // boss_12 爱国者 (隐秘核心)
  enemy_1552_mmamiy: kitAmiya,         // boss_13 “阿米娅” (隐秘核心；傀儡师：打门扣血)
  enemy_1526_sfsui: kitSuiXiang,       // boss_14 岁相 (隐秘核心；大体系：固定中心、三形态、磷火)
  enemy_1211_msfsui: kitSuiWisp,       // <磷火>（岁相召唤：不攻击/不可阻挡/10 次伤害击倒）
  enemy_1507_mephi: kitMephisto,       // boss_15 梅菲斯特 (常规 R14；奶妈，左半场巡逻，与浮士德共用血池)
  enemy_1508_faust: kitFaust,          // boss_16 浮士德 (常规 R14；狙击，右半场巡逻，与梅菲斯特共用血池)
});
export const BOSS_KEYS = Object.freeze(Object.keys(BOSS_KITS));
