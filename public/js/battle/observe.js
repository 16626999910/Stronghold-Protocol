// Observing rules and labels of client-side combat (research 09 §3.1 / §6.3, DESIGN §14 "Spectating") — pure helpers
// for the game screen, the team panel and the combat HUD (mirror of server/match/match/watch.js _watchClient):
//   * prep (休整期): tap a teammate → 前往查看 → their board (read-only);
//   * own normal battle running: no observing ("当前无法查看");
//   * own battle over: "⌛ 作战结束，等待队友完成作战" + the teammates' progress; tap a teammate → 前往查看 → a local
//     replica of their battle; 返回战场 goes back;
//   * 联防 / 最终攻势: the ‹ › pill switches the camera LEFT half / 全景 / RIGHT half of the own field; the other pair's
//     boss field is never shown to a fighting player;
//   * eliminated: anything — each phase reset starts on the player it follows (the server's prep scout / b.start,
//     followedScout).

import { PHASE } from '../../../shared/constants.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';

const isObj = (v) => !!v && typeof v === 'object';
const COMBAT = new Set([PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);

/** The server runs client-side combat (m.public.combatMode). */
export const isClientCombat = (pub) => !!pub && pub.combatMode === 'client';

const players = (pub) => (Array.isArray(pub?.players) ? pub.players.filter(isObj) : []);
const fields = (pub) => (Array.isArray(pub?.fields) ? pub.fields.filter(isObj) : []);

/** The field listing a player, or null. */
export function fieldOf(pub, playerId) {
  return fields(pub).find((f) => Array.isArray(f.players) && f.players.includes(playerId)) || null;
}

/** Display name of a player id ('队友' when unknown). */
export function nameOf(pub, playerId) {
  return players(pub).find((p) => p.playerId === playerId)?.name || t('队友');
}

/**
 * What tapping a team row does: `{ back: true }` (own row while observing), `{ fieldId }` to observe, or `{ reason }`.
 * @param {any} p m.public player row
 * @param {any} pub
 * @param {string} myId
 * @param {{ observing?: boolean, ownDone?: boolean }} [o] ownDone: the local simulation of the own battle already ended
 *   (its result is on the way to the server)
 */
export function observeTarget(p, pub, myId, { observing = false, ownDone = false } = {}) {
  if (!isObj(p)) return { reason: t('无效的目标') };
  if (p.playerId === myId) return observing ? { back: true } : { reason: null };
  if (p.alive === false || p.status === 'left') return { reason: t('该队友已被淘汰，无法查看') };
  const phase = pub?.phase;
  const me = players(pub).find((x) => x.playerId === myId) || null;
  const meAlive = me ? me.alive !== false : true;
  if (!COMBAT.has(phase)) return { fieldId: `n:${p.playerId}` };
  const target = fieldOf(pub, p.playerId);
  if (!target) return { reason: t('该队友当前没有战场') };
  const own = fieldOf(pub, myId);
  if (!meAlive || !own) return { fieldId: target.fieldId };
  if (own.fieldId === target.fieldId) return { reason: t('队友与你在同一战场，使用 ‹ › 切换视角') };
  if (target.kind === 'boss' || target.kind === 'hidden') return { reason: t('无法查看另一组队友的战场') };
  if (own.kind === 'normal' && own.live !== false && !ownDone) return { reason: t('作战中无法查看队友，作战结束后可前往查看') };
  return { fieldId: target.fieldId };
}

/**
 * A screen reloaded (or a socket reconnected) while it watched a teammate's battle after the own one: the server
 * resends the watched field (Match._resendBattle, b.start `watch: true`), but a fresh screen starts at home — so the
 * observing pill, 返回战场 and the own row would be missing. Decided once per battle, at the first sight of its
 * battleId (`seen` = the battleId already decided): adopt `fieldId` as the watched field when it is a teammate's normal
 * battle in 各自行动 shown to a living player who watches nothing. Never for a battle first seen while watching (a
 * 前往查看 under way — and its 返回战场 must not bring it back while the own b.start is on its way), the own field, a
 * 联防 leaker's field or an eliminated player's auto-observed one (those keep their own rules). A loading battle (its
 * state carries no `watch` yet) is decided once it runs, unless the screen already watches (then it is marked seen).
 * @param {any} b battleRunner.state() @param {{ pub?: any, myId?: string, alive?: boolean, watching?: string|null,
 *   seen?: string|null }} [o]
 * @returns {{ seen: string|null, fieldId: string|null }} seen: the new value to remember
 */
export function resumedWatch(b, { pub = null, myId = '', alive = true, watching = null, seen = null } = {}) {
  const keep = { seen, fieldId: null };
  if (!isObj(pub) || !isObj(b) || typeof b.battleId !== 'string' || !b.battleId || b.battleId === seen) return keep;
  if (b.loading && !watching) return keep;
  const done = { seen: b.battleId, fieldId: null };
  if (b.loading || watching || !alive || !isClientCombat(pub) || pub.phase !== PHASE.COMBAT) return done;
  if (!b.watch || b.kind !== 'normal' || typeof b.fieldId !== 'string' || !b.fieldId) return done;
  const f = fields(pub).find((x) => x.fieldId === b.fieldId);
  if (!f || f.kind !== 'normal' || !Array.isArray(f.players) || f.players.includes(myId)) return done;
  return { seen: b.battleId, fieldId: b.fieldId };
}

/**
 * The prep board the server pushed to a viewer that follows a player (an eliminated player or a spectator seat:
 * Match._followScout — the player it last watched, else the first player still in; community report of 2026-10-06,
 * item 56, the idea of PR #189), to adopt as the watched board like a 前往查看 tap: `field` is such a scout (m.field
 * `prep`, an `n:<pid>` id other than the own) and the screen watches nothing (`watching` null — a 返回战场 this phase is
 * not overridden: the caller adopts a board once per phase). Null for a living player: its phase resets keep its own
 * board.
 * @param {{ field?: any, watching?: string|null, alive?: boolean, spectator?: boolean, myId?: string }} o
 * @returns {string|null} the fieldId to watch
 */
export function followedScout({ field = null, watching = null, alive = true, spectator = false, myId = '' } = {}) {
  if (watching || (alive && !spectator) || !isObj(field) || !field.prep) return null;
  const fid = field.fieldId;
  if (typeof fid !== 'string' || !fid.startsWith('n:') || fid === `n:${myId}`) return null;
  return fid;
}

/** Teammates' progress for the waiting pill: [{ playerId, name, killed, total, done, isBot }]. */
export function teammateProgress(pub, myId) {
  const out = [];
  for (const f of fields(pub)) {
    if (f.kind !== 'normal' || !Array.isArray(f.players)) continue;
    const pid = f.players[0];
    if (pid === myId) continue;
    const p = players(pub).find((x) => x.playerId === pid);
    const pr = isObj(f.progress) ? f.progress : null;
    out.push({
      playerId: pid, name: p?.name || t('队友'), isBot: !!p?.isBot,
      killed: Number.isFinite(pr?.killed) ? pr.killed : null, total: Number.isFinite(pr?.total) ? pr.total : null,
      done: f.live === false || !!pr?.done,
    });
  }
  return out;
}

/** Side of each player of a local field meta (`sides` from the runner, else seat order). */
export function sidesOf(field) {
  if (isObj(field?.sides)) return field.sides;
  const ps = Array.isArray(field?.players) ? field.players : [];
  return Object.fromEntries(ps.map((pid, i) => [pid, i === 1 ? 'R' : 'L']));
}

/**
 * 四人联防分道取景 (this build): the field rect of helper lane `i` — its own 8-column "small map" inside the widened
 * corridor. Helper 0 (the 接怪 rank that meets the enemies first) is on the field's RIGHT lane, so its lane is the
 * rightmost (colOffset 8·(n−1−i), the same offset server/match/unite.js gives it); lane rect = colOffset+2 … +10.
 * Returns `rect` unchanged for a single lane (n < 2).
 */
export function uniteLaneRect(rect, i, n) {
  if (i == null || !(n > 1) || !rect) return rect;
  const off = 8 * (n - 1 - i);
  return { r0: rect.r0, r1: rect.r1, c0: rect.c0 + 2 + off, c1: rect.c0 + 2 + off + 8 };
}

/**
 * The ‹ › camera layers of a 联防 / boss field.
 *   3 / 4-lane 联防 (this build): one layer per helper lane ("四个小地图") plus 全景 — named like the halves, the viewer's
 *   own lane "你自己" (the native ‹ › pill then switches the camera onto each lane).
 *   1 / 2 helpers and boss / hidden fields: LEFT half, 全景, RIGHT half with captions "你自己" / "👁 name" / "全景" /
 *   "无人在家". Empty for normal fields and single-player boss fields.
 */
export function cameraLayers(field, pub, myId) {
  if (!isObj(field) || (field.kind !== 'unite' && field.kind !== 'boss' && field.kind !== 'hidden')) return [];
  const ps = Array.isArray(field.players) ? field.players : [];
  if (field.kind === 'unite' && ps.length >= 3) {
    const label = (pid, i) => (pid === myId ? t('你自己') : nameOf(pub, pid) || `P${i + 1}`);
    return [
      { key: 'ALL', label: t('全景'), self: false, watch: false },
      ...ps.map((pid, i) => ({ key: `lane:${i}`, label: label(pid, i), self: pid === myId, watch: false })),
    ];
  }
  // a lone helper fights on ONE half (uniteRect): no halves to switch between
  if (field.kind === 'unite' && ps.length < 2) return [];
  const sides = sidesOf(field);
  const at = (side) => Object.keys(sides).find((pid) => sides[pid] === side) || null;
  const label = (pid) => (!pid ? t('无人在家') : pid === myId ? t('你自己') : nameOf(pub, pid));
  const left = at('L');
  const right = at('R');
  if ((field.kind === 'boss' || field.kind === 'hidden') && (!left || !right)) return [];
  return [
    { key: 'L', label: label(left), self: left === myId, watch: !!left && left !== myId },
    { key: 'ALL', label: t('全景'), self: false, watch: false },
    { key: 'R', label: label(right), self: right === myId, watch: !!right && right !== myId },
  ];
}

/**
 * Camera options of a layer for view.setCamera(kind, …).
 * `fit: true` on the 3/4-lane 联防: render/projection.js presetCamera treats a unite rect with r0 6-13 in a landscape
 * viewport as a KNOWN rect and returns the OFFICIAL camera, which IGNORES the rect — so the ‹ › pill's label followed
 * while the picture never moved, stuck on the official 21-column framing (the owner's report of 2026-10-08). Forcing
 * the fitted path frames the lane (or the widened corridor for 全景) exactly.
 */
export function layerCamera(field, layer, mySide = 'L') {
  const rect = field?.rect;
  const ps = Array.isArray(field?.players) ? field.players : [];
  const lane = typeof layer === 'string' ? /^lane:(\d+)$/.exec(layer) : null;
  if (lane) return { rect: uniteLaneRect(rect, Number(lane[1]), ps.length), fit: true };
  if (layer === 'L' || layer === 'R') return { rect, side: layer, half: true };
  // 全景 of a 3/4-lane field: the widened corridor is wider than the official 21 columns — fit it too
  if (field?.kind === 'unite' && ps.length >= 3) return { rect, fit: true };
  return { rect, side: mySide };
}

/**
 * The watched player's effects column for a battle watched as a display replica (user playtest #2: while spectating,
 * the right column shows the spectated player's effects, not one's own). The spec's raw playerEffects (Battle spec:
 * `{ id, source = iconKind, counter, … }`) resolved client-side — a band effect through bands.json (its effectId),
 * everything else through effects.json; `effectIconUrl`'s per-kind fallbacks cover the missing icon ids. Undefined
 * where whose column would be ambiguous (联防 / boss pairs) or there are no effects data (a server-run field's meta
 * comes from the server without effects — the column stays empty rather than showing one's own).
 */
export function spectateEffects(spec, members) {
  if (!Array.isArray(members) || members.length !== 1 || !isObj(spec)) return undefined;
  const p = Array.isArray(spec.players) ? spec.players.find((x) => isObj(x) && x.playerId === members[0]) : null;
  if (!p || !Array.isArray(p.playerEffects)) return undefined;
  const out = [];
  for (const pe of p.playerEffects) {
    if (!isObj(pe) || typeof pe.id !== 'string' || !pe.id) continue;
    const counter = pe.counter != null ? { counter: pe.counter } : {};
    if (pe.source === 'band') {
      const band = data.list('bands').find((b) => b && b.effectId === pe.id);
      if (band) {
        out.push({ id: pe.id, name: band.effectName || band.name, desc: band.desc || '', iconKind: 'band', iconId: band.iconId || band.bandId, ...counter });
        continue;
      }
    }
    const rec = data.lookup('effects', pe.id);
    out.push({ id: pe.id, name: rec?.name || pe.id, desc: rec?.desc || rec?.descRaw || '', iconKind: pe.source || 'choice', iconId: pe.id, ...counter });
  }
  return out;
}
