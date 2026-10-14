// server/lobby.js — rooms, seats, host, AI seats, ready/start, reconnect, and room → Match wiring
// (DESIGN §2, §6.1 LOBBY, §8.1). Implements the handler interface consumed by server/net.js.
//
// Rules (the choices where DESIGN is silent are marked ▸):
//   * Rooms are keyed by 4-letter codes from an unambiguous alphabet (no I/O, letters only). Join codes are
//     case-insensitive.
//   * 'solo' rooms hold exactly one human and never bots. 'coop' rooms have 4 seats (humans + AI bots).
//     Humans and bots take the lowest free seat index; seat indexes never compact.
//   * ▸ Being in a LOBBY room and sending room.create / room.join implicitly leaves it. While your room is
//     in a match, create/join of another room fails with ROOM_STARTED (send g.leave or room.leave first).
//   * Host-only: room.setDifficulty, room.addBot, room.removeBot, room.kick, room.start. ▸ Changing the difficulty
//     un-readies the other humans. ▸ room.start requires every other human to be connected and ready;
//     the host's start counts as the host's ready (the host may still toggle room.ready for display).
//   * room.kick {seat, playerId} (community report #17, owner approved): before the match only, the host removes another
//     human like an AI seat (an AI seat stays room.removeBot's; never the host itself). `playerId` names the player the
//     host confirmed: a seat that changed hands meanwhile (left, someone else joined) is refused with BAD_TARGET. The
//     seat is freed at once and the player gets `room.closed {reason:'kicked'}` — now, or on the next resume when
//     offline (with the result replay, as the grace timeout) —, so the reconnect token no longer leads back to the seat
//     (it stays the player's identity: net.js sessions belong to players, not seats). ▸ No ban: the player may join
//     again with the code.
//   * Host migration: when the host leaves (or is removed), the lowest-seat remaining human (connected
//     ones first) becomes host. A room without humans is disposed (bots never keep a room alive).
//   * Disconnect in LOBBY: the seat shows connected=false and is freed after `lobbyGraceMs` (60 s); a
//     session that comes back after that gets `room.closed {reason:'timeout'}`.
//     Disconnect in a match: the seat is kept and match.onDisconnect(playerId) is called.
//   * Reconnect: `hello` with a known token (reconnect window, 10 min, see net.js) rebinds the session;
//     the lobby then broadcasts room.state and, in a match, calls match.onReconnect(playerId).
//     Solo runs (下半: "休整期及机变阶段没有时间限制…24小时内随时返回", research 01 §1 / 06 §17): a session that drops
//     while its solo room's match runs stays resumable for the official `config.constants.singleReconnectTime`
//     (86400 s; option `soloReconnectWindowMs` overrides it) instead of the 10-minute window — the untimed solo match
//     simply waits (net.js session.resumeWindowMs, set at every disconnect). Only after that does expiry turn into
//     match.onLeave ('abandoned'). The extension outlives the match, so a run that ended meanwhile (e.g. a server-run
//     Final Assault) still shows its result on the player's return.
//     A repeated hello on a live connection is a full resync: room.state goes to the requester only
//     (broadcast only when the seat visibly changed, e.g. a rename in LOBBY); the heavy part (match.onReconnect,
//     or the result replay below) runs at most once per `resyncMinGapMs` per session — extra requests inside
//     that window coalesce into one deferred resync, so hello spam cannot amplify into ~15 KB per request.
//   * Result replay: the match's final m.public and each human's m.result are kept after the match ends. A
//     human who resyncs (resume after a drop, a reloaded tab, a repeated hello) while the room is back in LOBBY
//     gets room.state followed by those two frames again, until they act in the room (ready, difficulty, AI
//     seats, start), leave it, or a new match starts. A human removed by the lobby grace gets them right after
//     `room.closed {timeout}` on their next resume (Match.onReconnect cannot do this: the lobby drops the
//     match reference at onEnd and disposes it on the next macrotask).
//   * Per-network limits (internet clients only, see net.js clientAddress): at most `maxRoomsPerAddr` rooms
//     created from one network may exist at once and at most `maxMatchesPerAddr` matches started from one
//     network may run at once (room.create / room.start → ERR.RATE). Without them a socket loop could fill
//     `maxRooms` or keep hundreds of unattended matches simulating for the whole reconnect window.
//   * Permanent departure during a match (room.leave, g.leave, reconnect window expired): the seat is
//     marked departed (shown as connected=false), match.onLeave(playerId) is called, and the seat is freed
//     when the match ends. 'g.leave' is handled here and never reaches match.handle().
//   * All other 'g.*' messages go to room.match.handle(playerId, msg); its {ok}/{error} becomes the reply.
//   * Match lifecycle: room.start → new Match({...}) → room.state (inMatch=true) → match.start(). The match gets
//     `matchNo` = the room's match number (1, 2, …): with the seed it keeps battleIds unique across the room's
//     matches, so a late b.progress / b.result of the previous match is ignored by the next one (DESIGN §14).
//     onEnd(summary) → room back to LOBBY (departed seats freed, humans un-readied, disconnected humans
//     get the lobby grace), dispose() on the next macrotask. Players can start again.
//   * 空闲对局清理 (this build, `idleMatchWindowMs`, default 1 h): a room whose match has had no CONNECTED human for
//     that long is disposed (`room.closed { idle }`), so an abandoned run does not hold memory for the whole 24 h solo
//     reconnect window — see sweepIdle.
//   * room.closed reasons: 'timeout' (removed after lobby grace), 'kicked' (room.kick, room.removeSpectator), 'empty' (a
//     spectator whose room lost its last player), 'idle' (no connected player for idleMatchWindowMs), 'shutdown'
//     (server stopping).
//   * Operator loadout (DESIGN §16): room.loadout { entries } is checked strictly against the game data
//     (shared/protocol.js checkLoadout: known visible chess, a skill index legal for the normal AND the elite status, a
//     module of the elite or 'none'; any bad entry rejects the whole message, nothing is stored). ▸ It is stored on the
//     session (it follows the player into every room they create/join, and survives a resume) and on the seat; the
//     match receives seats[].loadout (bots: none — they fight with the defaults). ▸ Accepted any time: in a LOBBY room
//     (or outside a room) it simply replaces the stored one; while the room's match runs it is also handed to
//     match.setLoadout(playerId, loadout), which accepts it only during INFO_CHECK (the 干员调配 entry of the briefing)
//     and refuses it afterwards (WRONG_PHASE: the match's loadout is locked, the stored one applies to the next match).
//   * Operator ownership (干员持有, 0.2.0 补位, owner's decision 2026-10-05): room.ownership { notOwned } — the base chess
//     ids the player marked as not owned — is checked leniently (shared/protocol.js checkNotOwned: anything that is not
//     a droppable NORMAL chess is dropped, never the whole list; only a malformed list is BAD_MSG) and stored on the
//     session and the seat like the loadout. The match receives seats[].notOwned when it starts (bots: none — they own
//     every operator) and keeps it for its whole length: the setting is out of match ("局外设置，下一局生效"), so while
//     the room's match runs a new list is only stored for the next match (ROOM_STARTED 'stored for the next match',
//     never handed to the match). A spectator's list stays on its session.
//   * 自选编队 (0.2.0 DIY, the owner's decisions of 2026-10-05): room.diy { picks } — the player's picks for the four DIY
//     slots ({ [slotBaseId]: { charId, skillIndex?, uniEquipId? } | null }) — is checked leniently (shared/protocol.js
//     checkDiyPicks against the game data and the kit registry, server/sim/content/kits/index.js KITTED_CHARS: an
//     illegal pick — an operator without a kit, another tier's prototype, a prototype off its locked skill, a second slot
//     of one owned operator, the same operator twice in a tier, an unknown slot / skill / module — is dropped, never the
//     whole roster; only malformed picks are BAD_MSG) and stored on the session and the seat exactly like the
//     not-owned list: the match receives seats[].diy when it starts (bots: none — they field no 自选 piece [ASSUMED]),
//     and a change while it runs is stored for the next match (ROOM_STARTED 'stored for the next match'). Every
//     `welcome` carries `diyKitted` (welcomeInfo): the operators a DIY slot may field, so the client's picker offers
//     exactly what the server accepts.
//   * Spectator seats (community report #26, owner's decision 2026-10-04 — a remake feature, the official room has none):
//     room.spectate { code } takes one of a co-op room's MAX_SPECTATORS (2) spectator seats, in its lobby or while its
//     match runs (▸ solo rooms: ROOM_FULL). A spectator is not a player: never in `seats`, never counted for the 1–4 players
//     or the start gate, never host, never keeps a room alive (a room whose last human leaves closes with room.closed
//     {empty} for its spectators). It receives room.state (`spectators: [{ playerId, name, connected }]`) and every match
//     broadcast (m.public, m.ticker, m.emote, b.pool — public data); the match registers it (opts.spectators /
//     addSpectator) and shows it fields like an eliminated player (b.start watch / m.field), never an m.private. It may
//     only g.watch (the heavy bucket, like every watcher), g.leave / room.leave, and room.loadout / room.ownership /
//     room.diy (stored for its session, never handed to the match); anything else → SPECTATOR (▸ emotes too). Host: room.removeSpectator { playerId } any
//     time → room.closed {kicked} to it. A spectator in a LOBBY room may take a free player seat with room.join of the same
//     code; a player never switches to spectating in place (ALREADY). Disconnect / grace / reconnect / expiry work as for
//     a player seat (the seat is kept and given back on resume).

import { randomBytes, randomInt } from 'node:crypto';
import { ERR, DIFFICULTIES, MAX_SEATS, MAX_AI_SEATS, MAX_SPECTATORS, ROOM_PLAYER_OPTIONS, DEFAULT_ROOM_PLAYERS, ROOM_EXTENSIONS, ROOM_EXTENSIONS_DEFAULT, ROOM_CODE_LEN, modeIdFor, ENDLESS, extensionsAreDefault } from '../shared/constants.js';
import { checkLoadout, checkNotOwned, checkDiyPicks, sanitizeAvatar } from '../shared/protocol.js';
import { encode, isDroppable, isErrCode, sendRaw, sendSession } from './net.js';
import { getData as defaultGetData, lookup } from './data.js';
import { Match as DefaultMatch } from './match/Match.js';
import { KITTED_CHARS } from './sim/content/kits/index.js';
import { Feedback } from './feedback.js';
import { LobbyChat } from './lobbyChat.js';
import { Leaderboard } from './leaderboard.js';
import { EndlessLeaderboard } from './endlessLeaderboard.js';
import { msUntilTime, nextTempRestartAt } from './http/restart.js';

/** How often the lobby pushes its online counters to every connected session (lobby.stats). */
export const ONLINE_PUSH_MS = 10_000;

/** Messages that change who is where — the online counters are re-broadcast right after one of them (see onMessage). */
const ONLINE_AFFECTING = new Set([
  'room.create', 'room.join', 'room.leave', 'room.spectate', 'room.removeSpectator', 'room.start', 'room.kick',
]);

/** Room code alphabet: uppercase letters without I and O (and no digits, so no 0/1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Tunables. */
export const LOBBY_DEFAULTS = Object.freeze({
  lobbyGraceMs: 60_000,   // disconnected humans keep their lobby seat this long
  maxRooms: 1000,
  maxRoomsPerAddr: 16,    // rooms created from one client network that may exist at once (0 = unlimited)
  maxMatchesPerAddr: 8,   // matches started from one client network that may run at once (0 = unlimited)
  resyncMinGapMs: 1000,   // heavy resyncs (match state / result replay) per session at most this often on repeated hellos
  soloReconnectWindowMs: null, // a dropped solo run stays resumable this long (null = data singleReconnectTime, 24 h)
  // 空闲对局清理 (this build): a room whose match has had NO connected human for this long is disposed, so an
  // abandoned run does not sit in memory for the whole 24 h reconnect window (a busy server accumulated 55 hanging
  // matches that way). A player who returns inside the window keeps the run exactly as before; one who returns later
  // gets room.closed { idle } and starts a fresh match. 0 (or a negative value) turns the sweep off.
  idleMatchWindowMs: 3_600_000,
  // 每日重启 (this build, server/http/restart.js): the LOCAL time { hour, minute } the process restarts itself at, or
  // null when that is off. Published to clients in every `welcome` (welcomeInfo) as the lobby notice's on/off signal;
  // the shown time itself is a fixed 北京时间 3:25 in the client.
  restartAt: null,
  // 问题反馈 (this build, server/feedback.js): where the board file lives (null → the default <root>/feedback/…, never a
  // served directory) and the per-session cooldown between posts / comments.
  feedbackFile: null,
  feedbackCooldownMs: 4000,
  // 大厅排行榜 (this build, server/leaderboard.js): where the board file lives (null → the default <root>/leaderboard/…,
  // never a served directory). One record per 隐藏首领: the fastest ABYSS clear, with its owner / MVP / settlement rows.
  leaderboardFile: null,
  // 无尽模式排行榜 (阶段7, server/endlessLeaderboard.js): two boards (通过回合数 / 打桩累计伤害), top teams each.
  endlessLeaderboardFile: null,
  // 大厅聊天 (this build, server/lobbyChat.js): the in-memory chat ring — its capacity, the per-message text cap, the
  // per-session cooldown between ordinary messages / 组队公告, and a global per-second broadcast ceiling (fan-out is
  // O(在线人数), so a busy lobby is capped to keep a chat storm from amplifying).
  lobbyChatMaxItems: 100,
  lobbyChatMaxLen: 120,
  lobbyChatCooldownMs: 1200,
  lobbyPartyCooldownMs: 6000,
  lobbyChatBroadcastsPerSec: 12,
});

/**
 * How often the idle sweep looks at the rooms (ms): at most 60 s, at least 1 s, and a quarter of the window when that
 * is smaller — so a short window in a test (or a deployment that sets seconds) is honoured promptly.
 * @param {number} windowMs
 */
export const idleSweepMs = (windowMs) => Math.max(1_000, Math.min(60_000, Math.floor((Number(windowMs) > 0 ? Number(windowMs) : 60_000) / 4)));

/** Official `singleReconnectTime` (s) when the data lacks it (constData, research 01 §1). */
export const SOLO_RECONNECT_FALLBACK_SEC = 86_400;

/**
 * 每日重启: normalize a `restartAt` option into `{ hour, minute }` or null (off / unreadable). startServer computes it
 * already (server/http/restart.js); this guards a Lobby built directly (tests) too.
 * @param {unknown} v
 * @returns {{ hour: number, minute: number } | null}
 */
export function validRestartAt(v) {
  if (!v || typeof v !== 'object') return null;
  const hour = Number(v.hour);
  const minute = Number(v.minute);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

/** Display names for AI teammates (the tutorial NPCs first, then a few familiar faces). */
export const BOT_NAMES = Object.freeze(['AI·华法琳', 'AI·阿米娅', 'AI·惊蛰', 'AI·杜宾', 'AI·凯尔希', 'AI·可露希尔']); // i18n-ignore: player names (docs/I18N.md)

const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @typedef {{ seat: number, playerId: string, name: string, avatar?: string|null, isBot: boolean, ready: boolean,
 *             connected: boolean, left: boolean, loadout?: Record<string, { skill: number, module: string|null }> | null,
 *             notOwned?: readonly string[] | null, diy?: Readonly<Record<string, DiyLoadout>> | null,
 *             skins?: Readonly<Record<string, string>> | null }} Seat
 * @typedef {{ charId: string, skillIndex: number, uniEquipId: string|null }} DiyLoadout
 */

/** Deep-frozen copy of a checked loadout (shared by the session, the seat and the match's PlayerState). */
function freezeLoadout(loadout) {
  const out = {};
  for (const [id, e] of Object.entries(loadout || {})) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
  return Object.freeze(out);
}

/** Deep-frozen copy of checked 自选 picks (shared by the session, the seat and the match's PlayerState). */
function freezeDiy(picks) {
  const out = {};
  for (const [id, p] of Object.entries(picks || {})) out[id] = Object.freeze({ charId: p.charId, skillIndex: p.skillIndex, uniEquipId: p.uniEquipId ?? null });
  return Object.freeze(out);
}

/**
 * Frozen copy of a skin selection, keeping only entries whose chess the game data knows (docs/SKINS.md).
 * @param {Record<string, string>} skins `{ [baseChessId]: skinId }`
 * @param {(id: string) => any} getChess
 */
function freezeSkins(skins, getChess) {
  const out = {};
  for (const [id, skinId] of Object.entries(skins || {})) {
    const rec = getChess(id);
    if (!rec || rec.isGolden || rec.visible === false || rec.isHidden || rec.isDiy || (rec.baseId && rec.baseId !== id)) continue;
    out[id] = String(skinId);
  }
  return Object.freeze(out);
}

/** One room: 4 seat slots, host, difficulty, optional running match. */
export class Room {
  /** @param {string} code @param {'solo'|'coop'} mode @param {string} difficulty @param {number} now */
  constructor(code, mode, difficulty, now) {
    this.code = code;
    this.mode = mode;
    this.difficulty = difficulty;
    /** 沙盒模式 (this build): a solo 娱乐 room whose match is a single configurable battle (the in-match 控制台). */
    this.sandbox = false;
    /** 无尽模式 (this build): a fixed 4-player 娱乐 room — 取消 boss 轮 / 回合无限 / 共享血量固定 1 / 打桩环节. */
    this.endless = false;
    /** 房间人数 (host-set, room.setOptions): the room's own player capacity (one of ROOM_PLAYER_OPTIONS, default 4).
     * join / addBot stop at it — the seats array is always MAX_SEATS long but seats at index ≥ maxPlayers are unjoinable. */
    this.maxPlayers = DEFAULT_ROOM_PLAYERS;
    /** 玩法扩展 (host-set, room.setOptions): the optional rules the coming matches honour ({ [ROOM_EXTENSIONS]: bool }). */
    this.extensions = { ...ROOM_EXTENSIONS_DEFAULT };
    /** @type {string | null} */
    this.hostId = null;
    /** @type {(Seat | null)[]} */
    this.seats = new Array(MAX_SEATS).fill(null);
    /** @type {{ playerId: string, name: string, connected: boolean }[]} spectator seats, ≤ MAX_SPECTATORS (header) */
    this.spectators = [];
    /** @type {any} running Match instance */
    this.match = null;
    /** @type {{ live: boolean, ended: boolean, disposed: boolean, match: any } | null} */
    this.matchCtx = null;
    this.matchCount = 0;
    /**
     * 空闲对局清理 (this build): when the running match last had NO connected human (null while somebody is online, or
     * while no match runs). `Lobby.sweepIdle` disposes the room once this is older than `idleMatchWindowMs`.
     * @type {number | null}
     */
    this.idleSince = null;
    /** @type {any} summary passed to onEnd by the last match */
    this.lastSummary = null;
    /**
     * Frames of the last match's end, replayed on resync to humans who have not moved on yet.
     * @type {{ publicFrame: string | null, frames: Map<string, string>, pending: Set<string> } | null}
     */
    this.replay = null;
    /** @type {string | null} per-network limit key of the creator (net.js clientAddress) */
    this.ownerKey = null;
    /** @type {string | null} per-network limit key of whoever started the running match */
    this.matchKey = null;
    /** Listed in the 房间大厅 (多人匹配) browse list (lobby.list) while true; the host toggles it with room.setPrivate. */
    this.isPublic = true;
    /**
     * 开始匹配 (this build): the room was opened/joined through matchmaking — everybody who arrives this way is
     * auto-readied, and the match starts by itself once the room is full (see Lobby.quickMatch / _autoStartIfFull).
     * @type {boolean}
     */
    this.matching = false;
    this.createdAt = now;
    this.disposed = false;
  }

  /** @param {string} playerId @returns {Seat | null} */
  seatOf(playerId) {
    for (const s of this.seats) if (s && s.playerId === playerId) return s;
    return null;
  }

  /** @param {string} playerId @returns {{ playerId: string, name: string, connected: boolean } | null} */
  spectatorOf(playerId) { return this.spectators.find((s) => s.playerId === playerId) || null; }

  /** Lowest free seat index, or -1. */
  freeSeat() { return this.seats.indexOf(null); }

  /** Humans that have not departed, in seat order. @returns {Seat[]} */
  activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); }

  /**
   * 房间大厅 (this build's addition, formerly 多人匹配): the summary `lobby.list` shows for this room — enough to pick one, without the
   * per-seat detail of toState(). `players` counts humans only (an AI teammate fills a seat but is not a joiner).
   * @returns {{ code: string, hostName: string, mode: string, difficulty: string, players: number, maxSeats: number, spectators: number, inMatch: boolean }}
   */
  toSummary() {
    const host = this.seats.find((s) => s && s.playerId === this.hostId) || null;
    return {
      code: this.code,
      hostName: host ? host.name : '',
      mode: this.mode,
      difficulty: this.difficulty,
      players: this.activeHumans().length,
      maxSeats: this.maxPlayers,
      spectators: this.spectators.length,
      inMatch: !!this.match,
      // 无尽模式: the 房间大厅 row shows 「无尽狂潮」 instead of the difficulty tag (无尽狂潮 = ABYSS under the hood)
      endless: this.endless === true,
      // 房间大厅: the match's current round (0 while the room is still in the lobby, or before round 1 starts). The
      // list shows it on running rooms and ranks them by it — highest (nearest to finished) first (lobby.list below).
      round: this.match && Number.isInteger(this.match.round) && this.match.round > 0 ? this.match.round : 0,
    };
  }

  /** `room.state` frame (DESIGN §8.1) plus `inMatch`. */
  toState() {
    return {
      t: 'room.state',
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      difficulty: this.difficulty,
      inMatch: !!this.match,
      isPublic: this.isPublic,
      // 沙盒 (娱乐玩法): the room screen hides the 模拟难度 picker and shows 沙盒 instead (this build, author 2026-10-11)
      sandbox: this.sandbox === true,
      // 无尽模式 (娱乐玩法): the room screen shows 无尽模式 in place of the 模拟难度 picker
      endless: this.endless === true,
      // 开始匹配 (this build): the room fills by matchmaking and starts itself when full (the room screen shows it)
      matching: this.matching,
      // 房间人数 / 玩法扩展 (host-set): the room's own capacity and which optional rules are on
      maxPlayers: this.maxPlayers,
      extensions: { ...this.extensions },
      seats: this.seats.map((s) => (s
        ? { seat: s.seat, playerId: s.playerId, name: s.name, ...(s.avatar ? { avatar: s.avatar } : {}), isBot: s.isBot, ready: s.ready, connected: s.connected && !s.left }
        : null)),
      spectators: this.spectators.map((s) => ({ playerId: s.playerId, name: s.name, ...(s.avatar ? { avatar: s.avatar } : {}), connected: s.connected })),
    };
  }
}

/** Room registry + lobby message handlers. Pass an instance as the `handler` of net.js Network. */
export class Lobby {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   MatchClass?: new (opts: object) => any,
   *   getData?: () => object,
   *   now?: () => number,
   *   seedFn?: () => number,
   *   simPool?: object | null,
   *   options?: Partial<typeof LOBBY_DEFAULTS>,
   * }} opts
   */
  constructor({ registry, log = noopLog, MatchClass = DefaultMatch, getData = defaultGetData, now = Date.now, seedFn, simPool = null, options = {} }) {
    this.registry = registry;
    this.log = log;
    this.MatchClass = MatchClass;
    this.getData = getData;
    this.now = now;
    this.seedFn = seedFn || (() => randomInt(2 ** 32));
    /** worker pool for server-run headless battles (server/match/simPool.js); handed to every Match; null = off */
    this.simPool = simPool;
    this.opts = { ...LOBBY_DEFAULTS, ...options };
    /**
     * 每日重启 (this build): the local time the server restarts itself at, published in every `welcome` so the lobby
     * can warn 「服务器每日 … 重启」; null when the feature is off. Validated here so a malformed option never reaches
     * the client.
     * @type {{ hour: number, minute: number } | null}
     */
    this.restartAt = validRestartAt(this.opts.restartAt);
    /**
     * 问题反馈 (this build): the shared message board, kept in one JSON file so it survives a restart (server/feedback.js).
     * @type {Feedback}
     */
    this.feedback = new Feedback({ file: this.opts.feedbackFile || undefined, log });
    /**
     * 大厅聊天 (this build): the in-memory chat ring (server/lobbyChat.js). No file — 聊天记录仅保存在本次运行.
     * @type {LobbyChat}
     */
    this.chat = new LobbyChat({
      now: () => this.now(),
      log,
      maxItems: this.opts.lobbyChatMaxItems,
      maxText: this.opts.lobbyChatMaxLen,
    });
    /**
     * 大厅排行榜 (this build): one record per 隐藏首领 — the fastest ABYSS clear, in one JSON file so it survives a
     * restart (server/leaderboard.js).
     * @type {Leaderboard}
     */
    this.leaderboard = new Leaderboard({ file: this.opts.leaderboardFile || undefined, log });
    /**
     * 无尽模式排行榜 (阶段7): 通过回合数 / 打桩累计伤害 两个榜，各取前几名队伍 (server/endlessLeaderboard.js).
     * @type {EndlessLeaderboard}
     */
    this.endlessBoard = new EndlessLeaderboard({ file: this.opts.endlessLeaderboardFile || undefined, log });
    /** 开始匹配 (this build): the 匹配池 — humans waiting for a 房间人数 to fill. Each entry is
     * { playerId, name, difficulty, size } (session resolved from the registry when the group forms); a client
     * polls quickMatch while 匹配中, so the caller is always taken OUT of the pool before re-queuing (never counted
     * twice). @type {{ playerId: string, name: string, difficulty: string, size: number }[]} */
    this.matchPool = [];
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, NodeJS.Timeout>} lobby grace timers by playerId */
    this.graceTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} deferred (coalesced) resyncs by playerId */
    this.resyncTimers = new Map();
    /** per-network limit warnings: at most one log line per 10 s (the rest are counted) */
    this.limitLog = { at: -Infinity, suppressed: 0 };
    /** 大厅聊天 (this build): a 1 s sliding window of broadcasts, capped at lobbyChatBroadcastsPerSec */
    this.chatWindow = { at: -Infinity, count: 0 };
    /** 在线人数 (this build): periodic lobby.stats push; unref'd so it never holds the process open */
    this.onlineTimer = setInterval(() => this.broadcastOnline(), ONLINE_PUSH_MS);
    this.onlineTimer.unref?.();
    /** 空闲对局清理 (this build): drop matches nobody is connected to; unref'd like the counter above */
    this.idleTimer = setInterval(() => this.sweepIdle(), idleSweepMs(this.opts.idleMatchWindowMs));
    this.idleTimer.unref?.();
  }

  /**
   * 空闲对局清理 (this build): dispose every room whose running match has had no CONNECTED human for
   * `idleMatchWindowMs`. An abandoned run otherwise sits in memory for the whole solo reconnect window (24 h) — on a
   * busy public server that piles up (55 hanging matches at 21 people online). Nothing about a match with somebody
   * watching changes; a returning player inside the window keeps the run, after it they get `room.closed { idle }`.
   */
  sweepIdle() {
    const window = Number(this.opts.idleMatchWindowMs);
    if (!(window > 0)) return;
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.disposed) continue;
      if (!room.match) { room.idleSince = null; continue; }
      const anyConnected = room.activeHumans().some((s) => s.connected);
      if (anyConnected) { room.idleSince = null; continue; }
      if (room.idleSince == null) { room.idleSince = now; continue; }
      if (now - room.idleSince >= window) {
        this.log.info(`[lobby] ${room.code}: no connected player for ${Math.round((now - room.idleSince) / 1000)} s — disposing the idle match`);
        this.disposeRoom(room, 'idle');
      }
    }
  }

  /** @param {string} code @returns {Room | null} */
  getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; }

  /** Counters for /healthz. */
  stats() {
    let matches = 0;
    let humans = 0;
    let bots = 0;
    let spectators = 0;
    for (const r of this.rooms.values()) {
      if (r.match) matches++;
      for (const s of r.seats) if (s && !s.left) (s.isBot ? bots++ : humans++);
      spectators += r.spectators.length;
    }
    return { rooms: this.rooms.size, matches, humans, bots, spectators };
  }

  /**
   * 在线人数 (this build's addition): the counters the lobby / 组队 screens show. `stats().humans` counts humans
   * SEATED in a room, which is not "who is online" — this counts every connected session instead and breaks it down
   * by activity, so the display can distinguish 在大厅 / 在房间 / 对局中.
   * @returns {{ online: number, inRoom: number, inMatch: number, rooms: number, matches: number,
   *             humans: number, bots: number, spectators: number }}
   */
  onlineStats() {
    let online = 0;
    let inRoom = 0;
    let inMatch = 0;
    for (const session of this.registry.byPlayerId.values()) {
      if (!session.connected) continue;
      online++;
      const room = session.roomCode ? this.rooms.get(session.roomCode) : null;
      if (!room || room.disposed) continue;
      inRoom++;
      if (room.match) inMatch++;
    }
    return { ...this.stats(), online, inRoom, inMatch };
  }

  /** Push the online counters to every connected session (`lobby.stats`). @returns {object} the frame sent */
  broadcastOnline() {
    const frame = { t: 'lobby.stats', ...this.onlineStats() };
    for (const session of this.registry.byPlayerId.values()) {
      if (session.connected) sendSession(session, frame);
    }
    return frame;
  }

  /**
   * Unicast of the same frame: a session that just said hello should not wait up to ONLINE_PUSH_MS for its count.
   * @param {import('./net.js').Session} session
   */
  sendOnline(session) {
    if (!session) return false;
    return sendSession(session, { t: 'lobby.stats', ...this.onlineStats() });
  }

  // ---------------------------------------------------------------------------------------------------
  // net.js handler interface
  // ---------------------------------------------------------------------------------------------------

  /**
   * After `welcome`: resend room state / match state for resumed (or repeated) hellos.
   * @param {import('./net.js').Session} session
   * @param {{ resumed: boolean, repeat: boolean }} info
   */
  onHello(session, { resumed, repeat }) {
    // 在线人数 (this build): every hello gets the current counters immediately — this must run before the early
    // return below, which skips the whole room-resume path for a fresh session (and for anyone sitting in the lobby).
    this.sendOnline(session);
    if (!resumed && !repeat) return;
    const room = this.roomOf(session);
    if (!room) {
      if (session.notice) {
        sendSession(session, { t: 'room.closed', reason: session.notice });
        session.notice = null;
      }
      if (session.pendingResult) {
        for (const frame of session.pendingResult) if (frame) sendRaw(session.ws, frame);
        session.pendingResult = null;
      }
      return;
    }
    session.notice = null;
    session.pendingResult = null;
    // a player seat, or a spectator seat (header): both carry `connected` / `name`
    const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
    this.clearGrace(session.playerId);
    // Only a visible change (reconnect, rename, new host) is broadcast; a plain resync (repeated hello on a
    // live socket) answers the requester alone, so hello spam cannot amplify into room-wide traffic.
    let changed = !seat.connected;
    seat.connected = true;
    if (!room.match && seat.name !== session.name) { seat.name = session.name; changed = true; }
    // 头像 (this build): a resume / repeated hello may carry a changed avatar (hello.avatar); rebroadcast if so
    if (!room.match && (seat.avatar || null) !== (session.avatar || null)) { seat.avatar = session.avatar || null; changed = true; }
    if (!room.hostId) { this.migrateHost(room); changed = true; }
    if (changed) this.broadcastState(room);
    else this.sendState(room, session);
    this.resync(session, !resumed);
  }

  /**
   * 头像 (this build): `me.avatar { avatar }` — store the chosen operator charId (or null = default) on the session and,
   * when the player is seated, on the seat, then re-broadcast the room state so teammates see it live. The welcome and
   * the lobby-chat items carry the same value; an unknown-shaped value is stored as null (never rendered broken).
   * @param {import('./net.js').Session} session
   * @param {{ avatar?: unknown }} msg
   */
  setAvatar(session, { avatar }) {
    session.avatar = sanitizeAvatar(avatar);
    const room = this.roomOf(session);
    if (room) {
      const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
      if (seat) seat.avatar = session.avatar;
      // the room screen (seats) reads room.state; during a match the roster is fixed, so skip the broadcast there
      if (!room.match) this.broadcastState(room);
    }
    return OK;
  }

  /**
   * Validated client message from an identified session.
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  onMessage(session, msg) {
    const res = this.dispatch(session, msg);
    // 在线人数 (this build): a message that changes who is where refreshes every client's counter immediately; the
    // periodic push covers the changes that carry no message (socket drops, lobby grace timeouts).
    if (ONLINE_AFFECTING.has(msg.t)) this.broadcastOnline();
    return res;
  }

  /**
   * The room / game message table (see onMessage for the online-counter hook).
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  dispatch(session, msg) {
    switch (msg.t) {
      case 'room.create': return this.create(session, msg);
      case 'room.join': return this.join(session, msg);
      case 'room.leave': return this.leave(session);
      case 'room.ready': return this.ready(session, msg);
      case 'room.setDifficulty': return this.setDifficulty(session, msg);
      case 'room.setOptions': return this.setOptions(session, msg);
      case 'room.addBot': return this.addBot(session);
      case 'room.removeBot': return this.removeBot(session, msg);
      case 'room.kick': return this.kick(session, msg);
      case 'room.start': return this.start(session);
      case 'room.loadout': return this.loadout(session, msg);
      case 'room.ownership': return this.ownership(session, msg);
      case 'room.diy': return this.diy(session, msg);
      case 'room.skins': return this.skins(session, msg);
      case 'room.spectate': return this.spectate(session, msg);
      case 'room.removeSpectator': return this.removeSpectator(session, msg);
      // 头像 (this build): change the lobby avatar live
      case 'me.avatar': return this.setAvatar(session, msg);
      // 房间大厅 (this build's addition, formerly 多人匹配)
      case 'lobby.list': return this.list(session);
      case 'lobby.quickMatch': return this.quickMatch(session, msg);
      case 'lobby.quickMatchCancel': return this.quickMatchCancel(session);
      case 'room.setPrivate': return this.setPrivate(session, msg);
      // 问题反馈 (this build)
      case 'feedback.list': return this.feedbackList(session);
      case 'feedback.post': return this.feedbackPost(session, msg);
      case 'feedback.comment': return this.feedbackComment(session, msg);
      case 'feedback.remove': return this.feedbackRemove(session, msg);
      // 大厅排行榜 (this build)
      case 'leaderboard.list': return this.leaderboardList(session);
      case 'leaderboard.get': return this.leaderboardGet(session, msg);
      // 无尽模式排行榜 (阶段7)
      case 'endlessLeaderboard.list': return this.endlessLeaderboardList(session);
      // 大厅聊天 (this build)
      case 'lobby.chatList': return this.lobbyChatList(session);
      case 'lobby.chatSend': return this.lobbyChatSend(session, msg);
      default:
        if (typeof msg.t === 'string' && msg.t.startsWith('g.')) return this.routeGame(session, msg);
        return fail(ERR.BAD_MSG, `unhandled type ${String(msg.t).slice(0, 32)}`);
    }
  }

  /** The session's socket closed. @param {import('./net.js').Session} session */
  onDisconnect(session) {
    this.clearResync(session.playerId); // the next resume resyncs immediately
    this.leaveMatchPool(session.playerId); // 开始匹配: a 匹配中 player who drops leaves the queue
    const room = this.roomOf(session);
    // a solo run may be resumed within singleReconnectTime (24 h); everything else keeps the registry's window
    session.resumeWindowMs = room && room.match && room.mode === 'solo' ? this.soloResumeWindowMs() : null;
    // 在线人数 (this build): a drop changes the counters whether or not the session held a seat — so this must run
    // before the early return below (a lobby-only player never reaches the room branch).
    this.broadcastOnline();
    if (!room) return;
    const player = room.seatOf(session.playerId);
    const seat = player || room.spectatorOf(session.playerId);
    seat.connected = false;
    // a spectator's seat is kept like a player's (nothing to tell the match: it plays no field)
    if (room.match) { if (player) this.callMatch(room, 'onDisconnect', session.playerId); } else this.startGrace(room, seat);
    this.broadcastState(room);
  }

  /** The session's reconnect window elapsed (already removed from the registry). */
  onExpire(session) {
    session.notice = null;
    session.pendingResult = null;
    this.clearResync(session.playerId);
    this.leaveMatchPool(session.playerId); // 开始匹配: an expired 匹配中 player leaves the queue
    const code = session.roomCode;
    session.roomCode = null;
    const room = code ? this.rooms.get(code) : null;
    if (room) this.removeMember(room, session.playerId);
    this.broadcastOnline(); // 在线人数 (this build): the session expired and left the roster
  }

  /**
   * Dispose every room (notifying members with room.closed) — used on server shutdown.
   * @param {string} [reason]
   */
  shutdown(reason = 'shutdown') {
    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.resyncTimers.clear();
    if (this.onlineTimer) { clearInterval(this.onlineTimer); this.onlineTimer = null; }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
  }

  // ---------------------------------------------------------------------------------------------------
  // room.* handlers
  // ---------------------------------------------------------------------------------------------------

  create(session, { mode, difficulty, private: isPrivate = false, players, sandbox = false, endless = false }) {
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (this.rooms.size >= this.opts.maxRooms) return fail(ERR.INTERNAL, 'too many rooms');
    const key = session.limitKey || null;
    if (key && this.opts.maxRoomsPerAddr > 0) {
      // The room being left disappears with this create when the creator is its only human (a spectator is none).
      const leaving = cur && cur.ownerKey === key && cur.activeHumans().length === 1 && !cur.spectatorOf(session.playerId) ? 1 : 0;
      if (this.countRooms((r) => r.ownerKey === key) - leaving >= this.opts.maxRoomsPerAddr) {
        this.limitWarn(`room limit (${this.opts.maxRoomsPerAddr}) reached for ${session.addr}`);
        return fail(ERR.RATE, 'too many rooms from your network');
      }
    }
    const code = this.genCode();
    if (!code) return fail(ERR.INTERNAL, 'no room code available');
    if (cur) this.removeMember(cur, session.playerId);
    const room = new Room(code, mode, difficulty, this.now());
    room.ownerKey = key;
    room.sandbox = sandbox === true && mode === 'solo';   // 沙盒模式 is solo-only
    room.endless = endless === true && mode === 'coop';   // 无尽模式 is co-op, fixed 4 players (no AI), forced 终极
    if (room.endless) { room.difficulty = 'ABYSS'; room.maxPlayers = ENDLESS.PLAYERS; }
    room.isPublic = !isPrivate;
    // (开始匹配: a room the matcher opens is flipped into matchmaking by _matchmade right after create, so the host's
    //  auto-ready and the `matching` flag land in the same state.)
    // 房间人数 (the lobby's picker / the matcher's target): a valid one is the room's capacity from the start.
    // 无尽房固定 4 人 —— 不接受 players 覆盖 (否则 room.create{endless:true, players:8} 能开 8 人)
    if (!room.endless && ROOM_PLAYER_OPTIONS.includes(players)) room.maxPlayers = players;
    room.seats[0] = this.humanSeat(0, session);
    room.hostId = session.playerId;
    this.rooms.set(code, room);
    this.leaveMatchPool(session.playerId); // 开始匹配: a 匹配中 player who seated by hand leaves the queue
    session.roomCode = code;
    session.notice = null;
    session.pendingResult = null;
    this.log.info(`[lobby] ${code} created (${mode}/${difficulty}) by ${session.name}`);
    this.broadcastState(room);
    return OK;
  }

  join(session, { code }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    // idempotent for members; a spectator of this room goes on below: it may take a free player seat (header)
    if (cur === room && !room.spectatorOf(session.playerId)) { this.sendState(room, session); return OK; }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    const idx = room.freeSeat();
    if (idx < 0 || idx >= room.maxPlayers) return fail(ERR.ROOM_FULL);
    if (cur) this.removeMember(cur, session.playerId);
    room.seats[idx] = this.humanSeat(idx, session);
    this.leaveMatchPool(session.playerId); // 开始匹配: a 匹配中 player who sat by hand leaves the queue
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    if (!room.hostId) room.hostId = session.playerId;
    this.broadcastState(room);
    return OK;
  }

  /**
   * 房间大厅 (this build's addition, formerly 多人匹配): answer `lobby.list` with every open co-op room plus the server totals.
   * Only rooms whose host left them public appear — a hidden room stays reachable by its 同盟密钥 alone, and a
   * solo room is never joinable so it never shows. Rooms still in the lobby (not started) come first — joinable at a
   * glance — then the already-running matches sorted by round, highest (nearest to finished) first.
   * @param {import('./net.js').Session} session
   */
  list(session) {
    const rooms = [];
    for (const room of this.rooms.values()) {
      if (room.disposed || !room.isPublic || room.mode !== 'coop') continue;
      rooms.push(room.toSummary());
    }
    rooms.sort((a, b) => ((a.inMatch ? 1 : 0) - (b.inMatch ? 1 : 0))
      || (b.round - a.round)
      || (b.players - a.players)
      || a.code.localeCompare(b.code));
    sendSession(session, { t: 'lobby.rooms', rooms, stats: this.stats() });
    return OK;
  }

  /**
   * 问题反馈 (this build): answer `feedback.list` with the whole board (newest message first). The asker only, like
   * lobby.list — the panel polls this while open and re-asks right after it posts.
   * @param {import('./net.js').Session} session
   */
  feedbackList(session) {
    sendSession(session, { t: 'feedback.items', items: this.feedback.list() });
    return OK;
  }

  /** 问题反馈: post a message (author = the session's name). Per-session cooldown (feedbackCooldown). */
  feedbackPost(session, { text }) {
    const wait = this.feedbackCooldown(session);
    if (wait > 0) return fail(ERR.RATE, `feedback cooldown (${Math.ceil(wait / 1000)}s)`);
    const item = this.feedback.post({ playerId: session.playerId, name: session.name, text });
    if (!item) return fail(ERR.BAD_MSG, 'empty feedback message');
    this.log.info(`[feedback] ${session.name} posted #${item.id}`);
    sendSession(session, { t: 'feedback.items', items: this.feedback.list() });
    return OK;
  }

  /** 问题反馈: comment on a message (`id` comes from `feedback.list`). Per-session cooldown. */
  feedbackComment(session, { id, text }) {
    const wait = this.feedbackCooldown(session);
    if (wait > 0) return fail(ERR.RATE, `feedback cooldown (${Math.ceil(wait / 1000)}s)`);
    const item = this.feedback.comment({ id, playerId: session.playerId, name: session.name, text });
    if (!item) return fail(ERR.BAD_MSG, 'unknown message or empty comment');
    this.log.info(`[feedback] ${session.name} commented on #${id}`);
    sendSession(session, { t: 'feedback.items', items: this.feedback.list() });
    return OK;
  }

  /**
   * 大厅排行榜 (this build): answer `leaderboard.list` with every record — one per 隐藏首领, the fastest ABYSS clear
   * (owner / MVP / clear time; the detail rows ride along so the client needs no second round trip). The list is
   * trimmed for the panel: the full settlement rows come from `leaderboard.get`.
   * @param {import('./net.js').Session} session
   */
  leaderboardList(session) {
    const items = this.leaderboard.list().map((e) => ({
      bossId: e.bossId, bossName: e.bossName, difficulty: e.difficulty, durationMs: e.durationMs, at: e.at,
      teamSize: e.teamSize, owner: e.owner, mvp: e.mvp,
    }));
    sendSession(session, { t: 'leaderboard.items', items });
    return OK;
  }

  /**
   * 无尽模式排行榜 (阶段7): answer `endlessLeaderboard.list` with both boards (通过回合数 / 打桩累计伤害), each already
   * sorted (best first). The rows carry the team + its summed numbers; the client's detail view shows the settlement rows.
   * @param {import('./net.js').Session} session
   */
  endlessLeaderboardList(session) {
    const b = this.endlessBoard.list();
    sendSession(session, { t: 'endlessLeaderboard.items', rounds: b.rounds, damage: b.damage });
    return OK;
  }

  /** 大厅排行榜: the full record of one 隐藏首领 (its settlement rows), or null when it has no record yet. */
  leaderboardGet(session, { bossId }) {
    sendSession(session, { t: 'leaderboard.entry', entry: this.leaderboard.get(bossId) });
    return OK;
  }

  /** 问题反馈: delete one of the caller's OWN messages (`commentId` absent) or own comment. */
  feedbackRemove(session, { id, commentId }) {
    const ok = commentId == null
      ? this.feedback.removeItem(id, session.playerId)
      : this.feedback.removeComment(id, commentId, session.playerId);
    if (!ok) return fail(ERR.BAD_MSG, 'not your message or comment');
    sendSession(session, { t: 'feedback.items', items: this.feedback.list() });
    return OK;
  }

  /**
   * 问题反馈: the per-session cooldown (ms still to wait; 0 = allowed now, and stamps the session).
   * @param {import('./net.js').Session} session
   */
  feedbackCooldown(session) {
    const cd = Number(this.opts.feedbackCooldownMs) || 0;
    if (cd <= 0) return 0;
    const last = Number(session.feedbackAt) || 0;
    const at = this.now();
    const wait = last + cd - at;
    if (wait > 0) return wait;
    session.feedbackAt = at;
    return 0;
  }

  /** 大厅聊天: answer `lobby.chatList` with the whole ring (oldest first). @param {import('./net.js').Session} session */
  lobbyChatList(session) {
    sendSession(session, { t: 'lobby.chat', messages: this.chat.list() });
    return OK;
  }

  /**
   * 大厅聊天: post one message. `kind` picks the shape — 'text' (cleaned + capped), 'emote' (a known id, validated in
   * LobbyChat.push), or 'party' (a 组队公告 whose room code the server derives from the sender's own joinable co-op
   * room — never taken from the client, so nobody can advertise a foreign code).
   * @param {import('./net.js').Session} session
   * @param {{ kind: string, text?: string, emote?: string }} msg
   */
  lobbyChatSend(session, { kind, text, emote }) {
    const room = this.roomOf(session);
    let code = null;
    if (kind === 'party') {
      if (!room || room.mode !== 'coop' || room.match) return fail(ERR.BAD_MSG, 'not in a joinable co-op room');
      const idx = room.freeSeat();
      if (idx < 0 || idx >= room.maxPlayers) return fail(ERR.BAD_MSG, 'room has no free seat');
      code = room.code;
    }
    const wait = kind === 'party' ? this.partyCooldown(session) : this.chatCooldown(session);
    if (wait > 0) return fail(ERR.RATE, `chat cooldown (${Math.ceil(wait / 1000)}s)`);
    if (!this.chatBudgetOk()) return fail(ERR.RATE, 'chat is busy, slow down');
    // the sender's activity at send time (the client cannot know another player's room membership)
    const status = room && !room.disposed ? 'room' : 'lobby';
    const item = this.chat.push({ playerId: session.playerId, name: session.name, avatar: session.avatar || null, status, kind, text, emote, code });
    if (!item) return fail(ERR.BAD_MSG, 'empty or invalid chat message');
    this.broadcastChat(item);
    return OK;
  }

  /**
   * 大厅聊天: push one message to every connected session. Encoded once (the frame is identical for all), then sent raw.
   * @param {import('./lobbyChat.js').LobbyChatItem} item
   */
  broadcastChat(item) {
    const data = encode({ t: 'lobby.chatMsg', ...item });
    if (data == null) return;
    for (const session of this.registry.byPlayerId.values()) {
      if (session.connected) sendRaw(session.ws, data);
    }
  }

  /** 大厅聊天: the per-session cooldown between ordinary messages (ms still to wait; 0 = allowed now, and stamps it). */
  chatCooldown(session) { return this._chatCooldown(session, 'chatAt', this.opts.lobbyChatCooldownMs); }

  /** 大厅聊天: the per-session cooldown between 组队公告 (a loud broadcast — hammer it harder than a message). */
  partyCooldown(session) { return this._chatCooldown(session, 'partyAt', this.opts.lobbyPartyCooldownMs); }

  /**
   * @param {import('./net.js').Session} session @param {string} field @param {unknown} ms
   * @returns {number} ms still to wait (0 = allowed, and the session is stamped)
   */
  _chatCooldown(session, field, ms) {
    const cd = Number(ms) || 0;
    if (cd <= 0) return 0;
    const key = `lobbyChat_${field}`;
    const last = Number(session[key]) || 0;
    const at = this.now();
    const wait = last + cd - at;
    if (wait > 0) return wait;
    session[key] = at;
    return 0;
  }

  /** 大厅聊天: the global per-second broadcast ceiling (true = under it, and counts this one). */
  chatBudgetOk() {
    const cap = Number(this.opts.lobbyChatBroadcastsPerSec) || 0;
    if (cap <= 0) return true;
    const at = this.now();
    if (at - this.chatWindow.at >= 1000) { this.chatWindow.at = at; this.chatWindow.count = 0; }
    if (this.chatWindow.count >= cap) return false;
    this.chatWindow.count++;
    return true;
  }

  /**
   * 房间大厅 (多人匹配) 的匹配入口.
   *
   * 快速匹配 (the browse panel, without `size`): drop the caller into the fullest joinable public room, or open a fresh
   * one when the server has nothing to join — the browse panel's 快速匹配 must never dead-end on a quiet server. Seat,
   * running-match and per-network limits are the ones join() / create() already enforce; no auto-start.
   *
   * 开始匹配 (the lobby button, `size` given): the caller wants to PLAY NOW at a chosen 模拟难度 + 房间人数. It never
   * joins somebody else's hand-made room (创建同盟) and never opens one on a miss — instead the caller enters the
   * server-side 匹配池 and waits there. When enough humans of the same difficulty and 房间人数 have queued up a
   * brand-new hidden room is opened for exactly them and starts by itself (_matchFromPool / _launchMatchedRoom /
   * _matchmade / _autoStartIfFull). The lobby screen polls this while 匹配中; a repeat ask is idempotent (the caller
   * is taken out of the pool first, so one human never counts twice) and only a 取消匹配 (lobby.quickMatchCancel) or a
   * disconnect puts the caller back in the lobby for good.
   * @param {import('./net.js').Session} session
   * @param {{ difficulty?: string, size?: number }} [msg]
   */
  quickMatch(session, { difficulty, size } = {}) {
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    const target = ROOM_PLAYER_OPTIONS.includes(size) ? size : null;
    const wantDiff = DIFFICULTIES.includes(difficulty) ? difficulty : null;
    // 开始匹配 (size given): the 匹配池 only — never a hand-made 公开 room.
    if (target != null) {
      const diff = wantDiff || 'FUNNY';
      return this._matchFromPool(session, diff, target);
    }
    // 快速匹配 (browse panel): the old behaviour — fullest open co-op room, a fresh public one when none
    let best = null;
    let bestPlayers = -1;
    for (const room of this.rooms.values()) {
      if (room.disposed || !room.isPublic || room.mode !== 'coop' || room.match) continue;
      const free = room.freeSeat();
      if (free < 0 || free >= room.maxPlayers) continue;
      const players = room.activeHumans().length;
      if (players > bestPlayers) { best = room; bestPlayers = players; }
    }
    if (best) return this.join(session, { code: best.code });
    const picked = DIFFICULTIES.includes(difficulty) ? difficulty : 'FUNNY';
    return this.create(session, { mode: 'coop', difficulty: picked, private: false });
  }

  /**
   * 开始匹配 (this build): a caller asked to play at `difficulty`/`size`. It is taken out of the pool first (the
   * client polls while 匹配中, so one human must never queue twice), then — when enough humans of the same difficulty
   * + 房间人数 are already waiting — a fresh room is opened for exactly those `size` humans and starts by itself;
   * otherwise the caller is queued here and the lobby keeps showing 匹配中. Stale entries (dropped sessions, or a
   * player who sat down by hand meanwhile) are dropped when the group forms.
   * @param {import('./net.js').Session} session
   */
  _matchFromPool(session, difficulty, size) {
    this.leaveMatchPool(session.playerId);
    const mates = this.matchPool.filter((e) => e.difficulty === difficulty && e.size === size);
    const live = mates.filter((e) => this._isMatchable(this.registry.byId(e.playerId)));
    if (live.length !== mates.length) {
      const stale = new Set(mates.filter((e) => !live.includes(e)).map((e) => e.playerId));
      this.matchPool = this.matchPool.filter((e) => !stale.has(e.playerId));
    }
    const members = [...live, { playerId: session.playerId, name: session.name, difficulty, size }];
    if (members.length >= size) {
      for (const m of members) this.leaveMatchPool(m.playerId);
      this._launchMatchedRoom(members, difficulty, size); // success → everyone seated; any failure → everyone re-queued
      return OK;
    }
    this.matchPool.push({ playerId: session.playerId, name: session.name, difficulty, size });
    return OK;
  }

  /** 开始匹配: an entry still counts when its session is online, seated nowhere and not running a match. */
  _isMatchable(session) {
    return !!session && session.connected && !this.roomOf(session);
  }

  /**
   * 开始匹配: `members` (already exhausted of the limits join/create enforce) now open a brand-new room for exactly
   * them, mark it as matching (_matchmade), and let _autoStartIfFull fire the moment it holds its 房间人数 — every
   * member arrives auto-readied, so a full group starts at once. The first member whose create succeeds hosts; when
   * the room cannot be completed (a member dropped between pooling and seating) the half-made room is disposed and the
   * whole group goes back to the pool, so the next poll retries. A matched room is created hidden (private) — it is
   * self-managed and never shows up as a hand-made 公开 room to join.
   * @param {{ playerId: string, name: string, difficulty: string, size: number }[]} members
   * @param {string} difficulty @param {number} size
   */
  _launchMatchedRoom(members, difficulty, size) {
    const candidates = [...members];
    while (candidates.length) {
      const hostEntry = candidates.shift();
      const host = this.registry.byId(hostEntry.playerId);
      if (!this._isMatchable(host)) { this.matchPool.push(hostEntry); continue; }
      const res = this.create(host, { mode: 'coop', difficulty, players: size, private: true });
      if (res && res.error) { this.matchPool.push(hostEntry); continue; }
      const room = this.rooms.get(host.roomCode);
      if (!room) { this.matchPool.push(hostEntry); continue; }
      const rest = members.filter((m) => m !== hostEntry);
      let failed = null;
      for (const m of rest) {
        const s = this.registry.byId(m.playerId);
        if (!this._isMatchable(s)) { failed = m; break; }
        const r = this.join(s, { code: host.roomCode });
        if (r && r.error) { failed = m; break; }
      }
      if (failed) {
        // roll back: drop the half-made room, everyone queues again (delete the double push of host below)
        this.disposeRoom(room, 'matchmaking failed');
        for (const m of members) this.leaveMatchPool(m.playerId);
        this.matchPool.push(...members);
        continue;
      }
      // all seated and auto-readied → the full 房间人数 starts by itself
      for (const m of members) {
        const s = this.registry.byId(m.playerId);
        if (s && room.seatOf(s.playerId)) this._matchmade(room, s);
      }
      return OK;
    }
    // nobody could host — the whole group stays queued (the caller's next poll retries)
    return OK;
  }

  /** 开始匹配: take a player out of the 匹配池 (cancel, disconnect, expiry, or a hand-seat). */
  leaveMatchPool(playerId) {
    const i = this.matchPool.findIndex((e) => e.playerId === playerId);
    if (i >= 0) this.matchPool.splice(i, 1);
  }

  /** 开始匹配: the lobby's 取消匹配 — the caller leaves the 匹配池 (nothing else to undo). */
  quickMatchCancel(session) {
    this.leaveMatchPool(session.playerId);
    return OK;
  }

  /**
   * 开始匹配 (this build): a member of a matching room is seated — auto-readied (they asked to play now), and the room
   * starts by itself once it holds its 房间人数 (_autoStartIfFull); the host may still start early with room.start. The
   * room keeps whatever visibility it was created with (a self-matched room stays hidden — it is not a hand-made 公开
   * room to join).
   * @param {Room} room @param {import('./net.js').Session} session
   */
  _matchmade(room, session) {
    if (!room || room.disposed) return;
    room.matching = true;
    const seat = room.seatOf(session.playerId);
    if (seat && !seat.isBot) seat.ready = true;
    this.broadcastState(room);
    this._autoStartIfFull(room);
  }

  /** 开始匹配: a matching room starts by itself once it holds its full 房间人数 (every connected seat ready — see start). */
  _autoStartIfFull(room) {
    if (!room || room.disposed || !room.matching || room.match) return;
    const humans = room.activeHumans();
    if (humans.length < 1 || humans.length < room.maxPlayers) return;
    for (const s of humans) if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return;
    const host = room.seatOf(room.hostId);
    const hostSession = host ? this.registry.byId(host.playerId) : null;
    const key = (hostSession && hostSession.limitKey) || null;
    // the same per-network cap start() enforces — a reached cap lets the room wait for the host to start it by hand
    if (key && this.opts.maxMatchesPerAddr > 0 && this.countRooms((r) => !!r.match && r.matchKey === key) >= this.opts.maxMatchesPerAddr) {
      this.limitWarn(`match limit (${this.opts.maxMatchesPerAddr}) reached for ${hostSession.addr}`);
      return;
    }
    this.log.info(`[lobby] ${room.code} matched full (${humans.length}/${room.maxPlayers}) — starting the match`);
    this.startMatch(room, key);
  }

  /**
   * 房间大厅 (formerly 多人匹配): the host lists or hides their lobby-phase room in the browse list (room.setPrivate). A hidden room
   * is still joinable with its 同盟密钥 — this only affects discovery.
   * @param {import('./net.js').Session} session
   * @param {{ private: boolean }} msg
   */
  setPrivate(session, { private: isPrivate }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    room.isPublic = !isPrivate;
    this.broadcastState(room);
    return OK;
  }

  leave(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    this.removeMember(room, session.playerId);
    return OK;
  }

  /**
   * room.spectate: one of a co-op room's MAX_SPECTATORS spectator seats, in its lobby or during its match (header). In a
   * running match the match registers the spectator and resends what it may see (Match.addSpectator).
   */
  spectate(session, { code }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    if (cur === room) {
      if (!room.spectatorOf(session.playerId)) return fail(ERR.ALREADY, 'seated as a player');
      this.sendState(room, session);
      return OK;
    }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    if (room.spectators.length >= MAX_SPECTATORS) return fail(ERR.ROOM_FULL, 'no free spectator seat');
    if (cur) this.removeMember(cur, session.playerId);
    room.spectators.push({ playerId: session.playerId, name: session.name, avatar: session.avatar || null, connected: session.connected });
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    this.broadcastState(room);
    if (room.match) this.callMatch(room, 'addSpectator', session.playerId);
    return OK;
  }

  /** room.removeSpectator (host, any time): the spectator gets room.closed {kicked} and its seat is freed. */
  removeSpectator(session, { playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (!room.spectatorOf(playerId)) return fail(ERR.BAD_TARGET, 'not a spectator of this room');
    const target = this.registry.byId(playerId);
    const wasHere = !!target && target.roomCode === room.code;
    const replay = this.replayFor(room, playerId);
    this.removeMember(room, playerId);
    if (wasHere) {
      // like room.kick: now, or on the next resume (with the result replay, as after the grace timeout)
      if (target.connected) sendSession(target, { t: 'room.closed', reason: 'kicked' });
      else { target.notice = 'kicked'; target.pendingResult = replay; }
    }
    return OK;
  }

  ready(session, { ready }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const seat = room.seatOf(session.playerId);
    if (seat.ready !== ready) {
      seat.ready = ready;
      this.broadcastState(room);
    }
    // 开始匹配: a room that was opened/joined through matchmaking starts by itself once it is full and everyone is ready
    if (ready) this._autoStartIfFull(room);
    return OK;
  }

  setDifficulty(session, { difficulty }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.endless) return fail(ERR.WRONG_PHASE, 'endless is 终极');   // 无尽难度锁定 (否则可改低难度刷榜)
    this.dropReplay(room, session.playerId);
    if (room.difficulty !== difficulty) {
      room.difficulty = difficulty;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  /**
   * 玩法扩展 (this build, host-only): set the room's own player capacity (room.maxPlayers) and/or which optional rules
   * are on (room.extensions — the 玩法扩展 panel). Refused once the match runs; the capacity may not drop below the
   * seats already taken, and seats outside the new capacity are cleared. Only the fields sent are changed.
   */
  setOptions(session, { maxPlayers, extensions }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    // 无尽模式: fixed 4 players, fixed rules — the host cannot change 房间人数 / 玩法扩展
    if (room.endless) return fail(ERR.BAD_MSG, '无尽模式: room options are fixed');
    let changed = false;
    if (Number.isInteger(maxPlayers)) {
      if (!ROOM_PLAYER_OPTIONS.includes(maxPlayers)) return fail(ERR.BAD_TARGET, 'unsupported room size');
      const occupied = room.seats.reduce((n, s, i) => (s ? i + 1 : n), 0);
      if (maxPlayers < occupied) return fail(ERR.BAD_TARGET, 'capacity below the seated players');
      if (room.maxPlayers !== maxPlayers) {
        room.maxPlayers = maxPlayers;
        for (let i = maxPlayers; i < room.seats.length; i++) room.seats[i] = null;
        for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
        changed = true;
      }
    }
    if (extensions && typeof extensions === 'object') {
      for (const k of ROOM_EXTENSIONS) {
        if (!Object.hasOwn(extensions, k)) continue;
        const on = !!extensions[k];
        if (room.extensions[k] !== on) { room.extensions[k] = on; changed = true; }
      }
    }
    if (changed) {
      this.dropReplay(room, session.playerId);
      this.broadcastState(room);
    }
    return OK;
  }

  addBot(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo rooms cannot have AI teammates');
    // 无尽模式: AI teammates are disabled (the author 2026-10-11) — the 4 seats are human-only
    if (room.endless) return fail(ERR.ROOM_FULL, 'endless rooms are human-only');
    // 每局 AI 上限 (this build): a room holds at most MAX_AI_SEATS (3) AI teammates, whatever the seat cap — a
    // server-load rule (the AI seats are simulated server-side). Human seats, autoplay takeover included, are unaffected.
    if (room.seats.filter((s) => s && s.isBot).length >= MAX_AI_SEATS) return fail(ERR.AI_LIMIT);
    const idx = room.freeSeat();
    if (idx < 0 || idx >= room.maxPlayers) return fail(ERR.ROOM_FULL);
    const used = new Set(room.seats.filter((s) => s && s.isBot).map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `AI·${idx + 1}`;
    let playerId;
    do playerId = 'ai_' + randomBytes(4).toString('hex'); while (room.seatOf(playerId));
    room.seats[idx] = { seat: idx, playerId, name, isBot: true, ready: true, connected: true, left: false };
    this.broadcastState(room);
    return OK;
  }

  removeBot(session, { seat }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || !target.isBot) return fail(ERR.BAD_TARGET, 'seat does not hold an AI');
    room.seats[seat] = null;
    this.broadcastState(room);
    return OK;
  }

  /** Host removes another human before the match (header: room.kick). */
  kick(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || target.left) return fail(ERR.BAD_TARGET, 'seat holds no player');
    if (target.playerId !== playerId) return fail(ERR.BAD_TARGET, 'seat changed hands'); // the confirmed player left meanwhile
    if (target.isBot) return fail(ERR.BAD_TARGET, 'seat holds an AI (room.removeBot)');
    if (target.playerId === session.playerId) return fail(ERR.BAD_TARGET, 'cannot kick yourself');
    const kicked = this.registry.byId(target.playerId);
    const wasHere = !!kicked && kicked.roomCode === room.code;
    const replay = this.replayFor(room, target.playerId);
    this.removeMember(room, target.playerId);
    if (wasHere) {
      if (kicked.connected) sendSession(kicked, { t: 'room.closed', reason: 'kicked' });
      else { kicked.notice = 'kicked'; kicked.pendingResult = replay; }
    }
    this.log.info(`[lobby] ${room.code} ${target.name} removed by the host`);
    return OK;
  }

  start(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const humans = room.activeHumans();
    for (const s of humans) {
      if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return fail(ERR.NOT_READY);
    }
    const bots = room.seats.filter((s) => s && s.isBot);
    if (humans.length < 1 || (room.mode === 'solo' && (humans.length !== 1 || bots.length > 0))) {
      return fail(ERR.BAD_MSG, 'invalid seat configuration');
    }
    const key = session.limitKey || null;
    if (key && this.opts.maxMatchesPerAddr > 0 && this.countRooms((r) => !!r.match && r.matchKey === key) >= this.opts.maxMatchesPerAddr) {
      this.limitWarn(`match limit (${this.opts.maxMatchesPerAddr}) reached for ${session.addr}`);
      return fail(ERR.RATE, 'too many running matches from your network');
    }
    return this.startMatch(room, key);
  }

  /**
   * room.loadout (DESIGN §16): check the operator loadout against the game data, store it on the session and the seat,
   * and — while a match runs — hand it to the match (accepted only during INFO_CHECK, see the header).
   */
  loadout(session, { entries }) {
    const data = this.safeData();
    const res = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const loadout = freezeLoadout(res.loadout);
    session.loadout = loadout;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.loadout = loadout;
    if (!room.match || !seat) return OK; // a spectator's loadout stays on its session, never reaching the match
    if (typeof room.match.setLoadout !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setLoadout(session.playerId, loadout);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setLoadout threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  /**
   * room.skins (docs/SKINS.md): store the player's chosen operator skins on the session and the seat,
   * and hand them to a running match (skins are display-only and public, so any phase accepts them).
   */
  skins(session, { skins }) {
    const data = this.safeData();
    const cleaned = freezeSkins(skins, (id) => lookup('chess', id, data));
    session.skins = cleaned;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.skins = cleaned;
    if (!room.match || !seat) return OK; // a spectator's skins stay on its session, never reaching the match
    if (typeof room.match.setSkins !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setSkins(session.playerId, cleaned);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setSkins threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  /**
   * room.ownership (0.2.0 补位): keep the droppable chess of the not-owned list, store it on the session and the seat
   * (see the header). A running match never takes it: it keeps the list its seat had at its start.
   */
  ownership(session, { notOwned }) {
    const data = this.safeData();
    const res = checkNotOwned(notOwned, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(ERR.BAD_MSG, res && res.detail);
    const list = Object.freeze(res.notOwned.slice());
    session.notOwned = list;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.notOwned = list;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /**
   * room.diy (0.2.0 自选编队): keep the legal picks (checkDiyPicks against the data and KITTED_CHARS), store them on the
   * session and the seat (see the header). A running match never takes them: it keeps the picks its seat had at its
   * start.
   */
  diy(session, { picks }) {
    const res = checkDiyPicks(picks, { data: this.safeData(), kitted: KITTED_CHARS });
    if (!res || !('ok' in res)) return fail(ERR.BAD_MSG, res && res.detail);
    const kept = freezeDiy(res.picks);
    session.diy = kept;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.diy = kept;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /** Extra fields of every `welcome` (net.js): the operators a 自选 slot may field (shared/diy.js `kitted`). */
  welcomeInfo() {
    // 每日重启: `restartAt` is the on/off signal for the lobby's notice; `restartNextAt` is the next restart as an epoch
    // (server clock) so the client can show it in the VIEWER's own timezone (2026-10-14: a UTC host restarting at 00:00
    // = 北京 08:00 must read as the player's local time, not a fixed 3:25).
    const now = Date.now();
    const restartNextAt = this.restartAt ? now + msUntilTime(this.restartAt.hour, this.restartAt.minute, now) : null;
    // ⚠️ 临时：发版用一次性重启的时刻（epoch，服务端钟），供「临时更新弹窗」精确对齐 —— 与 restart.js 的
    // nextTempRestartAt 同源。重启更新完成后，连同该临时块一起删除本行（客户端删 public/js/ui/tempNotice.js）。
    const tempRestartAt = nextTempRestartAt(now);
    return { diyKitted: KITTED_CHARS, restartAt: this.restartAt, restartNextAt, tempRestartAt };
  }

  // ---------------------------------------------------------------------------------------------------
  // Match wiring
  // ---------------------------------------------------------------------------------------------------

  /** @param {Room} room @param {string | null} [key] per-network limit key of the starter */
  startMatch(room, key = null) {
    room.matching = false; // 开始匹配: the room is playing now — a later return to LOBBY does not auto-fill again
    const host = room.seatOf(room.hostId);
    if (host) host.ready = true;
    const seats = room.seats.filter(Boolean).map((s) => ({
      seat: s.seat, playerId: s.playerId, name: s.name, ...(s.avatar ? { avatar: s.avatar } : {}), isBot: s.isBot, connected: s.connected,
      // DESIGN §16: the human's checked operator loadout (bots fight with the defaults)
      loadout: s.isBot ? null : s.loadout || null,
      // 0.2.0 补位: the chess the human marked as not owned (bots own every operator)
      notOwned: s.isBot ? null : s.notOwned || null,
      // 0.2.0 自选编队: the human's checked DIY picks (bots field no 自选 piece [ASSUMED])
      diy: s.isBot ? null : s.diy || null,
      // 干员皮肤 (docs/SKINS.md): the human's chosen skins (bots wear the defaults)
      skins: s.isBot ? null : s.skins || null,
    }));
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null, results: new Map() };
    let seed = 0;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    try {
      const match = new this.MatchClass({
        roomCode: room.code,
        mode: room.mode,
        difficulty: room.difficulty,
        modeId: modeIdFor(room.mode, room.difficulty),
        seats,
        // 玩法扩展 (host-set, room.setOptions): the optional rules the match honours (currently the teammate revive)
        extensions: { ...room.extensions },
        // 沙盒模式 (this build): a solo 娱乐 match = one configurable battle, driven by the in-match 控制台
        sandbox: room.sandbox === true,
        // 无尽模式 (this build): fixed 4-player, boss rounds off, shared LP fixed 1, 打桩环节 (match/endless.js)
        endless: room.endless === true,
        // the spectator seats (header): watched like eliminated players, never players
        spectators: room.spectators.map((s) => s.playerId),
        seed,
        // the room's match number: with the seed it keeps battleIds unique across the room's matches (DESIGN §14)
        matchNo: room.matchCount + 1,
        data: this.safeData(),
        log: this.log,
        now: this.now,
        // multi-core: server-run normal / 联防 fields simulate on the worker pool (null = in-process)
        simPool: this.simPool,
        send: (playerId, msg) => (ctx.live ? this.matchSend(room, ctx, playerId, msg) : false),
        broadcast: (msg) => { if (ctx.live) this.matchBroadcast(room, ctx, msg); },
        onEnd: (summary) => this.onMatchEnd(room, ctx, summary),
      });
      ctx.match = match;
      room.match = match;
      room.matchCtx = ctx;
      room.matchKey = key;
      room.replay = null;
      room.matchCount++;
      this.log.info(`[lobby] ${room.code} match #${room.matchCount} starting (${room.mode}/${room.difficulty}, ${seats.length} seats, seed ${seed})`);
      this.broadcastState(room);
      match.start();
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match failed to start`, e);
      if (room.matchCtx === ctx) { room.match = null; room.matchCtx = null; room.matchKey = null; }
      this.disposeMatchCtx(ctx);
      this.broadcastState(room);
      return fail(ERR.INTERNAL, 'match failed to start');
    }
    return OK;
  }

  /** onEnd callback: return the room to LOBBY and dispose the match on the next macrotask. */
  onMatchEnd(room, ctx, summary) {
    if (ctx.ended || !ctx.live || room.matchCtx !== ctx || room.disposed) return;
    ctx.ended = true;
    room.lastSummary = summary ?? null;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = this.buildReplay(room, ctx);
    setImmediate(() => this.disposeMatchCtx(ctx));
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ended`);
    // 玩法扩展 (author 2026-10-13): 只要房间的「玩法扩展」用了**非默认**设置 (开启 sharedLp/dupBand/deployCapOff, 或关掉
    // 默认的 revive/bossPanel), 这局就是「非正规」→ **不写入任何排行榜** (成绩不可比)。
    const ranked = extensionsAreDefault(room.extensions);
    // 大厅排行榜 (this build): a 隐藏核心 CLEAR offers its run to the board — only the TOP difficulty counts and only
    // the FASTEST run per 隐藏首领 is kept (server/leaderboard.js). The record keeps the room owner's name, the run's
    // MVP and the settlement rows (the client's detail view). Best-effort: never breaks the match teardown.
    try {
      const s = summary;
      if (ranked && s && s.victory && s.hiddenCleared && s.hiddenBossId) {
        const bossName = this.safeData()?.bosses?.[s.hiddenBossId]?.name ?? s.hiddenBossId;
        const owner = (room.hostId && room.seatOf(room.hostId)?.name) || '';
        const entry = this.leaderboard.record({ ...s, bossId: s.hiddenBossId, bossName, owner, teamSize: room.seats.filter(Boolean).length });
        if (entry) this.log.info(`[leaderboard] ${bossName} new best ${Math.round(entry.durationMs / 1000)}s (owner ${entry.owner || '?'})`);
      }
    } catch (e) {
      this.log.warn?.('[leaderboard] could not record the run', e);
    }
    // 无尽模式排行榜 (阶段7): a 打桩-ended 无尽局 offers its 通过回合数 and 打桩累计伤害 to the two boards (top teams each).
    try {
      const s = summary;
      if (ranked && s && s.reason === 'endless') {
        const owner = (room.hostId && room.seatOf(room.hostId)?.name) || '';
        const rec = this.endlessBoard.record({ ...s, owner });
        if (rec.rounds || rec.damage) this.log.info(`[endlessBoard] ${owner || '?'}: 回合 ${s.roundsPassed} · 打桩 ${Math.round(Number(s.dummyDmg) || 0)}`);
      }
    } catch (e) {
      this.log.warn?.('[endlessBoard] could not record the run', e);
    }
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.isBot) continue;
      if (s.left) { room.seats[i] = null; continue; }
      s.ready = false;
      if (!s.connected) this.startGrace(room, s);
    }
    for (const s of room.spectators) if (!s.connected) this.startGrace(room, s);
    const host = room.hostId ? room.seatOf(room.hostId) : null;
    if (!host || host.isBot || host.left) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /** Match unicast; m.result frames are also kept for the replay. */
  matchSend(room, ctx, playerId, msg) {
    if (msg && msg.t === 'm.result') {
      const data = encode(msg);
      if (data != null) ctx.results.set(playerId, data);
    }
    return this.sendToPlayer(room, playerId, msg);
  }

  /** Match broadcast; the latest m.public and a broadcast m.result are also kept for the replay. */
  matchBroadcast(room, ctx, msg) {
    const data = this.broadcastRoom(room, msg);
    if (data == null) return;
    if (msg.t === 'm.public') ctx.lastPublic = data;
    else if (msg.t === 'm.result') ctx.sharedResult = data;
  }

  /**
   * Replay record for the humans still seated when a match ends (null when the match produced no m.result,
   * e.g. it was abandoned: those clients then see "simulation closed").
   * @param {Room} room @returns {Room['replay']}
   */
  buildReplay(room, ctx) {
    const frames = new Map();
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const frame = ctx.results.get(s.playerId) || ctx.sharedResult;
      if (frame) frames.set(s.playerId, frame);
    }
    if (frames.size === 0) return null;
    return { publicFrame: ctx.lastPublic, frames, pending: new Set(frames.keys()) };
  }

  /** The replay frames still owed to a player (null when they moved on). @returns {string[] | null} */
  replayFor(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.has(playerId)) return null;
    return [r.publicFrame, r.frames.get(playerId)].filter(Boolean);
  }

  /** The player moved on from the result screen (acted in the room, left): stop replaying it. */
  dropReplay(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.delete(playerId)) return;
    r.frames.delete(playerId);
    if (r.pending.size === 0) room.replay = null;
  }

  /**
   * The heavy part of a resync — full match state (match.onReconnect) or, back in LOBBY, the result replay.
   * Immediate after a (re)connect; for repeated hellos on a live socket at most once per resyncMinGapMs
   * (requests inside the window coalesce into one deferred resync).
   * @param {import('./net.js').Session} session @param {boolean} coalesce
   */
  resync(session, coalesce) {
    const pid = session.playerId;
    if (coalesce) {
      if (this.resyncTimers.has(pid)) return; // the scheduled resync answers this request too
      const wait = (Number.isFinite(session.resyncAt) ? session.resyncAt : -Infinity) + this.opts.resyncMinGapMs - this.now();
      if (wait > 0) {
        const t = setTimeout(() => { this.resyncTimers.delete(pid); this.runResync(session); }, wait);
        t.unref?.();
        this.resyncTimers.set(pid, t);
        return;
      }
    } else {
      this.clearResync(pid);
    }
    this.runResync(session);
  }

  /** @param {import('./net.js').Session} session */
  runResync(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    const room = this.roomOf(session);
    if (!room) return;
    session.resyncAt = this.now();
    if (room.match) {
      this.callMatch(room, room.spectatorOf(session.playerId) ? 'addSpectator' : 'onReconnect', session.playerId);
      return;
    }
    const frames = this.replayFor(room, session.playerId);
    if (frames) for (const frame of frames) sendRaw(session.ws, frame);
  }

  clearResync(playerId) {
    const t = this.resyncTimers.get(playerId);
    if (t) { clearTimeout(t); this.resyncTimers.delete(playerId); }
  }

  /** Log a per-network limit refusal without letting a refusal loop flood the log. */
  limitWarn(text) {
    const now = this.now();
    if (now - this.limitLog.at < 10_000) { this.limitLog.suppressed++; return; }
    const more = this.limitLog.suppressed ? ` (+${this.limitLog.suppressed} similar refusals)` : '';
    this.limitLog.at = now;
    this.limitLog.suppressed = 0;
    this.log.warn(`[lobby] ${text}${more}`);
  }

  /** Number of rooms matching a predicate. */
  countRooms(pred) {
    let n = 0;
    for (const r of this.rooms.values()) if (pred(r)) n++;
    return n;
  }

  /** Route a 'g.*' intent to the running match. */
  routeGame(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!room.match) return fail(ERR.WRONG_PHASE, 'no running match');
    if (msg.t === 'g.leave') {
      this.removeMember(room, session.playerId);
      return OK;
    }
    // a spectator only watches (header): nothing else of it ever reaches the match
    if (msg.t !== 'g.watch' && room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    let res;
    try {
      res = room.match.handle(session.playerId, msg);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (res && typeof res.then === 'function') {
      // Contract violation (handle must be synchronous): never let the rejection go unhandled.
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) returned a Promise; it must be synchronous`);
      Promise.resolve(res).catch((e) => this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e));
      return OK;
    }
    if (res && typeof res === 'object' && res.error) {
      return fail(isErrCode(res.error) ? res.error : ERR.INTERNAL, typeof res.detail === 'string' ? res.detail : undefined);
    }
    return OK;
  }

  /** Call an optional match hook without letting it throw. onLeave falls back to onDisconnect. */
  callMatch(room, method, ...args) {
    const m = room.match;
    if (!m) return undefined;
    let fn = m[method];
    if (typeof fn !== 'function' && method === 'onLeave') fn = m.onDisconnect;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(m, args);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.${method} threw`, e);
      return undefined;
    }
  }

  disposeMatchCtx(ctx) {
    if (ctx.disposed) return;
    ctx.disposed = true;
    ctx.live = false;
    try { ctx.match?.dispose?.(); } catch (e) { this.log.error('[lobby] match.dispose threw', e); }
  }

  safeData() {
    try { return this.getData(); } catch (e) { this.log.error('[lobby] getData failed', e); return Object.freeze({}); }
  }

  /** How long a dropped solo run stays resumable (ms): the option, else data singleReconnectTime, else 24 h. */
  soloResumeWindowMs() {
    const o = this.opts.soloReconnectWindowMs;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    const sec = this.safeData()?.config?.constants?.singleReconnectTime;
    return (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : SOLO_RECONNECT_FALLBACK_SEC) * 1000;
  }

  // ---------------------------------------------------------------------------------------------------
  // Membership helpers
  // ---------------------------------------------------------------------------------------------------

  /** The session's current room (self-heals stale `roomCode`). @returns {Room | null} */
  roomOf(session) {
    if (!session.roomCode) return null;
    const room = this.rooms.get(session.roomCode);
    const seat = room ? room.seatOf(session.playerId) : null;
    if (room && !seat && room.spectatorOf(session.playerId)) return room; // a spectator seat
    if (!room || !seat || seat.left || seat.isBot) { session.roomCode = null; return null; }
    return room;
  }

  /** @returns {Seat} */
  humanSeat(idx, session) {
    return {
      seat: idx, playerId: session.playerId, name: session.name, avatar: session.avatar || null, isBot: false, ready: false, connected: session.connected, left: false,
      loadout: session.loadout || null,
      notOwned: session.notOwned || null,
      diy: session.diy || null,
      skins: session.skins || null,
    };
  }

  /**
   * Remove a human from a room permanently (leave, grace timeout, expiry, switching rooms).
   * In LOBBY the seat is freed; during a match it is marked departed and match.onLeave is called.
   * @param {Room} room @param {string} playerId
   */
  removeMember(room, playerId) {
    const session = this.registry.byId(playerId);
    if (session && session.roomCode === room.code) session.roomCode = null;
    this.clearGrace(playerId);
    this.dropReplay(room, playerId);
    if (this.freeSpectatorSeat(room, playerId)) return;
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || room.disposed) return;
    if (room.match) {
      seat.left = true;
      seat.connected = false;
      seat.ready = false;
      this.callMatch(room, 'onLeave', playerId);
    } else {
      room.seats[seat.seat] = null;
    }
    if (room.disposed) return; // onLeave may have ended the match and emptied the room
    if (room.hostId === playerId) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /**
   * Free a spectator seat (removeMember): the match forgets the spectator; never a host change or a disposal — a
   * spectator neither holds the host nor keeps a room alive. @returns {boolean} true when it was a spectator seat
   */
  freeSpectatorSeat(room, playerId) {
    const i = room.spectators.findIndex((s) => s.playerId === playerId);
    if (i < 0) return false;
    room.spectators.splice(i, 1);
    if (room.disposed) return true;
    this.callMatch(room, 'removeSpectator', playerId);
    this.broadcastState(room);
    return true;
  }

  /** Lowest-seat connected human becomes host (else lowest-seat human, else null). */
  migrateHost(room) {
    const humans = room.activeHumans();
    const pick = humans.find((s) => s.connected) || humans[0] || null;
    const prev = room.hostId;
    room.hostId = pick ? pick.playerId : null;
    if (pick && prev !== pick.playerId) this.log.info(`[lobby] ${room.code} host → ${pick.name}`);
  }

  startGrace(room, seat) {
    const playerId = seat.playerId;
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (room.disposed || room.match) return;
      const s = room.seatOf(playerId) || room.spectatorOf(playerId);
      if (!s || s.connected) return;
      const session = this.registry.byId(playerId);
      if (session && session.roomCode === room.code) {
        session.notice = 'timeout';
        session.pendingResult = this.replayFor(room, playerId); // still shown after room.closed on resume
      }
      this.removeMember(room, playerId);
    }, this.opts.lobbyGraceMs);
    t.unref?.();
    this.graceTimers.set(playerId, t);
  }

  clearGrace(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) { clearTimeout(t); this.graceTimers.delete(playerId); }
  }

  /**
   * Delete a room, detach its members (room.closed unless the room simply emptied) and dispose its match.
   * @param {Room} room @param {string} reason
   */
  disposeRoom(room, reason) {
    if (room.disposed) return;
    room.disposed = true;
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    const ctx = room.matchCtx;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = null;
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (s.left || reason === 'empty') continue;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    // spectators did not leave: they are told whatever closed the room (its last human leaving included)
    for (const s of room.spectators) {
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    if (ctx) this.disposeMatchCtx(ctx);
    this.log.info(`[lobby] ${room.code} disposed (${reason})`);
  }

  genCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------------

  /** Connected, non-departed human sessions of a room — its spectators included (room.state, match broadcasts). */
  *memberSessions(room) {
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const session = this.registry.byId(s.playerId);
      if (session && session.connected && session.roomCode === room.code) yield session;
    }
  }

  broadcastState(room) {
    if (room.disposed) return;
    const data = encode(room.toState());
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data);
  }

  sendState(room, session) {
    sendSession(session, room.toState());
  }

  /** Match broadcast: encode once, send to every connected member. @returns {string | null} the encoded frame */
  broadcastRoom(room, msg) {
    if (room.disposed) return null;
    const data = encode(msg);
    if (data == null) { this.log.error(`[lobby] ${room.code} unserializable broadcast ${msg && msg.t}`); return null; }
    const droppable = isDroppable(msg);
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data, { droppable });
    return data;
  }

  /** Match unicast. @returns {boolean} */
  sendToPlayer(room, playerId, msg) {
    if (room.disposed) return false;
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || session.roomCode !== room.code) return false;
    return sendSession(session, msg);
  }
}
