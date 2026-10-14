// server/leaderboard.js — 大厅排行榜 (this build, owner 2026-10-10): 每个隐藏首领只记**最高难度下通关最快的一队**.
//
//   const board = new Leaderboard({ file, log, now })
//   board.record(entry)   → the stored entry, or null when the run does not qualify (not the top difficulty / no boss /
//                           not a clear / slower than the stored best)
//   board.list()          → every stored entry, latest records first (one per 隐藏首领)
//   board.get(bossId)     → one entry, or null
//
// Only the HIGHEST difficulty (`DIFFICULTIES` order, i.e. ABYSS) is recorded — a lower-difficulty clear never enters
// the board, and an equal-or-better one replaces the stored run only when it is FASTER (`durationMs`). The stored entry
// keeps the room owner's name, the run's MVP (the player with the highest `stats.dmgDealt`) and the whole settlement
// summary, so the client's detail view shows exactly the 结算数据 of that run.
//
// The file lives OUTSIDE the served directories (default <root>/leaderboard/leaderboard.json — never /data, which the
// static server serves). Writes are atomic (temp file + rename) and best-effort: a failed write is logged and the board
// keeps working in memory. It is runtime data: `leaderboard/` is in .gitignore.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './http/config.js';
import { DIFFICULTIES } from '../shared/constants.js';

/** Default board file (never inside a served directory). */
export const DEFAULT_LEADERBOARD_FILE = () => path.join(ROOT, 'leaderboard', 'leaderboard.json');

/** Tie-break / bounds of the board. */
export const LEADERBOARD_DEFAULTS = Object.freeze({
  maxBosses: 32,     // bosses kept (one entry each)
  maxTeam: 16,       // players kept per entry (the settlement rows of a room can never exceed the seat cap)
});

const noopLog = { info() {}, warn() {}, error() {} };
/** The highest difficulty — the only one the board records (`DIFFICULTIES` is low → high). */
export const TOP_DIFFICULTY = DIFFICULTIES[DIFFICULTIES.length - 1];
/** Rank of a difficulty key (unknown → -1). */
const diffRank = (d) => DIFFICULTIES.indexOf(d);

/** Per-player 盟约 (id + layers) — the detail view lists them (settlement `bonds`, results.js bondList). */
function trimBonds(bonds) {
  return Array.isArray(bonds)
    ? bonds.slice(0, 24).map((b) => ({ id: String(b?.bondId ?? ''), layers: Math.max(0, Number(b?.layers) || 0), active: !!b?.active })).filter((b) => b.id)
    : [];
}

/** One settlement player row, trimmed for the board (name + the numbers the detail view shows). */
function trimPlayer(p, mvpId) {
  if (!p || typeof p !== 'object') return null;
  const s = p.stats && typeof p.stats === 'object' ? p.stats : {};
  return {
    name: String(p.name ?? '').slice(0, 32),
    isBot: !!p.isBot,
    left: !!p.left,
    alive: !!p.alive,
    mvp: p.playerId === mvpId || undefined,
    bandId: typeof p.bandId === 'string' ? p.bandId : null,
    lineup: Array.isArray(p.lineup) ? p.lineup.slice(0, 24).map((c) => String(c)) : [],
    bonds: trimBonds(p.bonds),
    // 结算数据（与 m.result 的 stats 同源）
    stats: {
      dmgDealt: Math.max(0, Number(s.dmgDealt) || 0),
      bossDamage: Math.max(0, Number(s.bossDamage) || 0),
      kills: Math.max(0, Number(s.kills) || 0),
      leaks: Math.max(0, Number(s.leaks) || 0),
      gold: Math.max(0, Number(s.gold) || 0),
      merges: Math.max(0, Number(s.merges) || 0),
      itemsEquipped: Math.max(0, Number(s.itemsEquipped) || 0),
      lpLost: Math.max(0, Number(s.lpLost) || 0),
    },
    title: typeof p.title === 'string' ? p.title : null,
  };
}

export class Leaderboard {
  /** @param {{ file?: string | null, log?: object, now?: () => number } & Partial<typeof LEADERBOARD_DEFAULTS>} [opts] */
  constructor({ file = undefined, log = noopLog, now = Date.now, ...caps } = {}) {
    this.file = file === undefined ? DEFAULT_LEADERBOARD_FILE() : file; // null → memory-only (tests)
    this.log = log;
    this.now = now;
    this.opts = { ...LEADERBOARD_DEFAULTS, ...caps };
    /** @type {Map<string, object>} hiddenBossId → the stored best entry */
    this.entries = new Map();
    this.load();
  }

  /** Read the board file (missing / unreadable → empty). Never throws. */
  load() {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(data?.entries) ? data.entries : [];
      for (const e of list) if (isEntry(e)) this.entries.set(e.bossId, e);
    } catch (e) {
      this.log.warn?.('[leaderboard] could not read the board file, starting empty', e);
      this.entries = new Map();
    }
  }

  /** Write the board file atomically (temp + rename). Best-effort — a failure is logged, not thrown. */
  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: this.list() }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log.error?.('[leaderboard] could not save the board file', e);
    }
  }

  /** Every stored entry, latest first. */
  list() {
    return [...this.entries.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, this.opts.maxBosses);
  }

  /** The stored entry of one 隐藏首领, or null. */
  get(bossId) {
    return this.entries.get(String(bossId)) ?? null;
  }

  /**
   * Offer one finished run to the board. Qualifies only when it is a HIDDEN-CORE CLEAR at the **top difficulty**; then
   * it replaces the boss's stored run when it is faster (or when the stored one is a lower difficulty — which cannot
   * happen while TOP_DIFFICULTY is fixed, but keeps old files honest).
   * @param {{ bossId?: string, bossName?: string, difficulty?: string, durationMs?: number, modeId?: string,
   *           teamSize?: number, owner?: string, players?: object[] }} summary
   * @returns {object | null} the stored entry, or null when it does not qualify
   */
  record(summary) {
    if (!summary || typeof summary !== 'object') return null;
    // `bossId` is the lobby's explicit field; the settlement summary itself names it `hiddenBossId` (results.js) —
    // accept both so a raw summary records as-is.
    const bossId = typeof summary.bossId === 'string' ? summary.bossId
      : typeof summary.hiddenBossId === 'string' ? summary.hiddenBossId : null;
    if (!bossId) return null;
    // a run only counts when it actually cleared the 隐藏核心 (the lobby passes `{ ...summary }`; a bare entry may omit
    // the flags — an explicit false is what refuses).
    if (summary.victory === false || summary.hiddenCleared === false) return null;
    if (diffRank(summary.difficulty) < diffRank(TOP_DIFFICULTY) || diffRank(summary.difficulty) < 0) return null;
    // “通关用时”只看**隐秘核心那一场（R15）**：结算里的 `hiddenDurationMs`（含等待的全流程 `durationMs` 不用）。
    const durationMs = Number(summary.hiddenDurationMs ?? summary.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 0) return null;
    const players = Array.isArray(summary.players) ? summary.players.slice(0, this.opts.maxTeam) : [];
    // MVP = the run's highest damage dealer (stats.dmgDealt, the settlement's 总伤害)
    let mvpId = null, mvpVal = -1;
    for (const p of players) {
      const v = Number(p?.stats?.dmgDealt) || 0;
      if (v > mvpVal) { mvpVal = v; mvpId = p?.playerId ?? null; }
    }
    const prev = this.entries.get(bossId);
    if (prev) {
      const dr = diffRank(prev.difficulty) - diffRank(summary.difficulty);
      if (dr > 0) return null;                              // a higher-difficulty record stands
      if (dr === 0 && (Number(prev.durationMs) || 0) <= durationMs) return null;   // only a FASTER run replaces
    }
    const mvp = players.find((p) => p?.playerId === mvpId) || null;
    const entry = {
      bossId,
      bossName: String(summary.bossName ?? bossId).slice(0, 48),
      difficulty: summary.difficulty,
      durationMs: Math.round(durationMs),
      at: this.now(),
      modeId: typeof summary.modeId === 'string' ? summary.modeId : null,
      teamSize: Math.max(0, Number(summary.teamSize) || players.length),
      owner: String(summary.owner ?? '').slice(0, 32),
      mvp: mvp ? { name: String(mvp.name ?? '').slice(0, 32), dmgDealt: Math.max(0, Number(mvp.stats?.dmgDealt) || 0) } : null,
      players: players.map((p) => trimPlayer(p, mvpId)).filter(Boolean),
    };
    this.entries.set(bossId, entry);
    this.save();
    return entry;
  }
}

/** Shape check of a stored entry (a broken one is dropped, not thrown on). */
function isEntry(e) {
  return !!e && typeof e === 'object' && typeof e.bossId === 'string' && Number.isFinite(Number(e.durationMs));
}
