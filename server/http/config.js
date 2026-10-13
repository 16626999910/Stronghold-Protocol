// server/http/config.js — where the server's settings come from. startServer() options win over the environment:
//
//   * PORT (default 3000), HOST (default 0.0.0.0);
//   * TRUST_PROXY ('auto' default: honour CF-Connecting-IP / X-Real-IP / X-Forwarded-For only from loopback/private
//     peers such as a local cloudflared; '1' always; '0' never) → net.js trustProxy;
//   * DEBUG → the console logger's debug level;
//   * the served directories (public/, data/, shared/ and the content packs' packs/ of this repository unless the
//     options name others), and which startServer() options are handed on to net.js Network and lobby.js Lobby.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** startServer() options handed on to net.js Network / lobby.js Lobby (an absent one keeps that module's default). */
const NET_OPTION_KEYS = ['reconnectWindowMs', 'heartbeatMs', 'helloTimeoutMs', 'ratePerSec', 'rateBurst', 'maxConnections', 'abuseDropsPerSec',
  'maxConnectionsPerAddr', 'heavyPerSec', 'heavyBurst', 'trustProxy'];
const LOBBY_OPTION_KEYS = ['lobbyGraceMs', 'maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr', 'resyncMinGapMs', 'soloReconnectWindowMs', 'idleMatchWindowMs', 'feedbackFile', 'feedbackCooldownMs', 'leaderboardFile',
  'lobbyChatMaxItems', 'lobbyChatMaxLen', 'lobbyChatCooldownMs', 'lobbyPartyCooldownMs', 'lobbyChatBroadcastsPerSec'];

/**
 * Where to listen: the `port` / `host` options, else PORT / HOST, else port 3000 on 0.0.0.0.
 * @param {{ port?: number, host?: string }} opts
 * @returns {{ port: number, host: string }}
 * @throws {RangeError} when the port is not an integer in 0…65535
 */
export function listenAddress(opts) {
  const port = opts.port ?? (process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 3000);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`invalid PORT ${port}`);
  return { port, host };
}

/**
 * The directories the static server reads (packsDir: the pack folders, server/packs.js).
 * @param {{ publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string }} opts
 */
export function serveDirs(opts) {
  return {
    publicDir: opts.publicDir || path.join(ROOT, 'public'),
    dataDir: opts.dataDir || path.join(ROOT, 'data'),
    sharedDir: opts.sharedDir || path.join(ROOT, 'shared'),
    packsDir: opts.packsDir || path.join(ROOT, 'packs'),
  };
}

/** net.js Network options out of the startServer() options; `trustProxy` falls back to TRUST_PROXY. */
export function netOptionsFrom(opts) {
  const netOptions = {};
  for (const k of NET_OPTION_KEYS) {
    if (opts[k] != null) netOptions[k] = opts[k];
  }
  if (netOptions.trustProxy == null) netOptions.trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  return netOptions;
}

/**
 * lobby.js Lobby options out of the startServer() options. `idleMatchWindowMs` (空闲对局清理) additionally reads the
 * environment, so a deployment can tune it without touching code: `SP_IDLE_MATCH_MIN=<minutes>` — 0 disables the sweep
 * and keeps the old behaviour (an abandoned run may sit for the whole 24 h solo reconnect window).
 * @param {object} opts
 */
export function lobbyOptionsFrom(opts) {
  const lobbyOptions = {};
  for (const k of LOBBY_OPTION_KEYS) {
    if (opts[k] != null) lobbyOptions[k] = opts[k];
  }
  // 每日重启 (this build): the lobby carries it into every `welcome` for the client's lobby notice; null means off, so
  // this one passes through even when null (startServer() computes it, see server/http/restart.js).
  if (Object.hasOwn(opts, 'restartAt')) lobbyOptions.restartAt = opts.restartAt;
  if (lobbyOptions.idleMatchWindowMs == null) {
    const min = Number(process.env.SP_IDLE_MATCH_MIN);
    if (Number.isFinite(min) && min >= 0) lobbyOptions.idleMatchWindowMs = Math.round(min * 60_000);
  }
  return lobbyOptions;
}

/** TRUST_PROXY env → net.js trustProxy ('auto' unless explicitly on/off). @param {string | undefined} v */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'always'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'never'].includes(s)) return false;
  return 'auto';
}

/** The console logger (`quiet` → silent; debug lines only with DEBUG set). */
export function makeLogger(quiet) {
  if (quiet) return noopLog;
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
    debug: process.env.DEBUG ? (...a) => console.debug(...a) : () => {},
  };
}
