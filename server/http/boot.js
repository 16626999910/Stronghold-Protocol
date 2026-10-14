// server/http/boot.js — running the server as a process (`node server/index.js`, npm start, scripts/launch.mjs):
//
//   * the boot banner: release version, the Local URL, the LAN URLs when listening on every interface, the
//     cloudflared command for internet play;
//   * a server that cannot start exits 1 (with a hint when the port is in use); unhandled rejections and uncaught
//     exceptions are logged, not fatal;
//   * graceful shutdown on SIGINT/SIGTERM (rooms get room.closed{reason:'shutdown'}, sockets close 1001); a second
//     signal exits at once, and the process exits anyway 5 s after the first.

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, DEV_BUILD } from '../../shared/constants.js';
import { scheduleDailyRestart, formatRestartAt, RESTART_EXIT_CODE, nextTempRestartAt } from './restart.js';

/** Non-internal IPv4 addresses as http URLs. @param {number} port */
export function lanUrls(port) {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}

/** Is the module whose `import.meta.url` is `metaUrl` the file node was started with? */
export function isProcessEntry(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Print the boot banner of a started server. @param {{ url: string, host: string, port: number }} srv */
export function printBanner(srv) {
  console.log(`\n  卫戍协议：盟约 · Stronghold Protocol: Alliance v${APP_VERSION}`);
  if (DEV_BUILD) console.log('  ! 开发版（dev 分支）：不稳定，请勿用于公开服务器 · development build — unstable, not for public servers');
  console.log(`  Local:   ${srv.url}`);
  if (srv.host === '0.0.0.0' || srv.host === '::') {
    for (const u of lanUrls(srv.port)) console.log(`  LAN:     ${u}`);
  }
  console.log('  Internet: cloudflared tunnel --url ' + `http://localhost:${srv.port}` + '\n');
}

/**
 * The process main: start the server, print the banner, stop gracefully on SIGINT / SIGTERM.
 * @param {() => Promise<{ url: string, host: string, port: number, close: () => Promise<void> }>} start index.js startServer
 */
export async function runMain(start) {
  process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection', e));
  process.on('uncaughtException', (e) => console.error('[process] uncaught exception', e));
  let srv;
  try {
    srv = await start();
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') console.error(`端口已被占用 / port in use: ${e.port ?? process.env.PORT ?? 3000}. Try PORT=3001 npm start`);
    else console.error('[boot] failed to start', e);
    process.exit(1);
  }
  printBanner(srv);

  let stopping = false;
  const stop = (signal, code = 0) => {
    if (stopping) { console.log('forced exit'); process.exit(code || 1); }
    stopping = true;
    console.log(`\n[${signal}] shutting down…`);
    setTimeout(() => process.exit(code), 5000).unref();
    srv.close().then(() => process.exit(code), () => process.exit(1));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // 每日重启 (this build, SP_RESTART_AT): exit gracefully at the time and let the supervisor start a fresh process.
  const at = srv.restartAt;
  if (at && Number.isInteger(at.hour) && Number.isInteger(at.minute)) {
    const next = scheduleDailyRestart(at.hour, at.minute, () => {
      console.log(`\n[restart] daily restart at ${formatRestartAt(at)} — shutting down; the supervisor starts a fresh process`);
      stop('restart', RESTART_EXIT_CODE);
    });
    console.log(`  Restart: daily at ${formatRestartAt(at)} (in ${Math.round(next.ms / 60000)} min) · SP_RESTART_AT=off disables`);
  } else {
    console.log('  Restart: daily auto-restart disabled (SP_RESTART_AT=off)');
  }

  // ============================================================================================
  // 临时：发版用重启 (作者 2026-10-14)。**不修改上方的每日重启**，只是**额外**在 **北京时间 02:00**
  // （服务器为 UTC → 18:00Z）触发一次就退出，由守护进程拉起新进程。目标时刻**动态取「下一次」**，
  // 免得睡过头/部署延迟导致目标时间已过而失效。要改时间就改 `restart.js` 的 `TEMP_RESTART_UTC`。
  // 与**「临时更新弹窗」**同源（都读 restart.js 的 nextTempRestartAt）：两者永远对齐，**重启后一起整段删除**——
  // 本段 + restart.js 的临时块 + lobby.js welcomeInfo 的 tempRestartAt + public/js/ui/tempNotice.js(+main.js 接线)。
  // ============================================================================================
  const nowMs = Date.now();
  const TEMP_RESTART_AT = nextTempRestartAt(nowMs); // 北京 02:00 = UTC 18:00（时刻与「临时更新弹窗」同源）
  const tempMs = TEMP_RESTART_AT - nowMs;
  if (tempMs > 0) {
    const t = setTimeout(() => {
      console.log('\n[restart] TEMP restart (北京 02:00 / UTC 18:00) — shutting down; the supervisor starts a fresh process');
      stop('restart', RESTART_EXIT_CODE);
    }, tempMs);
    t.unref?.();
    console.log(`  Restart: TEMP at ${new Date(TEMP_RESTART_AT).toISOString()} = 北京 ${new Date(TEMP_RESTART_AT + 8 * 3600e3).toISOString().slice(11, 16)} (in ${Math.round(tempMs / 60000)} min) — 发版用，重启后删除本段`);
  }
}
