// server/endlessLeaderboard.js — 无尽模式排行榜 (this build, 阶段7): TWO rankings, each keeping the TOP teams.
//
//   const board = new EndlessLeaderboard({ file, log, now, top })
//   board.record(summary) → { rounds: entry|null, damage: entry|null }  (offer one finished run)
//   board.list()          → { rounds: [...top], damage: [...top] }
//
//   rounds: 通过回合数 (进打桩时的回合) high → low, tie-break 打桩伤害 then earliest
//   damage: 打桩累计伤害 (整队) high → low, tie-break 通过回合 then earliest
//
// A "team" is identified by its members' (sorted) names — the same lineup only keeps its BEST run per board (同队保留最好).
// The run only qualifies when the result's `reason === 'endless'` (a 打桩-ended 无尽局). The board file lives OUTSIDE the
// served directories (default <root>/leaderboard/endless.json); writes are atomic and best-effort. Runtime data:
// `leaderboard/` is in .gitignore.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './http/config.js';
import { ENDLESS } from '../shared/constants.js';

/** Default board file (never inside a served directory). */
export const DEFAULT_ENDLESS_BOARD_FILE = () => path.join(ROOT, 'leaderboard', 'endless.json');

/** How many teams each board keeps. */
export const ENDLESS_BOARD_TOP = ENDLESS.LEADERBOARD_TOP;

const noopLog = { info() {}, warn() {}, error() {} };

/** One settlement player row, trimmed for the board (the client's detail view). */
function trimPlayer(p) {
  if (!p || typeof p !== 'object') return null;
  const s = p.stats && typeof p.stats === 'object' ? p.stats : {};
  return {
    name: String(p.name ?? '').slice(0, 32),
    // 核心(专属)盟约 (author 2026-10-13): 排行榜点开可查看该队每人的核心盟约
    exclusiveBond: (typeof p.exclusiveBond === 'string' && /^[A-Za-z]{1,24}$/.test(p.exclusiveBond)) ? p.exclusiveBond : null,
    isBot: !!p.isBot,
    left: !!p.left,
    alive: !!p.alive,
    bandIds: Array.isArray(p.bandIds) && p.bandIds.length ? p.bandIds.slice()
      : typeof p.bandId === 'string' ? [p.bandId] : [],
    lineup: Array.isArray(p.lineup) ? p.lineup.slice(0, 12).map((c) => (c && typeof c === 'object' ? String(c.id ?? '') : String(c))) : [],
    stats: {
      dmgDealt: Math.max(0, Number(s.dmgDealt) || 0),
      // 无尽模式: 每人的打桩伤害 (结算里当作 领袖伤害)
      bossDamage: Math.max(0, Number(s.bossDamage) || 0),
      kills: Math.max(0, Number(s.kills) || 0),
      leaks: Math.max(0, Number(s.leaks) || 0),
      gold: Math.max(0, Number(s.gold) || 0),
      merges: Math.max(0, Number(s.merges) || 0),
      itemsEquipped: Math.max(0, Number(s.itemsEquipped) || 0),
    },
    title: p.title && typeof p.title === 'object' ? (typeof p.title.name === 'string' ? p.title.name : null) : (typeof p.title === 'string' ? p.title : null),
  };
}

export class EndlessLeaderboard {
  /** @param {{ file?: string | null, log?: object, now?: () => number, top?: number }} [opts] */
  constructor({ file = undefined, log = noopLog, now = Date.now, top = ENDLESS_BOARD_TOP } = {}) {
    this.file = file === undefined ? DEFAULT_ENDLESS_BOARD_FILE() : file; // null → memory-only (tests)
    this.log = log;
    this.now = now;
    this.top = Math.max(1, Number(top) || ENDLESS_BOARD_TOP);
    /** @type {{ rounds: object[], damage: object[] }} */
    this.entries = { rounds: [], damage: [] };
    this.load();
  }

  /** Read the board file (missing / unreadable → empty). Never throws. */
  load() {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const board of ['rounds', 'damage']) {
        const list = Array.isArray(data?.[board]) ? data[board] : [];
        this.entries[board] = list.filter(isEntry).slice(0, this.top);
      }
    } catch (e) {
      this.log.warn?.('[endlessBoard] could not read the board file, starting empty', e);
      this.entries = { rounds: [], damage: [] };
    }
  }

  /** Write the board file atomically (temp + rename). Best-effort — a failure is logged, not thrown. */
  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, rounds: this.entries.rounds, damage: this.entries.damage }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log.error?.('[endlessBoard] could not save the board file', e);
    }
  }

  /** The two boards, each already sorted (best first). */
  list() {
    return { rounds: this.entries.rounds.slice(), damage: this.entries.damage.slice() };
  }

  /**
   * Offer one finished 无尽局. Only `reason === 'endless'` qualifies. Each board keeps the top `top` teams; a team's own
   * earlier entry is replaced only when the new run is better (rounds: higher rounds then higher dmg; damage: higher dmg
   * then higher rounds).
   * @param {object} summary the settlement summary of the run (+ `owner` from the lobby)
   * @returns {{ rounds: object|null, damage: object|null }}
   */
  record(summary) {
    const none = { rounds: null, damage: null };
    if (!summary || typeof summary !== 'object' || summary.reason !== 'endless') return none;
    const rounds = Math.max(0, Math.round(Number(summary.roundsPassed) || 0));
    const dmg = Math.max(0, Math.round(Number(summary.dummyDmg) || 0));
    const players = (Array.isArray(summary.players) ? summary.players : []).slice(0, 16);
    const names = players.map((p) => String(p?.name ?? '').trim()).filter(Boolean).sort();
    const teamKey = names.join('|') || `?${String(summary.owner ?? '')}`;
    const entry = {
      teamKey,
      at: this.now(),
      owner: String(summary.owner ?? '').slice(0, 32),
      rounds,
      dmg,
      teamSize: players.length,
      players: players.map(trimPlayer).filter(Boolean),
    };
    const out = { rounds: null, damage: null };
    if (this._insert('rounds', entry, (a, b) => (b.rounds - a.rounds) || (b.dmg - a.dmg) || (a.at - b.at))) out.rounds = entry;
    if (this._insert('damage', entry, (a, b) => (b.dmg - a.dmg) || (b.rounds - a.rounds) || (a.at - b.at))) out.damage = entry;
    if (out.rounds || out.damage) this.save();
    return out;
  }

  /** Insert/replace `entry` on one board; returns true when it made the board (kept). */
  _insert(board, entry, cmp) {
    const list = this.entries[board];
    const prev = list.find((e) => e.teamKey === entry.teamKey);
    if (prev && cmp(prev, entry) <= 0) return false; // the stored run is at least as good
    const next = list.filter((e) => e.teamKey !== entry.teamKey);
    next.push(entry);
    next.sort(cmp);
    if (next.length > this.top) next.length = this.top;
    this.entries[board] = next;
    return next.includes(entry);
  }
}

/** Shape check of a stored entry (a broken one is dropped, not thrown on). */
function isEntry(e) {
  return !!e && typeof e === 'object' && Number.isFinite(Number(e.rounds)) && Number.isFinite(Number(e.dmg));
}
