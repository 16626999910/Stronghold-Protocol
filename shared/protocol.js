// Normative message catalogue (DESIGN §8). Used by server (validation) and client (building requests).
// Every client→server message is `{ t, rid?, ...fields }`. Unknown `t` or invalid fields ⇒ ERR.BAD_MSG.

import { DIFFICULTIES, NAME_MAX_LEN, ROOM_CODE_LEN, MAX_SEATS, ROOM_PLAYER_OPTIONS, ROOM_EXTENSIONS, EMOTES, GEO, CHAT_MAX_LEN, LOBBY_CHAT_MAX_LEN, SANDBOX_HP_MUL_MAX } from './constants.js';
import { isDroppableChess } from './standIn.js';
import { diySlotIds, validateDiyPicks } from './diy.js';

// ---- tiny validators -------------------------------------------------------
const isInt = (v, lo = -Infinity, hi = Infinity) => Number.isInteger(v) && v >= lo && v <= hi;
const isStr = (v, max = 64) => typeof v === 'string' && v.length <= max;
const isBool = (v) => typeof v === 'boolean';

/**
 * 头像 (this build, 大厅右上角): a player-chosen 游戏本体头像 is its official avatarId (`avatar_def_01` …); the client
 * resolves it to a URL via assets.js `avatarSrc`. An avatarId-shaped string, else it is not an avatar (null = the default).
 */
export const AVATAR_RE = /^[A-Za-z0-9_]{1,64}$/;
export const isAvatar = (v) => typeof v === 'string' && AVATAR_RE.test(v);
/** Sanitize a client-sent avatar: the avatarId when it is id-shaped, else null (unknown → the default). */
export const sanitizeAvatar = (v) => (isAvatar(v) ? v : null);
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_\-.:]+$/.test(v);
const isUid = (v) => isInt(v, 1, 2 ** 31);
const isNum = (v, lo = -Infinity, hi = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const optional = (check) => (v) => v === undefined || check(v);
const nullable = (check) => (v) => v === null || v === undefined || check(v);
/** Wire shape of an avatar field: null / absent, or a short string (the server sanitizes it to an avatarId or null). */
const avatarField = (v) => v == null || isStr(v, 64);
/** A plain object with at most `max` own keys, every key passing `key` and every value passing `val`. */
const isMap = (v, max, key, val) => {
  if (!isPlain(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > max) return false;
  for (const k of keys) if (!key(k) || !val(v[k])) return false;
  return true;
};
const isList = (v, max, item) => Array.isArray(v) && v.length <= max && v.every(item);

// ---- client-side combat (DESIGN §14): b.progress / b.result payloads -------------------------------------------

/** Size limits of a b.result payload (the whole frame also obeys the 64 KB inbound limit). */
// Rosters (battle results, per-player maps) are bounded by the room capacity, never a literal 4: with MAX_SEATS = 10 a
// hardcoded limit would reject every result of a big team as BAD_MSG.
export const RESULT_LIMITS = Object.freeze({ players: MAX_SEATS, leaked: 400, unitsEnd: 64, unitStats: 160, layerGains: 40, mods: 16, unspawned: 400 });
const BIG = 1e13;
// 战斗伤害/治疗量级单独放宽 (无尽狂潮: R100 起首领血池 > 1e13, R110 ≈ 8.4e13, 累计可再高几倍): a client reports the
// shared-pool damage as a CUMULATIVE value, and a field's damageDealt/healingDone are the same magnitude, so the plain
// BIG would reject the whole b.progress / b.result once it crosses 1e13 → the server never credits it (community report
// 2026-10-14「110 层以上首领打它不掉血」). Bounded by 2^53 (Number.MAX_SAFE_INTEGER) for exact integer arithmetic; the
// endless stat growth itself is capped (constants.js ENDLESS.GROWTH_CAP) so every battle value stays under it.
const DMG_BIG = Number.MAX_SAFE_INTEGER;
const isStat = (v) => v === undefined || isNum(v, 0, BIG);
const isDmgStat = (v) => v === undefined || isNum(v, 0, DMG_BIG);
const isModVal = (v) => v === null || isNum(v, -BIG, BIG) || isStr(v, 64) || isBool(v);
const isLeak = (l) => isPlain(l) && isId(l.enemyKey)
  && (l.mods === undefined || l.mods === null || isMap(l.mods, RESULT_LIMITS.mods, (k) => isStr(k, 32), isModVal))
  && optional((v) => isNum(v, 0, 1000))(l.lpr) && nullable(isId)(l.sourcePlayerId) && nullable((v) => isStr(v, 16))(l.tag)
  && optional(isBool)(l.counted) && optional(isBool)(l.boss) && optional(isBool)(l.spawned);
const isUnitEnd = (u) => isPlain(u) && nullable(isUid)(u.uid) && isNum(u.hpPct, 0, 1) && isNum(u.sp, 0, 1e5) && isBool(u.alive)
  && optional(isBool)(u.skillActive) && nullable(isId)(u.defId);
const isUnitStat = (u) => isPlain(u) && nullable(isUid)(u.uid) && nullable(isId)(u.defId) && optional((v) => isStr(v, 16))(u.kind)
  && isDmgStat(u.dmg) && isStat(u.kills) && isDmgStat(u.heal) && isDmgStat(u.taken) && isStat(u.attacks);
const isPerPlayer = (p) => isPlain(p) && isInt(p.killed, 0, 1e5) && isInt(p.total, 0, 1e5) && p.killed <= p.total
  && isList(p.leaked, RESULT_LIMITS.leaked, isLeak) && isBool(p.perfect)
  && isMap(p.layerGains, RESULT_LIMITS.layerGains, isId, (v) => isNum(v, 0, 1e4))
  && isStat(p.coins) && isDmgStat(p.damageDealt) && isDmgStat(p.bossDamage) && isDmgStat(p.healingDone) && isStat(p.deaths)
  && isList(p.unitsEnd, RESULT_LIMITS.unitsEnd, isUnitEnd)
  && (p.unitStats === undefined || isList(p.unitStats, RESULT_LIMITS.unitStats, isUnitStat));
const isUnspawned = (u) => isPlain(u) && isId(u.enemyKey) && nullable(isId)(u.sourcePlayerId) && nullable((v) => isStr(v, 16))(u.tag)
  && optional((v) => isNum(v, 0, 1e6))(u.time);

/**
 * Structural check of a client BattleResult (DESIGN §5.1 / §14 `b.result`): types, ranges and size limits only —
 * the semantic checks against the battle's spec are the server's (server/match/fields.js validateClientResult).
 */
export function isBattleResult(v) {
  return isPlain(v) && ['cleared', 'timeout', 'forced'].includes(v.reason) && isNum(v.time, 0, 1e5)
    && optional((x) => isInt(x, 0, 1e5))(v.killed) && optional((x) => isInt(x, 0, 1e5))(v.total)
    && isMap(v.perPlayer, RESULT_LIMITS.players, isId, isPerPlayer) && Object.keys(v.perPlayer).length > 0
    && (v.unspawned === undefined || isList(v.unspawned, RESULT_LIMITS.unspawned, isUnspawned))
    && optional((x) => isInt(x, 0, 1e9))(v.errors) && optional(isDmgStat)(v.bossHpLeft);
}

// ---- operator loadout (DESIGN §16): room.loadout { entries } -------------------------------------------------

/**
 * `room.loadout { entries }`: `entries` = `{ [baseChessId]: { skill?: skillIndex, module?: uniEquipId | 'none' } }`
 * (the per-browser loadout of the 干员调配 screen). Structural limits below; the semantic check against the game data
 * (known visible chess, legal skill index for the normal AND the elite status, legal module of the elite) is
 * `checkLoadout` — used by the server (lobby, match) and by the client to sanitise a stored loadout before sending.
 */
export const LOADOUT_LIMITS = Object.freeze({ entries: 160, skillIndex: 9 });
/** The "no module" choice of an elite (模组: 不装备). */
export const MODULE_NONE = 'none';
const isLoadoutEntry = (e) => isPlain(e) && Object.keys(e).length > 0 && Object.keys(e).every((k) => k === 'skill' || k === 'module')
  && optional((v) => isInt(v, 0, LOADOUT_LIMITS.skillIndex))(e.skill) && optional(isId)(e.module);
/** Structural check of `room.loadout.entries`. */
export const isLoadoutEntries = (v) => isMap(v, LOADOUT_LIMITS.entries, isId, isLoadoutEntry);

// ---- 干员皮肤 (docs/SKINS.md): room.skins { skins } -----------------------------------------------------------

/**
 * `room.skins { skins }`: `skins` = `{ [baseChessId]: skinId }`.
 * Unlike `room.loadout` these are PUBLIC: they ride in `Match.publicView().players[]` so a teammate sees your
 * skin, which is the whole point of choosing one in a co-op match.
 */
export const SKIN_LIMITS = Object.freeze({ entries: 160, idLen: 64 });
/** A skinId. NOT `isId`: those allow only `[A-Za-z0-9_\-.:]`, and skin ids carry `@` and `#` (`char_002_amiya@winter#1`). */
export const isSkinId = (v) => typeof v === 'string' && v.length > 0 && v.length <= SKIN_LIMITS.idLen && /^[A-Za-z0-9_@#+.\-]+$/.test(v);
/** Structural check of `room.skins.skins`. */
export const isSkinSelection = (v) => isMap(v, SKIN_LIMITS.entries, isId, isSkinId);

/** Skill indexes a chess record offers (data `skills[]`, DESIGN §16; the default skill alone while data lacks it). */
function skillIndexesOf(c) {
  if (!c || typeof c !== 'object') return [];
  if (Array.isArray(c.skills) && c.skills.length) {
    return [...new Set(c.skills.map((s) => s && s.index).filter((i) => isInt(i, 0, LOADOUT_LIMITS.skillIndex)))].sort((a, b) => a - b);
  }
  return isInt(c.skill?.index, 0, LOADOUT_LIMITS.skillIndex) ? [c.skill.index] : [];
}

/**
 * What the 干员调配 screen may choose for one chess (DESIGN §16).
 *   skills: skill indexes unlocked at BOTH the normal and the elite status (identical sets in the official data)
 *   defaultSkill: `defaultSkillIndex` (data: the skills[] entry flagged isDefault, else `skill.index`)
 *   modules: the elite's modules (uniEquipId…) + 'none'; [] when the chess has no elite record
 *   defaultModule: the elite's default module (`defaultUniEquipId`), 'none' for module-less elites, null without elite
 * @param {any} base normal chess record
 * @param {any} [golden] its elite record (null when absent)
 * @returns {{ skills: number[], defaultSkill: number|null, modules: string[], defaultModule: string|null }}
 */
export function loadoutOptions(base, golden = null) {
  const n = skillIndexesOf(base);
  const g = golden ? skillIndexesOf(golden) : null;
  const skills = g && g.length ? n.filter((i) => g.includes(i)) : n;
  const flagged = Array.isArray(base?.skills) ? base.skills.find((s) => s && s.isDefault && isInt(s.index, 0, LOADOUT_LIMITS.skillIndex)) : null;
  let defaultSkill = flagged ? flagged.index : isInt(base?.skill?.index, 0, LOADOUT_LIMITS.skillIndex) ? base.skill.index : null;
  if (defaultSkill == null || !skills.includes(defaultSkill)) defaultSkill = skills.length ? skills[0] : defaultSkill;
  let modules = [];
  let defaultModule = null;
  if (golden) {
    let def = null;
    if (Array.isArray(golden.modules)) {
      modules = [...new Set(golden.modules.map((m) => m && m.uniEquipId).filter((id) => isId(id) && id !== MODULE_NONE))];
      const d = golden.modules.find((m) => m && m.isDefault && isId(m.uniEquipId));
      def = d ? d.uniEquipId : null;
    } else if (golden.module && golden.module.active && isId(golden.module.id)) {
      modules = [golden.module.id];
    }
    if (def == null && golden.module && golden.module.active && modules.includes(golden.module.id)) def = golden.module.id;
    modules.push(MODULE_NONE);
    defaultModule = def || MODULE_NONE;
  }
  return { skills, defaultSkill, modules, defaultModule };
}

/**
 * Semantic check + normalisation of a loadout against the game data (DESIGN §16). Strict: any unknown / hidden / elite
 * chess id, illegal skill index or module rejects the whole loadout. Entries equal to the defaults are dropped, the
 * rest are stored complete: `{ skill, module }` (module null for a chess without an elite record).
 * @param {any} entries `room.loadout.entries`
 * @param {(id: string) => any} getChess chess record lookup (normal and golden ids)
 * @returns {{ ok: true, loadout: Record<string, { skill: number, module: string|null }> } | { error: 'BAD_MSG'|'BAD_TARGET', detail: string }}
 */
export function checkLoadout(entries, getChess) {
  if (!isLoadoutEntries(entries)) return { error: 'BAD_MSG', detail: 'bad loadout entries' };
  const out = {};
  for (const id of Object.keys(entries)) {
    const e = entries[id];
    const base = typeof getChess === 'function' ? getChess(id) : null;
    if (!base || base.isGolden || base.visible === false || base.isHidden || base.isDiy || (base.baseId && base.baseId !== id)) {
      return { error: 'BAD_TARGET', detail: `unknown chess ${id}` };
    }
    const golden = base.goldenId ? getChess(base.goldenId) || null : null;
    const opt = loadoutOptions(base, golden);
    const skill = e.skill ?? opt.defaultSkill;
    if (!opt.skills.includes(skill)) return { error: 'BAD_TARGET', detail: `skill ${e.skill} not available for ${id}` };
    if (e.module !== undefined && !golden) return { error: 'BAD_TARGET', detail: `${id} has no elite module` };
    const module = golden ? (e.module ?? opt.defaultModule) : null;
    if (golden && !opt.modules.includes(module)) return { error: 'BAD_TARGET', detail: `module ${e.module} not available for ${id}` };
    if (skill === opt.defaultSkill && module === opt.defaultModule) continue;
    out[id] = { skill, module };
  }
  return { ok: true, loadout: out };
}

/**
 * The skill index / module a board chess fights with under a (checked) loadout (DESIGN §16 PlayerBattleInput units):
 * normal chess → `{ skillIndex, moduleId: null }` (normal chess have no module); elite → `moduleId` = uniEquipId or
 * 'none'. Chess the loadout does not mention use their defaults.
 * @param {Record<string, { skill: number, module: string|null }> | null | undefined} loadout
 * @param {any} chess the piece's chess record (normal or golden)
 * @param {(id: string) => any} getChess
 * @returns {{ skillIndex: number|null, moduleId: string|null }}
 */
export function resolveLoadout(loadout, chess, getChess) {
  if (!chess || typeof chess !== 'object') return { skillIndex: null, moduleId: null };
  const baseId = chess.baseId || chess.chessId;
  const base = chess.isGolden ? (getChess(baseId) || chess) : chess;
  const golden = chess.isGolden ? chess : null;
  const opt = loadoutOptions(base, chess.isGolden ? chess : (base.goldenId ? getChess(base.goldenId) || null : null));
  const e = loadout && Object.hasOwn(loadout, baseId) ? loadout[baseId] : null;
  const skillIndex = e && opt.skills.includes(e.skill) ? e.skill : opt.defaultSkill;
  let moduleId = null;
  if (golden) moduleId = e && opt.modules.includes(e.module) ? e.module : opt.defaultModule;
  return { skillIndex, moduleId };
}

// ---- operator ownership (干员持有, 0.2.0 补位): room.ownership { notOwned } -------------------------------------------

/**
 * `room.ownership { notOwned }`: the base chess ids the player marked as not owned on the 干员持有 screen (the
 * per-browser setting next to 干员调配; default: every operator owned ⇒ []). Such a chess keeps its identity (name,
 * bonds, 特质, tier, price, merge) and fights as its official stand-in (shared/standIn.js standInRecord). Structural
 * limit below; the semantic check (`checkNotOwned`) is LENIENT, unlike checkLoadout: an id that is not a droppable chess
 * (unknown, elite, PRESET / 自选, a stale id of another build) is dropped, never the whole list.
 */
export const OWNERSHIP_LIMITS = Object.freeze({ notOwned: 160 });
/** Structural check of `room.ownership.notOwned`: an array of ≤ 160 ids. */
export const isNotOwnedList = (v) => isList(v, OWNERSHIP_LIMITS.notOwned, isId);

/**
 * Semantic check + normalisation of a not-owned list against the game data: keeps the ids of droppable chess
 * (shared/standIn.js isDroppableChess — NORMAL base chess with a stand-in), deduplicated and sorted; drops the rest.
 * Used by the server (lobby, match) and by the client before it sends or imports a list.
 * @param {any} list `room.ownership.notOwned`
 * @param {(id: string) => any} getChess chess record lookup
 * @returns {{ ok: true, notOwned: string[], dropped: number } | { error: 'BAD_MSG', detail: string }}
 */
export function checkNotOwned(list, getChess) {
  if (!isNotOwnedList(list)) return { error: 'BAD_MSG', detail: 'bad notOwned list' };
  const keep = new Set();
  for (const id of list) {
    const c = typeof getChess === 'function' ? getChess(id) : null;
    if (c && c.chessId === id && isDroppableChess(c)) keep.add(id);
  }
  const notOwned = [...keep].sort();
  return { ok: true, notOwned, dropped: list.length - notOwned.length };
}

// ---- 自选编队 (0.2.0 DIY): room.diy { picks } ------------------------------------------------------------------------

/**
 * `room.diy { picks }`: the player's 自选编队 — `{ [slotBaseId]: { charId, skillIndex?, uniEquipId? } | null }` for the
 * four DIY slots (data/backups.json `diy.slots`: two at tier 5, two at tier 6; shared/diy.js). An out-of-match setting
 * like 干员持有: stored per session / seat, a match takes the picks its seat had at its start. Structural limit below
 * (room for more slots in a later season); the semantic check (`checkDiyPicks`) is LENIENT, like checkNotOwned: an
 * illegal pick — not a pick of the slot's tier, an operator without a kit, a prototype off its locked skill, an unknown
 * skill / module, the same operator twice in a tier, an owned operator in a second slot, an unknown slot — is dropped,
 * never the whole roster; only malformed input is BAD_MSG.
 */
export const DIY_LIMITS = Object.freeze({ slots: 8 });
const isDiyPickWire = (p) => p === null || (isPlain(p) && isId(p.charId)
  && nullable((v) => isInt(v, 0, 9))(p.skillIndex) && nullable(isId)(p.uniEquipId));
/** Structural check of `room.diy.picks`: a map of ≤ 8 slot ids → a pick `{ charId, skillIndex?, uniEquipId? }` or null. */
export const isDiyPicks = (v) => isMap(v, DIY_LIMITS.slots, isId, isDiyPickWire);

/**
 * Semantic check + normalisation of a 自选 roster against the game data (`{ chess, backups }` or a sim DataSource) and
 * the kit registry (`kitted`: server/sim/content/kits/index.js KITTED_CHARS — an operator without a kit is never fielded):
 * the slots are taken in data order (tier 5, then tier 6), and each pick is kept when the roster so far plus it still
 * passes shared/diy.js validateDiyPicks — so the result always passes it, and of two picks that clash (one owned operator
 * in two slots, one operator twice in a tier) the first slot keeps it. Kept picks are complete
 * (`{ charId, skillIndex, uniEquipId }`: a prototype's locked selection, uniEquipId null = no module).
 * @param {any} picks `room.diy.picks`
 * @param {{ data: any, kitted?: Iterable<string>|((id: string) => boolean)|null }} opts
 * @returns {{ ok: true, picks: Record<string, { charId: string, skillIndex: number, uniEquipId: string|null }>, dropped: number }
 *   | { error: 'BAD_MSG', detail: string }}
 */
export function checkDiyPicks(picks, { data, kitted = null } = { data: null }) {
  if (!isDiyPicks(picks)) return { error: 'BAD_MSG', detail: 'bad 自选 picks' };
  const slots = diySlotIds(data);
  /** @type {Record<string, { charId: string, skillIndex: number, uniEquipId: string|null }>} */
  const kept = {};
  let dropped = 0;
  for (const id of Object.keys(picks)) if (picks[id] != null && !slots.includes(id)) dropped++;
  for (const slotId of slots) {
    const pick = Object.hasOwn(picks, slotId) ? picks[slotId] : null;
    if (pick == null) continue;
    const res = validateDiyPicks({ ...kept, [slotId]: pick }, { data, kitted });
    if ('ok' in res) kept[slotId] = res.picks[slotId];
    else dropped++;
  }
  return { ok: true, picks: kept, dropped };
}

// ---- unit stats (user playtest #4 item 7): m.unitStats units and the browser battle's live stats ---------------------

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
/** Attack interval (s) of a stats object: its own `interval`, else bat × 100 / aspd (null without an attack time). */
const intervalOf = (x) => {
  if (Number.isFinite(x.interval) && x.interval > 0) return round2(x.interval);
  const bat = fin(x.bat, 0);
  const aspd = fin(x.aspd, 100) > 0 ? fin(x.aspd, 100) : 100;
  return bat > 0 ? round2((bat * 100) / aspd) : null;
};
const statView = (x) => ({
  maxHp: Math.round(fin(x.maxHp)), atk: Math.round(fin(x.atk)), def: Math.round(fin(x.def)), res: round1(fin(x.res)),
  interval: intervalOf(x), blockCnt: Math.max(0, Math.round(fin(x.blockCnt))), moveSpeed: round2(fin(x.moveSpeed)),
});

/**
 * The detail card's stats of a sim unit (server/sim/units.js Unit): its effective stats `s` (the aggregated `unit.s`,
 * or the last ones the sim computed) next to its own `unit.base` (no buffs) — max HP, ATK, DEF, RES, attack interval
 * (s), block, move speed — rounded for display (the sim keeps floats), plus the current HP. The shape of the
 * `m.unitStats` units (Match.unitStats: what the board's units start their next battle with) and of the browser
 * runner's live battle stats (public/js/battle/runner.js unitStats). An ally with a range also carries `range`: the grid
 * (`[dRow, dCol]`, facing RIGHT) it attacks with now — a running skill's range, rangeExtend included, not a kit's
 * target-selection grid (the sim's `unit.liveRangeGrid`, Battle._refreshRange; community report E1 after 0.1.0: 烛煌
 * S3's 4-11 never reached the card).
 * @param {{ id?: number, uid?: number|null, defId?: string, hp?: number, alive?: boolean, base?: any, liveRangeGrid?: any } | null} u
 * @param {any} [s] aggregated stats (missing ⇒ the base)
 * @returns {{ id: number|null, uid: number|null, defId: string|null, hp: number, alive: boolean, maxHp: number, atk: number,
 *   def: number, res: number, interval: number|null, blockCnt: number, moveSpeed: number,
 *   base: { maxHp: number, atk: number, def: number, res: number, interval: number|null, blockCnt: number, moveSpeed: number },
 *   range?: Array<[number, number]> }}
 */
export function unitStatsEntry(u, s = null) {
  const base = u && u.base && typeof u.base === 'object' ? u.base : {};
  const cur = s && typeof s === 'object' ? s : base;
  const range = u?.side !== 'enemy' && Array.isArray(u?.liveRangeGrid)
    ? u.liveRangeGrid.filter((p) => Array.isArray(p) && Number.isInteger(p[0]) && Number.isInteger(p[1])).map((p) => [p[0], p[1]])
    : null;
  return {
    id: Number.isInteger(u?.id) ? u.id : null,
    uid: Number.isInteger(u?.uid) ? u.uid : null,
    defId: typeof u?.defId === 'string' ? u.defId : null,
    hp: Math.max(0, Math.round(fin(u?.hp))),
    alive: u?.alive !== false,
    ...statView(cur),
    base: statView(base),
    ...(range ? { range } : {}),
    // the enemy card greys a SILENCE-format line (折射) from this; absent flags ⇒ not silenced
    silenced: !!(cur.flags && cur.flags.silence),
  };
}

/** Deploy directions (DESIGN §3, research 09 §1.2; the same list as server/sim/dir.js DIRS). */
export const DIRS = Object.freeze(['UP', 'RIGHT', 'DOWN', 'LEFT']);
const isDir = (v) => DIRS.includes(v);

const target = (v) => {
  if (!v || typeof v !== 'object') return false;
  if (v.area === 'board') return isInt(v.row, 0, GEO.ROWS - 1) && isInt(v.col, 0, GEO.COLS - 1);
  if (v.area === 'hand') return isInt(v.idx, 0, GEO.HAND_SIZE - 1);
  return false;
};

/** @type {Record<string, Record<string, (v:any)=>boolean> & { $optional?: string[] }>} */
export const C2S = {
  // session & lobby
  hello: { name: (v) => isStr(v, NAME_MAX_LEN) && v.trim().length > 0, token: (v) => v == null || isStr(v, 64), version: (v) => v == null || isInt(v, 0, 1e6), avatar: avatarField, $optional: ['token', 'version', 'avatar'] },
  ping: { c: (v) => typeof v === 'number' && Number.isFinite(v) },
  // 头像 (this build): change the lobby avatar live (no re-hello). `avatar` is an avatarId, or null for the default (the
  // server sanitizes the value: a malformed string is stored as null, never a broken image).
  'me.avatar': { avatar: avatarField },
  // players (开始匹配 / 房间人数): the room's own capacity up front (ROOM_PLAYER_OPTIONS, default 4) — the lobby's 创建同盟
  // sends it so the room opens at the chosen size; the host may still change it later with room.setOptions.
  'room.create': { mode: (v) => v === 'solo' || v === 'coop', difficulty: (v) => DIFFICULTIES.includes(v), private: (v) => v == null || isBool(v), players: (v) => v == null || ROOM_PLAYER_OPTIONS.includes(v), sandbox: (v) => v == null || isBool(v), endless: (v) => v == null || isBool(v), $optional: ['private', 'players', 'sandbox', 'endless'] },
  'room.join': { code: (v) => isStr(v, ROOM_CODE_LEN + 2) && /^[A-Za-z0-9]+$/.test(v) },
  'room.leave': {},
  'room.ready': { ready: isBool },
  'room.setDifficulty': { difficulty: (v) => DIFFICULTIES.includes(v) },
  // 玩法扩展 (this build, host-only): the room's own player capacity (ROOM_PLAYER_OPTIONS: 4/6/8/10/12) and the
  // optional rules of the 玩法扩展 panel (ROOM_EXTENSIONS — currently 'revive'). Either field may be sent alone.
  'room.setOptions': {
    maxPlayers: optional((v) => ROOM_PLAYER_OPTIONS.includes(v)),
    extensions: optional((v) => isMap(v, ROOM_EXTENSIONS.length, (k) => ROOM_EXTENSIONS.includes(k), isBool)),
    $optional: ['maxPlayers', 'extensions'],
  },
  'room.addBot': {},
  'room.removeBot': { seat: (v) => isInt(v, 0, MAX_SEATS - 1) },
  // the host removes another human before the match (server/lobby.js kick; community report #17); playerId = the one the
  // host confirmed — a seat that changed hands meanwhile is refused
  'room.kick': { seat: (v) => isInt(v, 0, MAX_SEATS - 1), playerId: isId },
  'room.start': {},
  // operator loadout (DESIGN §16): stored per session/seat; accepted until the match leaves INFO_CHECK
  'room.loadout': { entries: isLoadoutEntries },
  // 干员皮肤 (docs/SKINS.md): public, accepted in any room phase
  'room.skins': { skins: isSkinSelection },
  // operator ownership (干员持有, 0.2.0 补位): stored per session / seat; a match takes the list its seat had when it
  // started (an out-of-match setting — during a match it is stored for the next one: ROOM_STARTED)
  'room.ownership': { notOwned: isNotOwnedList },
  // 自选编队 (0.2.0 DIY): the player's DIY slot picks; stored per session / seat like room.ownership (a match takes the
  // picks its seat had when it started; during a match they are stored for the next one: ROOM_STARTED)
  'room.diy': { picks: isDiyPicks },
  // spectator seats (remake feature, community report #26; MAX_SPECTATORS): take one of a co-op room's spectator seats —
  // in its lobby or while its match runs — never a player seat; the host frees one by playerId (the spectator gets
  // room.closed { reason: 'kicked' }). room.leave / g.leave leave a spectator seat like a player seat.
  'room.spectate': { code: (v) => isStr(v, ROOM_CODE_LEN + 2) && /^[A-Za-z0-9]+$/.test(v) },
  'room.removeSpectator': { playerId: isId },

  // 房间大厅 (this build's addition, formerly 多人匹配): browse the server's open co-op rooms instead of trading keys by hand.
  //   lobby.list  { }          → answered by the push `lobby.rooms { rooms, stats }` (the asker only)
  //   lobby.quickMatch { size? } → join the fullest open room; when nothing is joinable, open a new co-op room.
  //                              With `size` (开始匹配): enter the server 匹配池 at that 房间人数 (and, when `difficulty`
  //                              is given, that 模拟难度) — NEVER a hand-made room. Once enough matchers of the same
  //                              difficulty + size are queued, a fresh hidden room opens for exactly them and starts by
  //                              itself (server/lobby.js _matchFromPool / _launchMatchedRoom). The client polls this
  //                              while 匹配中; a miss is a plain `ok` (the caller stays pooled).
  //   lobby.quickMatchCancel { } → leave the 匹配池 (the lobby's 取消匹配 button; also on disconnect).
  //   room.setPrivate { bool } → the host hides / re-lists their lobby-phase room in that list
  'lobby.list': {},
  'lobby.quickMatch': {
    difficulty: (v) => v == null || DIFFICULTIES.includes(v),
    size: (v) => v == null || ROOM_PLAYER_OPTIONS.includes(v),
    $optional: ['difficulty', 'size'],
  },
  'lobby.quickMatchCancel': {},
  'room.setPrivate': { private: isBool },

  // 大厅聊天 (this build): the lobby's chat board. chatList → answered by the push `lobby.chat { messages }` (the asker
  // only); chatSend posts one message — `kind` picks the shape: 'text' needs `text`, 'emote' needs `emote` (an id from
  // EMOTES), 'party' is a 组队公告 whose room code the server derives from the sender's own room (never taken from the
  // client). The cross-field rules live in the handler (server/lobby.js), not in this per-field validator.
  'lobby.chatList': {},
  'lobby.chatSend': {
    kind: (v) => v === 'text' || v === 'emote' || v === 'party',
    text: optional((v) => isStr(v, LOBBY_CHAT_MAX_LEN)),
    emote: optional((v) => EMOTES.includes(v)),
    $optional: ['text', 'emote'],
  },

  // 问题反馈 (this build): the lobby's 问题反馈 board. list → answered by the push `feedback.items { items }` (the
  // asker only); post adds a message; comment replies to one (ids come from `feedback.items`).
  'feedback.list': {},
  'feedback.post': { text: (v) => isStr(v, 500) },
  'feedback.comment': { id: (v) => isInt(v, 1, 2 ** 31), text: (v) => isStr(v, 300) },
  // remove: delete one's OWN message (commentId absent) or own comment (commentId given)
  'feedback.remove': { id: (v) => isInt(v, 1, 2 ** 31), commentId: (v) => v == null || isInt(v, 1, 2 ** 31), $optional: ['commentId'] },

  // 大厅排行榜 (this build): one record per 隐藏首领 (the fastest ABYSS clear). list → answered by the push
  // `leaderboard.items { items }`; get { bossId } → `leaderboard.entry { entry }` (the full settlement rows).
  'leaderboard.list': {},
  'leaderboard.get': { bossId: isId },

  // 无尽模式排行榜 (阶段7): two boards (通过回合数 / 打桩累计伤害), top teams each. list → answered by the push
  // `endlessLeaderboard.items { rounds, damage }`.
  'endlessLeaderboard.list': {},

  // match
  'g.infoReady': {},
  // 重刷本局 (match/reroll.js): host opens the vote / a voter answers / the starter cancels
  'g.rerollSetup': {},
  'g.rerollVote': { id: isId, agree: isBool },
  'g.cancelReroll': { id: isId },
  'g.band': { bandId: isId },
  'g.bandSkip': {},
  // the strategy highlighted in the draft screen (user playtest #4 item 4): a turn that runs out takes it while it is
  // free (Match.timeoutBand); absent / null clears it
  'g.bandFocus': { bandId: nullable(isId), $optional: ['bandId'] },
  'g.buy': { slot: (v) => isInt(v, 0, 15) },
  'g.econBuy': { idx: (v) => isInt(v, 0, 15) }, // 经济商店弹窗: 买转职/装备
  'g.econRefresh': {}, // 经济商店弹窗: 刷新货架 (首次 1 币, 每次翻倍)
  'g.refresh': {},
  'g.freeze': {},
  'g.levelUp': {},
  'g.sell': { uid: isUid },
  // dir: the facing chosen on the deploy wheel for a board target (absent ⇒ RIGHT; the piece's own tile ⇒ re-orient)
  'g.move': { uid: isUid, to: target, dir: isDir, $optional: ['dir'] },
  // replaceUid: with both of the target's slots used, the equipped item the replace dialog picked (research 09 §1.2
  // UseEquipUp.unloadInstId; absent ⇒ the oldest; not one of the target's items ⇒ BAD_TARGET)
  'g.equip': { itemUid: isUid, targetUid: isUid, replaceUid: nullable(isUid), $optional: ['replaceUid'] },
  'g.art': { itemUid: isUid, row: (v) => isInt(v, 0, GEO.ROWS - 1), col: (v) => isInt(v, 0, GEO.COLS - 1), dir: isDir, $optional: ['dir'] },
  'g.destroy': { uid: isUid },
  // 无尽狂潮 装备拆卸器: strip every item off the operator `targetUid` back to the 装备库 (author 2026-10-12)
  'g.unequip': { targetUid: isUid },
  // 无尽狂潮 肉鸽: 选藏品 (3 选 1) / 选通用决策 (3 选 1) / 第 1 回合选专属盟约 (8 选 1) (author 2026-10-12)
  'g.relic': { idx: (v) => isInt(v, 0, 5) },
  'g.decision': { idx: (v) => isInt(v, 0, 5) },
  'g.exclusive': { bondId: isId },
  'g.reward': { idx: (v) => isInt(v, 0, 5) },
  'g.choice': { idx: (v) => isInt(v, 0, 5) },
  'g.ready': { ready: isBool },
  'g.emote': { id: (v) => EMOTES.includes(v) },
  // 局内文字聊天（作者 2026-10-11）：一条自由文本，结构上限 CHAT_MAX_LEN（服务端还会去控制符 / 压缩空白 / 拒绝空串）——
  // 客户端以文本节点渲染，无注入风险
  'g.chat': { text: (v) => isStr(v, CHAT_MAX_LEN) },
  // playerId: the player tapped in the team panel (a 联防 / boss pair field shows two) — what an eliminated viewer or a
  // spectator seat follows from then on (Match.watchPref; community report of 2026-10-06, item 56)
  'g.watch': { fieldId: (v) => isStr(v, 32), playerId: isId, $optional: ['playerId'] },
  'g.autoplay': { on: isBool },
  // 复活队友 (this build): spend REVIVE_COST_LP of the sender's own LP to bring an eliminated teammate back at
  // REVIVE_RESTORE_LP; each player may do it REVIVE_PER_PLAYER time(s) per match (server/match/match/intents.js revive)
  'g.revive': { playerId: isId },
  // solo pause (official PauseUp / ResumeUp, DESIGN §14): freezes the running battle (field clock, deadlines, the
  // browser's local runner) — solo matches only (co-op ⇒ WRONG_PHASE), only while a battle runs; m.public.paused
  'g.pause': { on: isBool },
  // the stats the own board's units start their next battle with (user playtest #4 item 7; prep phases): answered by
  // the push m.unitStats { seq, round, units: [unitStatsEntry] }; `seq` is echoed so the client keeps the newest answer
  'g.unitStats': { seq: (v) => isInt(v, 0, 2 ** 31), $optional: ['seq'] },
  // 沙盒 (this build): the in-match 控制台 — 沙盒对局 only (otherwise WRONG_PHASE).
  //   g.sandboxSet { stageId?, mode?('wave'|'boss'), enemies?:[{key,count}], bossId?, hpMul?(1..100),
  //                  bonds?:{ [bondId]: layers(0..9999) } }  (bonds = set each 羁绊's layer count directly)
  //   g.sandboxGive { kind:'chess'|'item', id }  → grant one operator / equipment (buy-all)
  //   g.sandboxStart { }                          → run one battle from the current config
  //   g.sandboxExit { }                           → leave a running battle, back to 沙盒准备
  //   g.sandboxClear { area:'bench'|'board' }     → clear the bench (hand/temp) or the board
  'g.sandboxSet': {
    stageId: optional(isId), mode: optional((v) => v === 'wave' || v === 'boss'),
    enemies: optional((v) => isList(v, 64, (x) => isPlain(x) && isId(x.key) && isInt(x.count, 0, 999))),
    bossId: optional(isId), hpMul: optional((v) => isNum(v, 1, SANDBOX_HP_MUL_MAX)), layerCap: optional((v) => isInt(v, 0, 9999)),
    bonds: optional((v) => isPlain(v) && Object.keys(v).length <= 64 && Object.entries(v).every(([k, n]) => isId(k) && isInt(n, 0, 999))),
    $optional: ['stageId', 'mode', 'enemies', 'bossId', 'hpMul', 'layerCap', 'bonds'],
  },
  'g.sandboxGive': { kind: (v) => v === 'chess' || v === 'item', id: isId },
  'g.sandboxStart': {},
  'g.sandboxExit': {},
  'g.sandboxClear': { area: (v) => v === 'bench' || v === 'board' },
  'g.leave': {},

  // client-side combat (DESIGN §14): the authoritative client of a field reports its battle; a 联防 field adds
  // `left` = { [leakerId]: its enemies still standing (unspawned, alive, or through again) } (server/sim/spec.js
  // uniteLeft; user playtest #6 item 7 — the leakers' live counter)
  'b.progress': {
    battleId: isId, gt: (v) => isNum(v, 0, 1e5), killed: (v) => isInt(v, 0, 1e5), total: (v) => isInt(v, 0, 1e5),
    leaks: (v) => isNum(v, 0, 1e6), bossDmg: isDmgStat,
    // 首领重生 / 阶段切换把共享血池回满的累计量（LocalBossPool.healed）：服务端据此 refill 权威血池
    bossHeal: isDmgStat,
    by: (v) => isMap(v, RESULT_LIMITS.players, isId, isDmgStat), done: isBool,
    left: (v) => isMap(v, RESULT_LIMITS.players, isId, (x) => isInt(x, 0, 1e5)),
    // 跨越战场的盾卫共享血池：本战场对每条池的累计伤害（boss_12 爱国者；≤ 16 条，每条一个非负数）
    parts: (v) => isList(v, 16, isDmgStat),
    partsHeal: (v) => isList(v, 16, isDmgStat),
    $optional: ['leaks', 'bossDmg', 'bossHeal', 'by', 'done', 'left', 'parts', 'partsHeal'],
  },
  'b.result': { battleId: isId, result: isBattleResult },
};

// Server → client message types (documentation + client dispatch table keys).
export const S2C = [
  'welcome', 'ok', 'error', 'pong',
  'room.state', 'room.closed',
  // lobby.rooms { rooms: [{ code, hostName, mode, difficulty, players, maxSeats, spectators, inMatch }], stats } —
  // the answer to lobby.list (房间大厅 browse panel; the asker only)
  'lobby.rooms',
  // lobby.stats { online, inRoom, inMatch, rooms, matches, humans, bots, spectators } — 在线人数 (this build): pushed
  // to every connected session when the roster changes and on a 10 s timer; shown on the lobby and 组队 (room) screens
  'lobby.stats',
  // 问题反馈 / 大厅排行榜 (this build): feedback.items { items } (the answer to feedback.list / after post / comment) ·
  // leaderboard.items { items } (the answer to leaderboard.list: one row per 隐藏首领, the fastest ABYSS clear — only
  // the boss, owner, MVP and clear time; the rows carry no settlement data) · leaderboard.entry { entry } (the answer
  // to leaderboard.get: the full record with its settlement rows, or null)
  'feedback.items', 'leaderboard.items', 'leaderboard.entry',
  // 无尽模式排行榜 (阶段7): endlessLeaderboard.items { rounds, damage } — the answer to endlessLeaderboard.list
  'endlessLeaderboard.items',
  // 大厅聊天 (this build): lobby.chatMsg { id, playerId, name, status: 'lobby'|'room', kind: 'text'|'emote'|'party',
  // text?, emote?, code?, at } — one new message, broadcast to EVERY connected session (the sender's own copy arrives the
  // same way) · lobby.chat { messages: [same item shape] } — the answer to lobby.chatList (the asker only), oldest first
  'lobby.chatMsg', 'lobby.chat',
  'm.public', 'm.private', 'm.field', 'm.toast', 'm.ticker', 'm.emote', 'm.chat', 'm.result',
  // m.unitStats { seq, round, units: [unitStatsEntry] } — the answer to g.unitStats (the requester only)
  'm.unitStats',
  // client-side combat (DESIGN §14): b.start { battleId, fieldId, kind, spec, authoritative, startAt, serverNow, elapsed,
  // speed, watch? } · b.pool { hp, max, teamLp, acked: { [fieldId]: cumulative boss damage counted } } ·
  // b.end { battleId, fieldId, reason }
  'b.start', 'b.pool', 'b.end',
  // server-run combat streaming (legacy / SP_COMBAT=server only)
  'b.snap', 'b.ev',
];

/**
 * Validate a decoded client message. Returns `null` when valid, otherwise a short reason string.
 * Extra unknown fields are ignored (not copied by handlers).
 */
export function validateC2S(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'not an object';
  const spec = typeof msg.t === 'string' && Object.hasOwn(C2S, msg.t) ? C2S[msg.t] : null;
  if (!spec) return `unknown type ${String(msg.t).slice(0, 32)}`;
  if (msg.rid != null && !isInt(msg.rid, 0, 2 ** 31)) return 'bad rid';
  const optional = spec.$optional || [];
  for (const [k, check] of Object.entries(spec)) {
    if (k === '$optional') continue;
    const v = msg[k];
    if (v === undefined && optional.includes(k)) continue;
    if (!check(v)) return `bad field ${k}`;
  }
  return null;
}

// Event tuple kinds inside `b.ev` (DESIGN §8.2).
export const EV = Object.freeze({
  SPAWN: 'spawn', ATK: 'atk', DMG: 'dmg', HEAL: 'heal', SKILL: 'skill', ENGAGE: 'engage', DIE: 'die', LEAK: 'leak',
  STATUS: 'status', FX: 'fx', LAYER: 'layer', BOUNTY: 'bounty', DEPLOY: 'deploy',
});

/**
 * The model form a `b.ev` 'fx' tuple ['fx', kind, x, y, extra] puts its unit in: `extra.form` (sim content/enemies/helpers.js
 * setForm — 转译基底·α's forms, a 逐火 余烬 and its revival, a leader's 重生, 守墓石像's modes, 掠海漂移体's crawl; a 傀儡师's 替身,
 * sim professions.js; a string is that clip set, null the base one), undefined for any other tuple. A form is state, not decoration: a view that misses
 * the fx keeps drawing the old model (player report #5 after 0.1.0), so the client's catch-up frames, its hidden-tab
 * backlog (battle/runner.js) and the events buffered before a field is entered (screens/game.js) keep these tuples.
 */
export function fxForm(ev) {
  if (!Array.isArray(ev) || ev[0] !== EV.FX) return undefined;
  const x = ev[4];
  if (!x || typeof x !== 'object' || x.id == null || !Object.hasOwn(x, 'form')) return undefined;
  return typeof x.form === 'string' ? x.form : null;
}
