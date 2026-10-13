// server/sim/content/kits/ops/op-oblvns.js — 丰川祥子 (char_4182_oblvns) 自选 operator kit: 6★ 领主 (WARRIOR / lord),
// an owned-6★ pick of the tier-5 and tier-6 自选 slots (the owner's pick of 2026-10-11 — a 协防/emptyShip operator).
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_4182_oblvns): normal = E2 Lv1, skills at rank 4, no module; elite = E2 Lv60,
// rank 7 (丰川祥子 ships with no module yet). Potential 0 [ASSUMED: no account].
// Sources: character_table / skill_table (zh_CN, as built into backups.json) and PRTS 丰川祥子.
// - Trait (领主) "可以进行远程攻击，但此时攻击力降低至80%": the profession default (trait bb atk_scale 0.8).
// - T0 颂乐音符 "…每存在一个音符，Ave Mujica成员无视敌人 def_penetrate_ratio 的防御力和 magic_resist_penetrate_ratio
//   法术抗性（最多叠加至 max_cnt 层）": each of her attacks leaves a note flying out for noteTtl s; while notes exist,
//   every 【Ave Mujica】 operator ignores that share × the note count of the target's DEF / RES (capped at max_cnt).
// - T1 毋畏遗忘 "对敌人造成伤害时使Fever+n；…攻击范围内干员攻击速度+attack_speed": the Fever gauge is a collab-only
//   mechanic this sim does not model [ASSUMED — skipped]; the in-range ASPD aura is implemented on the talent grid. The
//   "other Ave Mujica members' overlapping range counts as an extension" clause is [ASSUMED — not modelled].
// - S1 新月的苏醒 (ATTACK SP, 可充能2次): plays 8 notes, each dealing atk_scale_1..atk_scale_8 × ATK arts, decreasing.
// - S2 满月的舞会 (ATTACK SP): 钢琴 / 风琴 音色切换 — the sim's `toggle` is one-way, so the kit activates 钢琴
//   (ATK +attack@atk) and leaves 风琴 (ASPD +attack@attack_speed) as the documented alternative [ASSUMED].
// - S3 残月的余响 (ATTACK SP, 25 s): range widened; each attack plays a physical (attack@atk_scale × ATK) and an arts note.

import { num, talentBb, talentGrid, skillRec, skillBbOf, up } from '../shared/tier1.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { bodyInKeys } from '../../../body.js';

const S1 = 'skchr_oblvns_1', S2 = 'skchr_oblvns_2', S3 = 'skchr_oblvns_3';
/** The collab team of 丰川祥子 — the only 5 members the mode's data knows. */
const MUIJICA = new Set(['char_4182_oblvns', 'char_4183_mortis', 'char_4184_dolris', 'char_4185_amoris', 'char_4186_tmoris']);
const isMujica = (a) => !!a && a.kind === 'op' && MUIJICA.has(a.def?.charId);
const gridOf = (chess, id) => skillRec(chess, id)?.rangeGrid ?? null;
const alive = (u) => !!u && u.alive && u.hp > 0;

export default {
  char_4182_oblvns: (bb, chess) => {
    const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
    const b1 = skillBbOf(chess, S1), b2 = skillBbOf(chess, S2), b3 = skillBbOf(chess, S3);
    const g1 = gridOf(chess, S1), g3 = gridOf(chess, S3), gTalent = talentGrid(chess, 1);
    const defPen = num(t0.def_penetrate_ratio, 0.03), resPen = num(t0.magic_resist_penetrate_ratio, 0.02);
    const maxNotes = Math.max(1, Math.floor(num(t0.max_cnt, 10))), noteTtl = Math.max(0.5, num(t0.delay, 1) * 4);
    const inRangeAs = num(t1.attack_speed, 0);

    return {
      skills: {
        // S1 新月的苏醒: 8 notes, atk_scale_1..8 × ATK arts, decreasing
        [S1]: {
          kind: (chess?.skill?.maxCharges ?? 1) > 1 ? 'charges' : 'instant',
          onStart({ battle, unit }) {
            const scales = [b1.atk_scale, b1.atk_scale_2, b1.atk_scale_3, b1.atk_scale_4, b1.atk_scale_5, b1.atk_scale_6, b1.atk_scale_7, b1.atk_scale_8].map((v) => num(v, 0));
            const eat = (i) => {
              if (i >= 8 || !up(unit)) return;
              const t = battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true })[0];
              if (t && alive(t)) battle.dealDamage(unit, t, { amount: unit.s.atk * (scales[i] || 0), type: 'arts', isSkill: true, tags: ['skill', 'oblvns:s1'] });
              if (t) battle.fx('note', { x: t.x, y: t.y, id: unit.id, n: i });
              battle.after(0.12, () => eat(i + 1));
            };
            eat(0);
          },
        },
        // S2 满月的舞会: 钢琴 (ATK +attack@atk). 风琴 (ASPD +attack@attack_speed) is the documented alternative.
        [S2]: {
          kind: 'toggle',
          mods: { atkPct: num(b2['attack@atk'], 0) },
        },
        // S3 残月的余响: 25 s, range widened; a physical + an arts note per attack
        [S3]: {
          kind: 'duration',
          ...(g3 ? { targeting: { rangeGrid: g3 } } : {}),
          mods: { aspd: num(b3['attack@attack_speed'], 0) },
          attack: {
            atkScale: num(b3['attack@atk_scale'], 1.8),
            onHit({ battle, unit, target, dealt }) {
              if (target && alive(target)) battle.dealDamage(unit, target, { amount: (dealt || unit.s.atk) * num(b3['attack@atk_scale'], 1.8), type: 'arts', isSkill: true, isSplash: true, tags: ['skill', 'oblvns:s3note'] });
            },
          },
        },
      },
      talents: [
        { install(battle, unit) { // 颂乐音符: notes ⇒ 【Ave Mujica】 DEF / RES ignore
          if (!(defPen > 0 || resPen > 0)) return;
          const notes = () => unit.mem.oblvnsNotes ?? (unit.mem.oblvnsNotes = new Map());
          battle.on('deploy', (c) => { if (c.unit === unit) notes().clear(); }, { owner: unit });
          battle.on('death', (c) => { if (c.unit === unit) notes().clear(); }, { owner: unit });
          battle.on('attack', (c) => {
            if (c.attacker !== unit || !up(unit)) return;
            const id = `${unit.id}:${Math.round((battle.time || 0) * 1000)}:${notes().size}`;
            notes().set(id, 1);
            battle.after(noteTtl, () => notes().delete(id));
          }, { owner: unit });
          battle.every(0.5, () => {
            if (!up(unit)) return;
            const k = Math.min(maxNotes, notes().size);
            for (const a of battle.alliesFor(unit)) {
              if (a !== unit && !isMujica(a)) continue;
              if (k > 0) battle.addBuff(a, { key: 'oblvns:notes', mods: { defIgnorePct: defPen * k, resIgnorePct: resPen * k }, duration: 1.0, refresh: 'replace', source: unit, visible: true });
              else battle.removeBuff(a, 'oblvns:notes');
            }
          }, { owner: unit });
        } },
        { install(battle, unit) { // 毋畏遗忘: 攻击范围内干员攻击速度 +attack_speed (Fever is [ASSUMED] skipped)
          const grid = gTalent ?? g1 ?? null;
          if (!(inRangeAs > 0) || !grid) return;
          battle.every(0.5, () => {
            if (!up(unit)) return;
            const keys = new Set(absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0));
            for (const a of battle.alliesFor(unit)) {
              if (a !== unit && !(a.kind === 'op' && bodyInKeys(a, keys))) continue;
              battle.addBuff(a, { key: 'oblvns:fever', mods: { aspd: inRangeAs }, duration: 1.0, refresh: 'replace', source: unit, visible: true });
            }
          }, { owner: unit });
        } },
      ],
    };
  },
};
