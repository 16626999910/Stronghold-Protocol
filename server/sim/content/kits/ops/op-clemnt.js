// server/sim/content/kits/ops/op-clemnt.js — 克莱门莎 (char_4231_clemnt) 自选 operator kit: 6★ 本源近卫
// (WARRIOR / primguard), an owned-6★ pick of the tier-5 and tier-6 自选 slots.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_4231_clemnt): normal = E2 Lv1, skills at rank 4, no module; elite = E2 Lv60,
// rank 7 (克莱门莎 ships with no module yet — the newest operator). Potential 0 [ASSUMED: no account].
// Sources: character_table / skill_table (zh_CN, as built into backups.json) and PRTS 克莱门莎.
// - Trait (本源近卫) "能够阻挡两个敌人，可以造成元素伤害": block 2 is the profession default; the 元素伤害 comes from the
//   skills' ep_damage_ratio riders (侵蚀损伤).
// - T0 生死定夺 "造成物理伤害时有 prob 概率攻击力提升至 t1_atk_scale，目标防御力低于初始值时概率提升至
//   prob_special": a crit on her own physical damage; the higher chance while the target's DEF is below its spawn value.
// - T1 习得性防御 "受到来自自身前方单位造成的物理和法术伤害降低 dr_normal，若伤害来源为【海怪】则降低 dr_sea":
//   phys / arts damage she takes from a source in the tile band in front of her (unit.fwd), ×(1 − dr).
// - S1 冲蚀 (INCREASE_WHEN_ATTACK): the next attack's ATK → atk_scale and deals ep_damage_ratio of the physical damage as
//   侵蚀损伤 (element,腐蚀). 连击/充能 per maxCharges.
// - S2 风暴潮 (INCREASE_WITH_TIME, 16 s): range widened to the skill grid; ASPD +attack_speed; each attack deals
//   attack@aoe_atk_scale to the target and up to attack@max_target other ground enemies around it. Summons 浮游放逐舱:
//   it drifts a few tiles forward pushing the ground enemies it holds (总重量 ≤ attack@max_passenger_mass, ≤
//   attack@max_passenger_cnt), then leaves a vortex: enemies in it are slowed attack@move_speed and take ~200 侵蚀/s +
//   attack@physical_atk_scale × ATK physical per second.
// - S3 与海为敌 (INCREASE_WITH_TIME, trigger_time 发弹药): range widened, +2 attack targets; each attack deals
//   attack@atk_scale physical + attack@ep_damage_ratio 侵蚀损伤; whenever any enemy's 侵蚀 burst happens she spends one
//   bullet to hit the burst target's tile and its four neighbours 3 times for s3_atk_scale × ATK physical + ep_damage_scale
//   × ATK element ([ASSUMED] bullet spend rules).

import { num, traitBb, talentBb, moduleBb, moduleOn, skillRec, skillBbOf, up, statBuff, makeZone, batMod } from '../shared/tier1.js';
import { frontOf } from '../../../dir.js';
import { bodyInKeys } from '../../../body.js';
import { absoluteRangeKeys } from '../../../targeting.js';

const EROSION = 'erosion';
const S1 = 'skchr_clemnt_1', S2 = 'skchr_clemnt_2', S3 = 'skchr_clemnt_3';
/** A living enemy that can take damage. */
const hittable = (e) => !!e && e.alive && e.side === 'enemy' && !e.s.flags.untargetable;
const gridOf = (chess, id) => skillRec(chess, id)?.rangeGrid ?? null;
/** The tile band in front of `unit` (the front half-plane, PRTS "自身前方单位") as a set of pos keys [ASSUMED]. */
function frontOf_(unit) { return frontOf(unit.tileR, unit.tileC, unit.dir, 1); }
function frontKeys(unit) {
  const keys = new Set();
  const f = frontOf_(unit);                      // the tile in front of her
  if (!f) return keys;
  const dr = f[0] - unit.tileR, dc = f[1] - unit.tileC;
  for (let t = 1; t <= 6; t++) keys.add(Math.round((unit.tileR + dr * t) * 1000 + (unit.tileC + dc * t)));
  return keys;
}

/** The frontier: an enemy's DEF below its spawn value (its 生死定夺 special chance). */
const defBroken = (e) => { const base = e.def?.stats?.def; return Number.isFinite(base) && e.s.def < base - 1e-6; };

export default {
  char_4231_clemnt: (bb, chess) => {
    const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
    const tb = traitBb(chess), hidden = moduleBb(chess);
    const b1 = skillBbOf(chess, S1), b2 = skillBbOf(chess, S2), b3 = skillBbOf(chess, S3);
    const g2 = gridOf(chess, S2), g3 = gridOf(chess, S3);
    const critScale = num(t0.t1_atk_scale, 1.35), pNormal = num(t0.prob_normal, 0.25), pSpecial = num(t0.prob_special, 0.5);
    const drNormal = num(t1.damage_resistance_normal, 0.3), drSea = num(t1.damage_resistance_seamonster, 0.5);
    const seaTag = t1.bbStr?.tag ?? 'seamonster';
    const isSea = (e) => !!e && (e.def?.race === seaTag || e.def?.tag === seaTag || (Array.isArray(e.def?.tags) && e.def.tags.includes(seaTag)));
    const erosion = (battle, unit, target, amount, tags) => {
      if (amount > 0 && hittable(target)) battle.dealDamage(unit, target, { type: 'element', element: EROSION, amount, tags });
    };

    return {
      skills: {
        // S1 冲蚀: 下次攻击的攻击力提高至 atk_scale 并造成相当于物理伤害 ep_damage_ratio 的侵蚀损伤
        [S1]: {
          kind: (chess?.skill?.maxCharges ?? 1) > 1 ? 'charges' : 'instant',
          attack: {
            atkScale: num(b1.atk_scale, 1),
            onHit({ battle, unit, target, dealt }) {
              if (target && hittable(target)) erosion(battle, unit, target, (dealt || unit.s.atk) * num(b1.ep_damage_ratio, 0), ['skill', 'clemnt:s1']);
            },
          },
        },
        // S2 风暴潮
        [S2]: {
          kind: 'duration',
          ...(g2 ? { targeting: { rangeGrid: g2 } } : {}),
          mods: { aspd: num(b2.attack_speed, 0) },
          attack: {
            atkScale: num(b2['attack@aoe_atk_scale'], 1),
            onHit({ battle, unit, target }) {
              if (!hittable(target)) return;
              const max = Math.max(0, Math.floor(num(b2['attack@max_target'], 1))) - 1;
              if (max <= 0) return;
              const near = battle.foesInRadius(target.x, target.y, 1.6, true).filter((e) => hittable(e) && e !== target).slice(0, max);
              for (const e of near) battle.dealDamage(unit, e, { amount: unit.s.atk * num(b2['attack@aoe_atk_scale'], 1), type: 'phys', isSkill: true, isSplash: true, tags: ['skill', 'clemnt:s2'] });
            },
          },
          onStart({ battle, unit }) {
            const f = frontOf_(unit);
            if (!f) return;
            const maxMass = num(b2['attack@max_passenger_mass'], 8), maxCnt = num(b2['attack@max_passenger_cnt'], 15);
            const massOf = (e) => num(e.massLevel ?? e.mass, 0);
            // 浮游放逐舱: drifts 3 tiles forward, pushing the ground enemies it holds; the push force is [ASSUMED]
            let r = f[0], c = f[1], step = 0;
            unit.mem.clemntCabin = { r, c };
            battle.every(0.5, () => {
              if (!unit.alive || step >= 3) return;
              const keys = new Set([Math.round(r * 1000 + c)]);
              let mass = 0, n = 0;
              for (const e of battle.enemies) {
                if (!hittable(e) || e.isFlying || !bodyInKeys(e, keys)) continue;
                if (mass + massOf(e) > maxMass || n >= maxCnt) break;
                battle.push(e, 1, { from: unit, dir: { x: unit.fwd[1], y: unit.fwd[0] }, effect: true });
                mass += massOf(e); n++;
              }
              c += unit.fwd[1]; r += unit.fwd[0]; step++;
              unit.mem.clemntCabin = { r, c };
              battle.fx('aoe', { x: c, y: r, id: unit.id, skill: 'clemnt:cabin' });
              if (step >= 3) {
                unit.mem.clemntCabin = null;
                const slow = num(b2['attack@move_speed'], -0.7), phy = num(b2['attack@physical_atk_scale'], 2.85);
                const vr = r, vc = c;
                makeZone(battle, unit, {
                  x: c, y: r, radius: 1.2, duration: 12, interval: 1, skill: 'clemnt:vortex',
                  onPulse(b) {
                    for (const e of [...b.foesInRadius(vc, vr, 1.2, true)]) {
                      if (!hittable(e) || e.isFlying) continue;
                      b.applyStatus(e, 'sluggish', { duration: 1.2, source: unit });
                      if (slow !== 0) b.addBuff(e, { key: 'clemnt:vortex', status: 'sluggish', mods: { moveMul: Math.max(0.05, 1 + slow) }, duration: 1.2, refresh: 'replace', source: unit });
                      erosion(b, unit, e, 200, ['skill', 'clemnt:vortex']);
                      b.dealDamage(unit, e, { amount: unit.s.atk * phy, type: 'phys', isSkill: true, tags: ['skill', 'clemnt:vortex'] });
                    }
                  },
                });
              }
            }, { owner: unit });
          },
          onEnd({ unit }) { unit.mem.clemntCabin = null; },
        },
        // S3 与海为敌 (ammo): attack@atk_scale physical + attack@ep_damage_ratio 侵蚀损伤; an 侵蚀 burst spends a bullet
        [S3]: {
          kind: 'ammo',
          ammo: Math.max(1, Math.floor(num(b3.trigger_time, 10))),
          ...(g3 ? { targeting: { rangeGrid: g3, maxTargets: 3 } } : { targeting: { maxTargets: 3 } }),
          attack: {
            atkScale: num(b3['attack@atk_scale'], 2),
            onHit({ battle, unit, target, dealt }) {
              if (target && hittable(target)) erosion(battle, unit, target, (dealt || unit.s.atk) * num(b3['attack@ep_damage_ratio'], 0), ['skill', 'clemnt:s3']);
            },
          },
          onStart({ battle, unit }) {
            const st = num(b3.s3_atk_scale, 2.7), ep = num(b3.ep_damage_scale, 2);
            battle.on('elementBurst', (c) => {
              const t = c.target;
              const sk = unit.skill;
              if (c.element !== EROSION || !up(unit) || !sk || sk.kind !== 'ammo' || sk.ammoLeft <= 0 || !hittable(t)) return;
              sk.ammoLeft--;                       // the burst spends one bullet [ASSUMED: PRTS wording]
              const keys = new Set(absoluteRangeKeys([[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]], Math.round(t.y), Math.round(t.x), 'RIGHT', 0));
              const hit = () => {
                for (const e of battle.enemies) {
                  if (!hittable(e) || e.isFlying || !bodyInKeys(e, keys)) continue;
                  battle.dealDamage(unit, e, { amount: unit.s.atk * st, type: 'phys', isSkill: true, tags: ['skill', 'clemnt:s3burst'] });
                  battle.dealDamage(unit, e, { type: 'element', element: EROSION, amount: unit.s.atk * ep, tags: ['skill', 'clemnt:s3burst'] });
                }
              };
              hit(); battle.after(0.4, hit); battle.after(0.8, hit);   // 3 次
              battle.fx('aoe', { x: t.x, y: t.y, id: unit.id, skill: 'clemnt:s3burst' });
            }, { owner: unit });
          },
        },
      },
      talents: [
        { install(battle, unit) { // 生死定夺: her physical damage, prob ⇒ ATK × critScale
          if (!(critScale > 1)) return;
          battle.on('hit', (c) => {
            if (c.source !== unit || !c.dmg || c.dmg.type !== 'phys' || !hittable(c.target)) return;
            const p = defBroken(c.target) ? pSpecial : pNormal;
            if (p > 0 && battle.rng.chance(p)) c.dmg.mul *= critScale;
          }, { owner: unit });
        } },
        { install(battle, unit) { // 习得性防御: phys/arts from the front, ×(1 − dr)
          if (!(drNormal > 0)) return;
          battle.on('hit', (c) => {
            if (c.target !== unit || !c.dmg || (c.dmg.type !== 'phys' && c.dmg.type !== 'arts')) return;
            const src = c.source;
            if (!src || src.side !== 'enemy') return;
            const key = Math.round(src.y) * 1000 + Math.round(src.x);
            if (!frontKeys(unit).has(key)) return;
            c.dmg.mul *= 1 - (isSea(src) ? drSea : drNormal);
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        // module (none yet) — keep the hook for when 克莱门莎's module ships
        const ep = num(hidden.ep_damage_scale, 0);
        if (ep > 0) {
          battle.on('elementHit', (c) => { if (c.source === unit && c.dmg?.type === 'element' && c.target?.side === 'enemy') c.dmg.mul *= 1 + ep; }, { owner: unit });
        }
      },
    };
  },
};
