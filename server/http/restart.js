// server/http/restart.js — 每日重启 (this build): the server restarts itself once a day at a fixed local time, so a
// long-running public server clears the memory only it holds (rooms and matches live in memory, no database) and picks
// up any code the host updated — without the host timing it by hand.
//
//   restartAtFrom(opts)                 → { hour, minute }, or null when disabled (the `restartAt` option wins over
//                                          SP_RESTART_AT; default 19:25, `off` disables)
//   msUntilTime(hour, minute, now)      → ms from `now` to the next local `hour:minute`:00 (always > 0, up to 24 h)
//   scheduleDailyRestart(h, m, fire)    → a timer that fires `fire()` once, at the next `h:m`; returns a cancel fn
//   formatRestartAt({ hour, minute })   → 'H:MM' (what the log prints)
//
// boot.js (runMain) schedules it: the process shuts down gracefully and exits with RESTART_EXIT_CODE, and whoever
// supervises it starts a fresh one — scripts/run-server.cmd (the Windows service's loop) restarts on any exit,
// scripts/launch.mjs respawns on this code, and a process manager (systemd / 宝塔 / pm2 …) restarts on exit as usual.
// A bare `node server/index.js` with no supervisor simply stops: run it under a supervisor if the daily restart matters.

/** The exit code a scheduled restart uses (EX_TEMPFAIL); launch.mjs respawns on it, other supervisors restart either way. */
export const RESTART_EXIT_CODE = 75;

/**
 * Default daily restart time, local `HH:MM`. **19:25** so that a server whose process clock is **UTC** (the usual case on
 * a cloud host) restarts at **北京时间 03:25** (UTC+8). A host already on Beijing time can set `SP_RESTART_AT=03:25`.
 */
export const RESTART_DEFAULT = '19:25';

/**
 * Parse a restart time: `"H:MM"` / `"HH:MM"`, or `{ hour, minute }`, → `{ hour, minute }`; null for off / unreadable.
 * @param {unknown} v
 * @returns {{ hour: number, minute: number } | null}
 */
export function parseRestartAt(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    const hour = Number(v.hour);
    const minute = Number(v.minute ?? 0);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59 ? { hour, minute } : null;
  }
  const s = String(v).trim();
  if (/^(off|none|no|false|disable|disabled)$/i.test(s)) return null;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

/**
 * When the daily restart happens: the `restartAt` option, else `SP_RESTART_AT`, else 19:25. Anything unreadable — and
 * the literal `off` — disables it.
 * @param {{ restartAt?: string | { hour: number, minute: number } | null }} [opts]
 * @returns {{ hour: number, minute: number } | null}
 */
export function restartAtFrom(opts = {}) {
  if (opts.restartAt !== undefined) return parseRestartAt(opts.restartAt);
  const env = process.env.SP_RESTART_AT;
  if (env != null && env !== '') return parseRestartAt(env);
  return parseRestartAt(RESTART_DEFAULT);
}

/** 'H:MM' — the form the log prints. @param {{ hour: number, minute: number }} at */
export const formatRestartAt = (at) => `${at.hour}:${String(at.minute).padStart(2, '0')}`;

/**
 * Milliseconds from `now` to the next local `hour:minute`:00. Always > 0 (at exactly that second it is a full day).
 * @param {number} hour 0–23 @param {number} minute 0–59 @param {number} [now] epoch ms
 * @returns {number}
 */
export function msUntilTime(hour, minute, now = Date.now()) {
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0);
  while (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now;
}

/**
 * Schedule `fire()` once, at the next local `hour:minute` (no repeat — the process is meant to exit and be restarted).
 * @param {number} hour @param {number} minute @param {() => void} fire
 * @param {{ now?: () => number, setTimeout?: Function, clearTimeout?: Function }} [deps]
 * @returns {{ ms: number, cancel: () => void }}
 */
export function scheduleDailyRestart(hour, minute, fire, deps = {}) {
  const set = deps.setTimeout || setTimeout;
  const clear = deps.clearTimeout || clearTimeout;
  const ms = msUntilTime(hour, minute, (deps.now || Date.now)());
  const timer = set(fire, ms);
  return { ms, cancel: () => clear(timer) };
}

// ============================================================================================
// ⚠️ 临时：发版用一次性重启 (作者 2026-10-14)。**不改动上方的每日重启**，只是**额外**在某个时刻触发一次就退出。
// 与**「临时更新弹窗」**(public/js/ui/tempNotice.js) 同属一块临时代码：**后端重启更新完成后，请一起整块删除** ——
//   ① 本块 ② boot.js 里 nextTempRestartAt 的调用那一段 ③ lobby.js welcomeInfo 里的 tempRestartAt ④ public/js/ui/tempNotice.js
//   （以及 main.js 里对它的 import 与 <${TempNoticeHost} /> 挂载）。弹窗读的就是这里的时刻，二者永远对齐。
// 目标是**北京时间 02:00**（服务器为 UTC → 18:00Z）。取「下一次」，免得睡过头/部署延迟导致时刻已过而失效。
export const TEMP_RESTART_UTC = Object.freeze({ hour: 18, minute: 0 }); // 北京 02:00 = UTC 18:00

/** 下一次临时重启的 epoch（今天该时刻已过则取明天）。@param {number} [now] epoch ms @returns {number} */
export function nextTempRestartAt(now = Date.now()) {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), TEMP_RESTART_UTC.hour, TEMP_RESTART_UTC.minute, 0, 0);
  return t > now ? t : t + 86400000;
}
