// server/match/simPool.js — a worker_threads pool for server-run headless battles (see simWorker.js).
//
// The server only becomes CPU-bound where it has to simulate a battle itself: a combat / 联防 field whose human
// authority is missing (an AI seat, a disconnected player, a takeover) or a stalled client. Those fields are
// independent and reconstructible from their JSON BattleSpec, so each one can run on its own core instead of sharing
// the event-loop thread (clientCombat.js _runOnServer). Boss / hidden fields share an in-process pool (SharedBossPool /
// the shield parts) and never come through here.
//
//   const pool = createSimPool({ size, dataDir, log });
//   const run = await pool.run({ spec, players }, { onProgress(timeline) { … } });
//   // run = { result, timeline, time, crashed }
//
// Lazily started: nothing is spawned until the first run() (or when `size <= 0` → the factory returns null = disabled).
// Workers are `unref()`'d so an idle pool never keeps the process alive; dispose() terminates them (server shutdown).
// A worker that dies rejects its job — the caller (clientCombat.js) then falls back to an in-process run, so losing a
// worker degrades to today's single-threaded behaviour instead of failing the field.

import os from 'node:os';
import { Worker } from 'node:worker_threads';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Default worker count when the CLI does not override it: one per core minus the event loop, capped (each worker holds
 * its own copy of the game data, so keep the number modest on a small host).
 * @returns {number}
 */
export function defaultSimWorkers() {
  const raw = typeof process !== 'undefined' && process.env ? process.env.SP_WORKERS : undefined;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  const cores = (os.availableParallelism && os.availableParallelism()) || (os.cpus && os.cpus().length) || 2;
  return Math.min(8, Math.max(1, cores - 1));
}

/**
 * Build the pool, or null when disabled (`size <= 0`).
 * @param {{ size?: number, dataDir?: string | null, log?: object }} [opts]
 * @returns {{
 *   run: (job: { spec: object, players?: string[] }, opts?: { onProgress?: (timeline: any[]) => void }) => Promise<{ result: any, timeline: any[], time: number, crashed: boolean }>,
 *   dispose: () => void, size: number, stats: () => { workers: number, busy: number, queued: number },
 * } | null}
 */
export function createSimPool({ size = 0, dataDir = null, log = noopLog } = {}) {
  const capacity = Math.max(0, Math.floor(Number(size) || 0));
  if (capacity === 0) return null;
  const workerUrl = new URL('./simWorker.js', import.meta.url);
  const workerData = dataDir ? { dataDir } : {};

  /** @type {Array<{ worker: Worker, task: Task | null, dead: boolean }>} */
  const records = [];
  /** @type {Task[]} */
  const pending = [];
  let seq = 0;
  let disposed = false;

  /** @typedef {{ id: number, spec: object, players: string[], onProgress?: (t: any[]) => void, resolve: Function, reject: Function }} Task */

  const spawn = () => {
    const worker = new Worker(workerUrl, { workerData });
    /** @type {{ worker: Worker, task: Task | null, dead: boolean }} */
    const rec = { worker, task: null, dead: false };
    worker.on('message', (m) => onMessage(rec, m));
    worker.on('error', (e) => onWorkerDown(rec, e, 'error'));
    worker.on('exit', (code) => onWorkerDown(rec, code === 0 ? null : new Error(`sim worker exited (${code})`), 'exit'));
    worker.unref?.();
    records.push(rec);
    return rec;
  };

  const dropRecord = (rec) => {
    const i = records.indexOf(rec);
    if (i >= 0) records.splice(i, 1);
  };

  /** Release a worker back to the pool (or drop it if it died) and hand it the next queued job. */
  const settle = (rec, task, finish) => {
    if (rec.task === task) rec.task = null;
    try { finish(); } catch { /* the promise callbacks never throw */ }
    if (rec.dead) dropRecord(rec);
    dispatch();
  };

  const startTask = (rec, task) => {
    rec.task = task;
    try {
      rec.worker.postMessage({ id: task.id, spec: task.spec, players: task.players });
    } catch (e) {
      settle(rec, task, () => task.reject(e));
    }
  };

  /** Assign queued jobs to free workers, spawning up to the cap. */
  const dispatch = () => {
    if (disposed) return;
    while (pending.length) {
      let rec = records.find((r) => !r.dead && !r.task) || null;
      if (!rec) {
        if (records.length >= capacity) return;
        rec = spawn();
      }
      startTask(rec, pending.shift());
    }
  };

  const onMessage = (rec, m) => {
    const task = rec.task;
    if (!task || !m || m.id !== task.id) return;
    if (m.type === 'progress') {
      try { task.onProgress?.(m.timeline); } catch { /* a progress callback never breaks the pool */ }
      return;
    }
    if (m.type === 'error') {
      settle(rec, task, () => task.reject(new Error(m.message || 'sim worker error')));
      return;
    }
    if (m.type === 'done') {
      settle(rec, task, () => task.resolve({ result: m.result, timeline: m.timeline, time: m.time, crashed: !!m.crashed }));
    }
  };

  /** A worker died: reject its job (the caller falls back in-process) and let the next dispatch respawn one. */
  const onWorkerDown = (rec, err, why) => {
    rec.dead = true;
    const task = rec.task;
    rec.task = null;
    dropRecord(rec);
    if (task) {
      log.warn?.(`[sim] worker ${why}; job ${task.id} rejected${err ? `: ${err.message}` : ''}`);
      try { task.reject(err || new Error('sim worker stopped')); } catch { /* ignore */ }
    }
    dispatch();
  };

  return {
    size: capacity,
    run({ spec, players = [] } = {}, { onProgress } = {}) {
      return new Promise((resolve, reject) => {
        if (disposed) { reject(new Error('sim pool disposed')); return; }
        const task = { id: ++seq, spec, players, onProgress, resolve, reject };
        pending.push(task);
        dispatch();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const task of pending.splice(0)) { try { task.reject(new Error('sim pool disposed')); } catch { /* ignore */ } }
      for (const rec of records.splice(0)) { rec.dead = true; try { rec.worker.terminate(); } catch { /* ignore */ } }
    },
    stats: () => ({ workers: records.length, busy: records.filter((r) => r.task).length, queued: pending.length }),
  };
}
