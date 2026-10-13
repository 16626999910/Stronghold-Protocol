// server/sim/content/kits/shared/limits.js — 无尽模式 (battle flags.noStackLimit): lift an operator talent / skill /
// module's 「最多叠加 N 层/次」 cap. The buff-stack caps that go through `Battle.addBuff({ refresh: 'stack', maxStacks })`
// are lifted centrally (sim/battle/status.js addBuff); the caps a kit enforces in JS — a `Math.min(maxStack, …)` or a
// `counter >= max` gate on a custom counter — must wrap their `max` with `capMax`.

/**
 * The cap a kit should enforce: the data value `n`, or Infinity in 无尽模式 (flags.noStackLimit). A non-positive /
 * non-finite `n` (a kit whose cap is absent ⇒ the effect is off) is returned unchanged, so the flag never turns an
 * absent cap into an unbounded one.
 * @param {any} battle
 * @param {number} n the talent/skill/module's data cap
 * @returns {number}
 */
export const capMax = (battle, n) =>
  (battle && battle.flags && battle.flags.noStackLimit && Number.isFinite(n) && n > 0) ? Infinity : n;
