// server/match/simWorker.js — worker_threads entry for the headless battle pool (server/match/simPool.js).
//
// A worker receives `{ id, spec, players }` and runs one server-run field's battle to its end off the main thread,
// on its own core. It reconstructs the Battle from the JSON BattleSpec exactly as the main process would
// (sim/spec.js createBattleFromSpec — deterministic from spec + data, DESIGN §14) and reuses the main thread's own
// HeadlessJob (match/fields.js), so the result and progress timeline are identical to an in-process run.
//
// Only normal / unite fields with no human authority are dispatched here: they carry no shared boss / shield pool
// (that stays in the main process, see clientCombat.js _runOnServer). While the job runs it posts the timeline that
// grew (`{ type: 'progress', timeline }`) so the teammates' waiting UI keeps updating, then a final
// `{ type: 'done', result, timeline, time, crashed }` (`{ type: 'error', message }` when the battle cannot even be
// constructed — the pool then falls back to an in-process run).
//
// The game data is loaded lazily on the first job (each worker holds its own copy; the pool caps the worker count).

import { parentPort, workerData } from 'node:worker_threads';
import { getData } from '../data.js';
import { DataSource } from '../sim/simdata.js';
import { createBattleFromSpec } from '../sim/spec.js';
import { HeadlessJob } from './fields.js';

/** Wall-clock ms per slice: let the worker post progress without hoarding the core (the battle itself is CPU-bound). */
const SLICE_MS = 8;

const dataDir = workerData && workerData.dataDir ? workerData.dataDir : undefined;
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

/** @type {DataSource | null} */
let ds = null;

/** The worker's data source — the same shape server/match/Match.js builds (dataSourceFor: DataSource(data, null)). */
function dataSource() {
  if (!ds) ds = new DataSource(getData({ dir: dataDir, log: quietLog }), null);
  return ds;
}

/** Run one job and post its result. Never throws out of the message handler. */
function runJob(msg) {
  const id = msg && msg.id;
  const players = Array.isArray(msg && msg.players) ? msg.players : [];
  /** @param {object} m */
  const post = (m) => { try { parentPort.postMessage(m); } catch { /* port closed */ } };
  let job;
  try {
    const battle = createBattleFromSpec(msg.spec, dataSource(), { recordEvents: false });
    job = new HeadlessJob(battle, { players });
  } catch (e) {
    post({ id, type: 'error', message: String((e && e.message) || e) });
    return;
  }
  // the initial sample (HeadlessJob already recorded one) so the waiting UI has a value before the first slice
  post({ id, type: 'progress', timeline: job.timeline });
  let lastLen = job.timeline.length;
  for (;;) {
    let done;
    try {
      done = job.run(SLICE_MS);
    } catch (e) {
      post({ id, type: 'error', message: String((e && e.message) || e) });
      return;
    }
    if (done) break;
    if (job.timeline.length !== lastLen) {
      lastLen = job.timeline.length;
      post({ id, type: 'progress', timeline: job.timeline });
    }
  }
  const out = job.output();
  post({
    id,
    type: 'done',
    result: out.result,
    timeline: out.timeline,
    time: Number(out.battle && out.battle.time) || 0,
    crashed: !!out.crashed,
  });
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    runJob(msg);
  });
}
