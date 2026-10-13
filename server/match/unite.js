// server/match/unite.js — 联防 (Unite) planning and LP attribution (DESIGN §6.1, research 06 §5, research 08 §5).
//
// Trigger (co-op only): after the normal combats, ≥ 1 alive player leaked (a counted leak ⇒ not perfect) and
// ≥ 1 alive player was perfect. Helpers (PRTS 卫戍协议/帮助 §联防阶段): up to config.unite.maxHelpers (4) perfect
// players chosen by most units on the field (downed included) > has an active bond (存疑) > most undowned units, then
// seat. 4 人同图 (this build): every helper stands on its own lane of the linear map (uniteBattleOpts colOffset
// 8 × (helpers.length − 1 − its rank)); helper 0 (the highest 接怪 rank) is on the field's RIGHT lane, where the routes
// enter, and the enemies walk left through every lane to the blue door. 1 / 2 helpers keep the official two-half field.
// The field is the ROUND's own battlefield — its terrain, crates, water, devices and runes included (upstream 0.2.1,
// the owner's decision of 2026-10-07 「官服保留地形」; GitHub #41: 0.2.0 fielded it on the escaped levels' empty road,
// withdrawn). 3 / 4 helpers widen that round map to one lane per helper (uniteStageId → <stage>_u3 / _u4,
// tools/build-data.mjs addUniteRoundMaps), 1 / 2 keep it at cols 0–20 (GEO.UNITE_RECT). Every helper's pieces stand on
// their prep tiles ("按休整期位置部署在场"), the right-hand one shifted 8 columns (the official maps' halves, = the stage
// config's player_map_lr_offset 8). Their operators keep the HP ratio and
// the SP (技力, stored charges included) from the end of their own combat, nothing else — a skill still running then
// enters switched off (BattleResult.unitsEnd → PlayerBattleInput.units[].carryState `{ hpPct, sp }`, "阵地以其当前状态";
// community report #34 / GitHub #82: it used to restart for free). An operator knocked out at the end of its own combat (alive false) is fielded with
// `carryState: { down: true }`: PRTS "部署完成后，将对应单位的生命比例、技力修改至与上一阶段结束时相同（召唤物仅修改技力，
// 上一阶段为退场状态的干员强制退场）" — the sim deploys it with everyone and forces it out at once (constants.js
// FORCED_EXIT), so it lies on its own tile with the redeploy ring and comes back like after any knock-out (user
// playtest #5 item 2: it used to be left out and vanished). Its timer is its full redeploy time (the official 联防
// setup carries only hp / tech per operator, research 09 §3 HelpBattleInfo; the user confirmed it restarts). The board's summon
// pieces are fielded as the board has them and keep only their SP ("召唤物仅修改技力": carryState `{ sp }`, unitsEnd lists
// them beside the operators; one off the field at the end enters fresh [ASSUMED]). Enemies = the union of every leaker's
// counted leaks (same stats: the SpawnSpec mods travel with the leak), routed on the escaped template (`escaped_single`
// for 1 helper, `escaped_multi` for 2): walkers on its `lrsldr` action, flyers on `yokai`, tokens on `gopro_2` /
// `lazerd` (waves.js buildUniteWave); kill bounties keep paying the killer (a helper) — a death no operator caused pays
// the helper whose half it fell on (Battle._bountyPayee). No IN_BATTLE layer gains ("该阶段不能叠加层数"); the helpers'
// bonds carry the layers their own combat reached (PlayerState.battleInput `reached`: the round's pending gains, capped
// like settle() — the strip's count; "以其阵地当前的状态" [ASSUMED] includes them; until 0.1.3 the round-start layers),
// and settle() still adds those gains once. Time limit = the round's combat limit.
// LP: an enemy still alive at the end (leaked in the unite battle, or never spawned before the limit) costs its
// SOURCE player 1 LP; each player's round loss = min(lpCap, survivors attributed to them + leaks that could not
// re-enter) — the same 10 cap as a normal round.

import { buildUniteWave } from './waves.js';
import { layerGainRoom } from '../../shared/constants.js';

/**
 * @param {import('./Match.js').Match} m
 * @param {Map<string, object>} results playerId → BattleResult.perPlayer entry of the player's own combat
 * @returns {null | { helpers: any[], leakers: any[], leaked: object[], notReentered: Map<string, number> }}
 */
export function planUnite(m, results) {
  if (m.isSolo) return null;
  const alive = m.alivePlayers();
  const leakers = [];
  const perfects = [];
  for (const ps of alive) {
    const r = results.get(ps.playerId);
    if (!r) continue;
    const counted = (r.leaked || []).filter((l) => l && l.counted !== false);
    if (counted.length > 0) leakers.push(ps);
    else if (r.perfect !== false) perfects.push(ps);
  }
  if (!leakers.length || !perfects.length) return null;
  const helpers = helperOrder(m, perfects, results);
  const leaked = [];
  const notReentered = new Map();
  for (const ps of leakers) {
    const r = results.get(ps.playerId);
    for (const l of r.leaked || []) {
      if (!l || l.counted === false) continue;
      if (!m.gd.enemy(l.enemyKey)) { notReentered.set(ps.playerId, (notReentered.get(ps.playerId) || 0) + 1); continue; }
      // kill bounties keep paying in 联防, and only on the card's own enemy. A split or summoned child
      // never carries bountyId / bountyCoins (spawnChildren). A leak that still has the card's id but is
      // some other enemy — a copy that did not go through spawnChildren — does not collect the card either
      // (GitHub #67, #89-2; owner 2026-10-04: the main body only). A bounty set on the SpawnSpec by content
      // is copied into mods.bountyCoins by the match and has no card to match.
      const bountyId = l.mods && l.mods.bountyId;
      const b = bountyId ? ps.bounties.find((x) => x.id === bountyId) : null;
      const card = b && b.card;
      let bounty = card && card.payout !== 'perfect' && Number(card.coin) > 0 && l.enemyKey === card.enemyKey
        ? { coins: Math.trunc(card.coin), ownerPlayerId: ps.playerId } : null;
      const extra = !bountyId && l.mods ? Math.trunc(Number(l.mods.bountyCoins) || 0) : 0;
      if (!bounty && extra > 0) bounty = { coins: extra, ownerPlayerId: ps.playerId };
      leaked.push({ enemyKey: l.enemyKey, mods: l.mods ? { ...l.mods } : null, lpr: l.lpr ?? 1, sourcePlayerId: ps.playerId, tag: l.tag ?? null, bounty });
    }
  }
  return { helpers, leakers, leaked, notReentered };
}

/**
 * Helper metrics of a perfect player: units on the field (board operators, downed included), whether a bond is
 * active, Σ layers of the active bonds as the 联防 battle will fight them (the persistent layers plus this round's
 * pending gains, capped like bondsView / settle — PRTS 以其阵地当前的状态; the official "层数最高" tie-break is marked 存疑),
 * operators still standing at the end of the player's own combat.
 */
export function helperStats(m, ps, results) {
  const units = ps.deployCount;
  let active = false;
  let layers = 0;
  const pending = ps.pendingLayerGains;
  for (const [id, b] of Object.entries(ps.bonds || {})) {
    if (!b || !b.active) continue;
    active = true;
    const stored = Number(ps.layers && ps.layers[id]) || Number(b.layers) || 0;
    const gain = pending && Number(pending[id]);
    const add = Number.isFinite(gain) && gain > 0 ? layerGainRoom(stored, Math.floor(gain), m.layerCap) : 0;
    layers += stored + add;
  }
  const r = results && typeof results.get === 'function' ? results.get(ps.playerId) : null;
  const opUids = new Set();
  for (const p of ps.board.values()) if (p && p.kind === 'chess') opUids.add(p.uid);
  let standing = units;
  if (r && Array.isArray(r.unitsEnd) && r.unitsEnd.length) {
    standing = 0;
    for (const u of r.unitsEnd) if (u && opUids.has(u.uid) && u.alive) standing++;
  }
  return { units, active, layers, standing };
}

/**
 * The ≤ maxHelpers helpers, first = the one that meets the enemies first (right-hand field).
 *
 * 接怪优先级 (this build, big-team rule): with many players and many leaks, the players carrying the MOST 盟约层数
 * (Σ layers of their active bonds, `helperStats.layers`) take the enemies first, then the rest by the same key — the
 * official tie-breakers (units on the field > an active bond > standing units > seat) decide among equal layer counts.
 * Up to config.unite.maxHelpers helpers participate (raised to 4 for big teams; the official game caps at 2).
 */
export function helperOrder(m, perfects, results) {
  const st = new Map(perfects.map((ps) => [ps.playerId, helperStats(m, ps, results)]));
  const S = (ps) => st.get(ps.playerId);
  const rank = (a, b) => S(b).layers - S(a).layers || S(b).units - S(a).units || (S(b).active - S(a).active) || S(b).standing - S(a).standing || a.seat - b.seat;
  const select = perfects.slice().sort(rank).slice(0, Math.max(1, m.gd.unite.maxHelpers));
  return select.sort(rank);
}

/**
 * The map of the 联防 field (GitHub #41, upstream 0.2.1「官服保留地形」): the ROUND's own battlefield, so the 联防 never
 * flattens the map the players just fought on.
 *   3 / 4 helpers (this fork): the round map widened to one lane per helper — config.unite.roundTemplates[<n>][<id>] or
 *   `<id>_u<n>` (tools/build-data.mjs addUniteRoundMaps: each row = the round map's cols 0-18 + its own 8-column lane
 *   cell repeated); when the data has no widened variant (degraded) the round map itself is fielded.
 *   1 / 2 helpers (and the widened fallback): `roundStageId` unchanged — the round map at cols 0-20 (GEO.UNITE_RECT).
 * The escaped levels (config.unite.templates) stay only as the ROUTE template of the 联防 wave (waves.js
 * buildUniteWave), never as the field's map; that path remains the fallback when `roundStageId` is unknown (degraded
 * data), letting the caller keep the round's stage.
 * @param {import('./gamedata.js').GameData} gd
 * @param {number} helperCount
 * @param {string|null} [roundStageId] the round's own stage id (m.stageId)
 * @returns {string|null}
 */
export function uniteStageId(gd, helperCount, roundStageId = null) {
  if (helperCount >= 3 && roundStageId) {
    const round = (gd.unite.roundTemplates || {})[String(helperCount)] || {};
    const id = round[roundStageId] || `${roundStageId}_u${helperCount}`;
    const st = id ? gd.stage(id) : null;
    if (st && st.kind === 'unite' && st.helpers === helperCount) return id;
  }
  // 1 / 2 helpers (and the fallback for a round map without a widened variant): the ROUND's own map — its terrain,
  // crates, water, devices and runes — the owner's decision of 2026-10-07 「官服保留地形」; upstream 0.2.1 withdraws
  // 0.2.0's escaped-level road map (GitHub #41). Escaped_single / _multi stay in data/stages.json as the route template
  // of the 联防 wave (waves.js buildUniteWave), never as the field's map.
  if (roundStageId && gd.stage(roundStageId)) return roundStageId;
  const templates = gd.unite.templates || {};
  const id = templates[String(helperCount)] ?? templates[helperCount] ?? null;
  const st = id ? gd.stage(id) : null;
  return st && st.kind === 'unite' ? id : null;
}

/**
 * Battle options for one 联防 group's field (without data/logger, added by the match): `helpers` = the ≤ 2 players
 * fighting this group, `leaked` = the enemies they face (the leakers' leaks, or what the previous group left standing).
 */
export function uniteBattleOpts(m, helpers, leaked, timeLimit) {
  const wave = buildUniteWave(m.gd, leaked, helpers.length, timeLimit);
  const players = helpers.map((ps, i) => {
    const carry = new Map();
    const r = m.lastResults.get(ps.playerId);
    const summonUids = new Set();
    for (const p of ps.board.values()) if (p && p.kind === 'token') summonUids.add(p.uid);
    for (const u of (r && r.unitsEnd) || []) {
      if (!u || u.uid == null) continue;
      const sp = Number.isFinite(u.sp) ? Math.max(0, u.sp) : 0;
      // a summon: its SP only ("召唤物仅修改技力"); one off the field at the end enters fresh [ASSUMED]
      if (summonUids.has(u.uid)) { if (u.alive) carry.set(u.uid, { sp }); continue; }
      // knocked out at the end of its own combat: 强制退场 right after the deployment (see header)
      if (!u.alive) { carry.set(u.uid, { down: true }); continue; }
      // HP ratio and SP only: a skill still running at the end is not carried (unitsEnd `skillActive` stays unused —
      // community report #34, GitHub #82)
      carry.set(u.uid, { hpPct: Number.isFinite(u.hpPct) ? Math.max(0.01, Math.min(1, u.hpPct)) : 1, sp });
    }
    // 4 人同图 (this build): the field is the linear map — helper i (0 = meets the enemies first, at the field's right)
    // stands on lane (helpers.length - 1 - i); each lane is 8 columns wide (tools/custom-content.mjs uniteRows).
    const colOffset = 8 * (helpers.length - 1 - i);
    // the layers its own combat reached (bondsView, the round's pending gains; PRTS "以其阵地当前的状态") — see header
    const input = ps.battleInput({ side: 'L', colOffset, carry, reached: true });
    const ev = { input, kind: 'unite', round: m.round, spawns: wave.spawns };
    m.dispatch(ps, 'onBattleStart', ev);
    return ev.input && typeof ev.input === 'object' ? ev.input : input;
  });
  return { wave, players };
}

/**
 * LP loss per leaker after the unite battle: survivors by source (+ unspawned re-entries + not re-entered leaks),
 * capped per round.
 * @returns {Map<string, number>} playerId → survivors (uncapped)
 */
export function uniteSurvivors(plan, uniteResult) {
  const out = new Map();
  for (const [pid, n] of plan.notReentered) out.set(pid, (out.get(pid) || 0) + n);
  const perPlayer = (uniteResult && uniteResult.perPlayer) || {};
  for (const pp of Object.values(perPlayer)) {
    for (const l of (pp && pp.leaked) || []) {
      if (!l || l.counted === false || !l.sourcePlayerId) continue;
      out.set(l.sourcePlayerId, (out.get(l.sourcePlayerId) || 0) + 1);
    }
  }
  for (const u of (uniteResult && uniteResult.unspawned) || []) {
    if (!u || !u.sourcePlayerId) continue;
    out.set(u.sourcePlayerId, (out.get(u.sourcePlayerId) || 0) + 1);
  }
  return out;
}
