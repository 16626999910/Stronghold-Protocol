// server/match/match/relics.js — 无尽狂潮 肉鸽化 (author 2026-10-12): 藏品 (Relic) / 专属盟约 / 通用决策 的数据与
// 效果聚合。藏品 = 现有装备 (沿用原名/图标/品阶)，获得即全局生效、与盟约联动。
// 节拍 (ENDLESS.RELIC_EVERY / DECISION_EVERY): 每 2 关 1 个藏品 (3 选 1)、每 5 关 1 次通用决策 (3 选 1)、第 1 回合专属 8 选 1。
//
// 效果 schema (一条 = 一个藏品/决策):
//   { id (装备 id), name, rarity: 'white'|'blue'|'gold'|'color', bond?,
//     atk?, hp?,                       // 全队攻击/生命 +x (小数)
//     funds?,                          // 每回合额外资金
//     layers?: { n, scope },           // 每回合给层数; scope: 'active'|'core'|'top'|<bondId>
//     perActiveAtk?, perActiveHp?,     // 每有 1 个已激活盟约 +x
//     perTopAtk?, perTopHp? }          // 每 1 点「层数最高的盟约层数」+x
//
// 物品 id: 用装备的普通版 (_a)。客户端按 gd.item(id) 取原名/图标；效果文本由服务端下发。

/** 掉落权重 (白/蓝/金/彩) 按回合。彩 (炫彩) 很稀有 (作者 2026-10-12 再次下调)。 */
export function relicWeights(round) {
  return (Number(round) || 0) >= 20
    ? { white: 44, blue: 36, gold: 18, color: 2 }
    : { white: 58, blue: 33, gold: 8.5, color: 0.5 };
}

/**
 * 藏品池 (每 RELIC_EVERY 关 3 选 1)。核心盟约专属藏品 = 彩 (bond 字段非空)。
 * 设计 (作者 2026-10-12, 最终): **攻/血/防的数值只由「核心盟约(专属)」提供** (专属的 perTop* 随层数成长);
 * **其它所有藏品只给「盟约叠层」** (`layers`, 或少量资金) —— 藏品的作用是把层数堆起来, 让核心盟约的数值滚大。
 *   layers.scope: 'active' = 每条已激活盟约 / 'core' = 核心盟约 / 'top' = 层数最高的盟约 / <bondId> = 指定盟约
 */
export const RELICS = Object.freeze([
  // —— 核心盟约专属 (彩): 给本命盟约大量层数 ——
  { id: 'chess_item_3_04_e_a', name: '炎国短刀',     rarity: 'color', bond: 'yanShip',         layers: { n: 9, scope: 'yanShip' } },
  { id: 'chess_item_2_04_e_a', name: '萨尔贡浓茶',   rarity: 'color', bond: 'sargonShip',      layers: { n: 9, scope: 'sargonShip' } },
  { id: 'chess_item_1_01_e_a', name: '维式重锤',     rarity: 'color', bond: 'victoriaShip',    layers: { n: 9, scope: 'victoriaShip' } },
  { id: 'chess_item_5_02_e_a', name: '谢拉格不融冰', rarity: 'color', bond: 'kjeragShip',      layers: { n: 9, scope: 'kjeragShip' } },
  { id: 'chess_item_4_08_e_a', name: '拉特兰桥夹',   rarity: 'color', bond: 'lateranoShip',    layers: { n: 9, scope: 'lateranoShip' } },
  { id: 'chess_item_3_07_e_a', name: '阿戈尔重刃',   rarity: 'color', bond: 'egirShip',        layers: { n: 9, scope: 'egirShip' } },
  { id: 'chess_item_3_01_e_a', name: '叙拉古正装',   rarity: 'color', bond: 'siracusaShip',    layers: { n: 9, scope: 'siracusaShip' } },
  { id: 'chess_item_4_07_e_a', name: '卡西米尔竞技旗', rarity: 'color', bond: 'kazimierzShip', layers: { n: 9, scope: 'kazimierzShip' } },
  // —— 共鸣 / 通用 (白/蓝/金): 一律给层数 (少量经济除外) ——
  { id: 'chess_item_1_03_e_a', name: '盟约之币',     rarity: 'white', layers: { n: 1, scope: 'active' } },
  { id: 'chess_item_1_05_e_a', name: '源石溶剂',     rarity: 'white', layers: { n: 1, scope: 'top' } },
  { id: 'chess_item_6_07_e_a', name: '黄沙罗盘',     rarity: 'gold',  layers: { n: 3, scope: 'top' } },
  { id: 'chess_item_6_08_e_a', name: '人事部文档',   rarity: 'gold',  layers: { n: 3, scope: 'active' } },
  { id: 'chess_item_6_05_e_a', name: '蒸汽之心',     rarity: 'gold',  layers: { n: 4, scope: 'active' } },
  { id: 'chess_item_2_07_e_a', name: '见钱眼开玩偶', rarity: 'white', funds: 3 },
  // —— 联动: 成套/收藏 (给层数; 经济类给资金) ——
  { id: 'chess_item_3_12_e_a', name: '骑士储蓄罐', rarity: 'gold',  funds: 3 },
  { id: 'chess_item_4_11_e_a', name: '护盾无人机', rarity: 'blue',  layers: { n: 2, scope: 'active' } },
  { id: 'chess_item_3_02_e_a', name: '精准狙击镜', rarity: 'gold',  layers: { n: 2, scope: 'top' } },
  { id: 'chess_item_1_04_e_a', name: '随身身份牌', rarity: 'white', layers: { n: 2, scope: 'top' } },
  { id: 'chess_item_3_06_e_a', name: '歌利亚头盔', rarity: 'blue',  layers: { n: 2, scope: 'active' } },
  { id: 'chess_item_3_11_e_a', name: '突袭手雷',   rarity: 'gold',  layers: { n: 2, scope: 'top' } },
  { id: 'chess_item_1_02_e_a', name: '坚守盾牌',   rarity: 'blue',  layers: { n: 2, scope: 'active' } },
  { id: 'chess_item_2_03_e_a', name: '战栗维式重锤', rarity: 'gold', layers: { n: 2, scope: 'top' } },
  // —— 通用彩色 (彩, 非专属): 给层数 (比普通藏品更多) ——
  { id: 'chess_item_6_10_e_a', name: '骑士戒律',     rarity: 'color', layers: { n: 4, scope: 'active' } },
  { id: 'chess_item_6_01_e_a', name: '天马之枪',     rarity: 'color', layers: { n: 3, scope: 'active' } },
  { id: 'chess_item_6_03_e_a', name: '天师古鼎',     rarity: 'color', layers: { n: 4, scope: 'active' } },
  { id: 'chess_item_6_04_e_a', name: '海沟实验体',   rarity: 'color', layers: { n: 4, scope: 'active' } },
  { id: 'chess_item_6_06_e_a', name: '耶拉冈德之泪', rarity: 'color', layers: { n: 4, scope: 'top' } },
  { id: 'chess_item_6_02_e_a', name: '铳骑之威',     rarity: 'color', layers: { n: 3, scope: 'top' } },
  { id: 'chess_item_6_11_e_a', name: '家族徽章',     rarity: 'color', layers: { n: 3, scope: 'active' } },
  { id: 'chess_item_6_09_e_a', name: '变形同构体',   rarity: 'color', layers: { n: 3, scope: 'active' } },
  // —— 补强 / 经济 (更有趣的叠层方向: 补最弱盟约 / 给全部核心 / 每回合资金) ——
  { id: 'chess_item_4_05_e_a', name: '防暴盾',       rarity: 'blue',  layers: { n: 5, scope: 'lowest' } }, // 给「层数最低的盟约」补层
  { id: 'chess_item_5_03_e_a', name: '双模机械臂',   rarity: 'gold',  layers: { n: 2, scope: 'core' } },   // 给「所有核心盟约」铺层
  { id: 'chess_item_2_02_e_a', name: '紧急调度券',   rarity: 'white', layers: { n: 3, scope: 'lowest' } },
  { id: 'chess_item_2_05_e_a', name: '精打细算玩偶', rarity: 'white', funds: 4 },                          // 每回合 +4 资金
  // —— 触发式 (author 2026-10-13, 参考 Brotato/杀戮尖塔): 随机补层 + 按藏品品阶给资金 ——
  { id: 'chess_item_5_05_e_a', name: '命运骰子',     rarity: 'gold',  icon: 'trap_1072_acarm072', layers: { n: 6, scope: 'random' } },       // 突变细胞 // 每回合随机给一个已激活盟约 +6 层
  { id: 'chess_item_4_03_e_a', name: '华彩礼盒',     rarity: 'blue',  icon: 'trap_1074_acarm074', perColorFunds: 6, perGoldFunds: 2 },      // 商业包装方案 // 按藏品品阶滚雪球资金
  // —— 扩充 (author 2026-10-13): 18 种新藏品, 按稀有度分配 —— 彩 ×7 / 金 ×4 / 蓝 ×4 / 白 ×3 ——
  // 彩 (炫彩): 高价值叠层 / 经济
  { id: 'chess_item_5_09_e_a', name: '天马之盔',       rarity: 'color', layers: { n: 5, scope: 'top' } },
  { id: 'chess_item_3_08_e_a', name: '奥术法阵',       rarity: 'color', layers: { n: 5, scope: 'top' } },
  { id: 'chess_item_5_06_e_a', name: '博士投影',       rarity: 'color', layers: { n: 4, scope: 'core' } },
  { id: 'chess_item_4_12_e_a', name: 'M3茧甲',         rarity: 'color', layers: { n: 4, scope: 'active' } },
  { id: 'chess_item_5_08_e_a', name: '突变细胞',       rarity: 'color', layers: { n: 6, scope: 'random' } },
  { id: 'chess_item_5_04_e_a', name: '信标',           rarity: 'color', funds: 5 },
  { id: 'chess_item_5_07_e_a', name: '商业包装方案',   rarity: 'color', perColorFunds: 4, perGoldFunds: 2 },
  // 金 (传说): 中等叠层 / 资金
  { id: 'chess_item_4_09_e_a', name: '灼燃维式重锤',   rarity: 'gold',  layers: { n: 3, scope: 'top' } },
  { id: 'chess_item_3_09_e_a', name: '坚固维式重锤',   rarity: 'gold',  layers: { n: 3, scope: 'lowest' } },
  { id: 'chess_item_4_01_e_a', name: '寻呼模块',       rarity: 'gold',  layers: { n: 2, scope: 'active' } },
  { id: 'chess_item_3_05_e_a', name: '迅捷作战粮',     rarity: 'gold',  funds: 5 },
  // 蓝 (稀有): 小叠层
  { id: 'chess_item_3_10_e_a', name: '加速维式重锤',   rarity: 'blue',  layers: { n: 3, scope: 'top' } },
  { id: 'chess_item_2_01_e_a', name: '不屈弹射器',     rarity: 'blue',  layers: { n: 3, scope: 'lowest' } },
  { id: 'chess_item_3_03_e_a', name: '激光发射器',     rarity: 'blue',  layers: { n: 2, scope: 'top' } },
  { id: 'chess_item_4_02_e_a', name: '蜂鸣器',         rarity: 'blue',  layers: { n: 2, scope: 'random' } },
  // 白 (普通): 微叠层 / 小额资金
  { id: 'chess_item_4_04_e_a', name: '伪装服',         rarity: 'white', layers: { n: 1, scope: 'active' } },
  { id: 'chess_item_4_10_e_a', name: '浓缩嗅盐',       rarity: 'white', layers: { n: 2, scope: 'lowest' } },
  { id: 'chess_item_4_06_e_a', name: '休眠子裔',       rarity: 'white', funds: 2 },
]);

/** 通用决策 (每 5 关 3 选 1)。icon = 官方素材图标 id (trap_...; 客户端 itemIconUrl 解析)。 */
export const GENERAL_DECISIONS = Object.freeze([
  { key: 'lever',     name: '坎诺特的杠杆',   rarity: 'gold',  icon: 'trap_1077_acarm077', layers: { n: 5, scope: 'top' }, atk: 0.20 }, // 天师古鼎
  { key: 'unity',     name: '罗德岛同盟',     rarity: 'blue',  icon: 'trap_1124_acarm124', perActiveAtk: 0.08, perActiveHp: 0.08 }, // 随身身份牌
  { key: 'simmer',    name: '文火慢炖',       rarity: 'gold',  icon: 'trap_1050_acarm050', layers: { n: 20, scope: 'top' } },      // 萨尔贡浓茶
  { key: 'sacrifice', name: '崇高牺牲',       rarity: 'blue',  icon: 'trap_1056_acarm056', layers: { n: 6, scope: 'top' } },       // 不屈弹射器
  { key: 'morph',     name: '变形同构',       rarity: 'blue',  icon: 'trap_1073_acarm073', layers: { n: 2, scope: 'active' } },    // 变形同构体
  { key: 'ladder',    name: '层层递进',       rarity: 'blue',  icon: 'trap_1052_acarm052', layers: { n: 2, scope: 'active' } },    // 有限加速器
  { key: 'sandpile',  name: '聚沙成塔',       rarity: 'blue',  icon: 'trap_1074_acarm074', perActiveAtk: 0.08, perActiveHp: 0.08 },// 商业包装方案
  { key: 'warmachine',name: '战争机器',       rarity: 'blue',  icon: 'trap_1067_acarm067', atk: 0.15 },                          // 双模机械臂
  { key: 'midas',     name: '点石成金',       rarity: 'blue',  icon: 'trap_1108_acdisney', funds: 8 },                           // 「神秘顾客」
  { key: 'bullseye',  name: '一发入魂',       rarity: 'blue',  icon: 'trap_1063_acarm063', atk: 0.10 },                          // 精准狙击镜
  { key: 'veteran',   name: '越战越勇',       rarity: 'gold',  icon: 'trap_1111_acchal',   atk: 0.20 },                          // 教鞭
  { key: 'warbooty',  name: '以战养战',       rarity: 'white', icon: 'trap_1109_acarm109', funds: 5 },                           // 信标
  { key: 'allout',    name: '全军出击',       rarity: 'white', icon: 'trap_1064_acarm064', atk: 0.25 },                          // 突袭手雷
  { key: 'fortify',   name: '坚壁清野',       rarity: 'white', icon: 'trap_1060_acarm060', hp: 0.25 },                           // 防暴盾
  { key: 'fieldcraft',name: '战地补给',       rarity: 'blue',  icon: 'trap_1051_acarm051', hp: 0.20 },                           // 迅捷作战粮
  { key: 'steel',     name: '钢铁洪流（兜底）', rarity: 'white', icon: 'trap_1043_acarm043', atk: 0.35 },                          // 坚固维式重锤
  // —— 联动型决策 (author 2026-10-12): 与藏品/其它决策相乘 ——
  { key: 'collector', name: '收藏家',         rarity: 'gold',  icon: 'trap_1110_accopy',   perRelicAtk: 0.02, perRelicHp: 0.02 }, // 画卷 // 藏品越多越强
  { key: 'convoy',    name: '后勤运输',       rarity: 'white', icon: 'trap_1075_acarm075', funds: 2, perDecisionFunds: 2 },       // 寻呼模块 // 决策越多钱越多
  { key: 'unison',    name: '同心协力',       rarity: 'blue',  icon: 'trap_1122_acarm122', perDecisionAtk: 0.05, perDecisionHp: 0.05 }, // 家族徽章 // 决策越多越强
  // —— 取舍 / 构筑型决策 (参考 Brotato / 杀戮尖塔: 有代价的强力增益) ——
  { key: 'allin',     name: '孤注一掷',       rarity: 'blue',  icon: 'trap_1042_acarm042', atk: 0.60, hp: -0.20 },   // 灼燃维式重锤 // 攻大增、血减
  { key: 'glass',     name: '玻璃大炮',       rarity: 'gold',  icon: 'trap_1053_acarm053', dmg: 0.50, hp: -0.35 },   // 激光发射器 // 造成伤害大增、血大减
  { key: 'tycoon',    name: '一夜暴富',       rarity: 'blue',  icon: 'trap_1123_acarm123', funds: 20, atk: -0.15 },  // 骑士储蓄罐 // 每回合巨量资金、攻小减
  { key: 'hoarder',   name: '收藏癖',         rarity: 'white', icon: 'trap_1110_accopy',   perRelicFunds: 1, perRelicAtk: 0.012 }, // 画卷 // 每件藏品→资金+攻
  { key: 'momentum',  name: '势不可挡',       rarity: 'blue',  icon: 'trap_1120_acarm120', atk: 0.15, hp: 0.15 },     // 骑士戒律 // 攻守双加 (小)
  // —— 阈值条件决策 (author 2026-10-13, 参考 杀戮尖塔「条件牌」): 满足条件才结算强力收益 ——
  { key: 'collector_grand', name: '收藏家·大', rarity: 'gold',  icon: 'trap_1103_acarm103', minRelics: 8,  condAtk: 0.30, condHp: 0.30 }, // 黄沙罗盘 // 藏品多才强
  { key: 'color_fanatic',   name: '炫彩狂热',   rarity: 'gold',  icon: 'trap_1118_acarm118', minColor: 2,   condAtk: 0.40, condHp: 0.20 }, // 天马之盔 // 炫彩藏品 ≥2
  { key: 'specialist',      name: '术业专精',   rarity: 'blue',  icon: 'trap_1120_acarm120', maxActive: 3,  condAtk: 0.35, condHp: 0.35 }, // 骑士戒律 // 只玩少数盟约
  { key: 'solidarity',      name: '众志成城',   rarity: 'blue',  icon: 'trap_1121_acarm121', minActive: 6,  condAtk: 0.25, condHp: 0.25 }, // 叙拉古正装 // 铺满盟约
  { key: 'apex',            name: '登峰造极',   rarity: 'gold',  icon: 'trap_1110_accopy',   minTop: 200,   condLayers: 12, condAtk: 0.15 }, // 画卷 // 层数冲高
  // —— 层数里程碑 (author 2026-10-13): 最高盟约每涨 100 层 → 一档攻/血 (越叠越强, 无上限) ——
  { key: 'milestone',       name: '步步为营',   rarity: 'gold',  icon: 'trap_1052_acarm052', stepTop: 100, perStepAtk: 0.05, perStepHp: 0.03 }, // 有限加速器
  // —— 战斗内核触发 (author 2026-10-13): 效果落到战斗 flags, 由 sim 在对应时机结算 ——
  { key: 'executioner',     name: '处决者',     rarity: 'gold',  icon: 'trap_1076_acarm076', exec: { thresh: 0.30, mul: 1.6 } },        // 铳骑之威 // 斩杀: 对残血敌人造成伤害 ×1.6
  { key: 'rampage',         name: '杀戮成长',   rarity: 'gold',  icon: 'trap_1045_acarm045', rampage: { perKill: 0.04, max: 0.80 } },   // 战栗维式重锤 // 每击杀 → 全队攻击 (战斗内叠加)
]);

/**
 * 核心盟约专属决策 (第 1 回合 3 选 1 · 彩 · 互斥) —— 一局的「本命核心」: 不是一个大号彩藏品, 而是一台随回合滚雪球的引擎。
 * 三件套 (每一条都长在「本命盟约」上, 藏品给不了):
 *   ① `layers { n, scope: <本命> }` 每回合固定给本命盟约 +n 层 (保底成长);
 *   ② `layerMul` 把本命盟约的**一切层数获取 ×倍** (每回合的、战斗内的、天赋/羁绊的 —— 全局滚雪球);
 *   ③ `startLayers` 选中即给一笔启动层数;
 * 外加各盟约按自身机制决定的全队收益 (炎/拉特兰/叙拉古=攻击随层数, 阿戈尔/谢拉格=生命随层数, 萨尔贡=技能经济, 维多利亚=装备经济)。
 * `perTopAtk/Hp` 按「最高盟约层数」线性放大 —— 层数越高越强, 是全局核心而非平铺数值。
 */
export const EXCLUSIVE_DECISIONS = Object.freeze([
  { bond: 'yanShip',       name: '赤霄·出鞘',       layers: { n: 12, scope: 'yanShip' },      layerMul: 2, startLayers: 20, perTopAtk: 0.015, perTopHp: 0.015 },
  { bond: 'sargonShip',    name: '沙王的敕令',      layers: { n: 12, scope: 'sargonShip' },   layerMul: 2, startLayers: 20, perTopAtk: 0.011, perTopHp: 0.011, funds: 3 },
  { bond: 'victoriaShip',  name: '维多利亚的荣光',  layers: { n: 12, scope: 'victoriaShip' }, layerMul: 2, startLayers: 20, perTopAtk: 0.013, perTopHp: 0.013, perTopDef: 0.15, funds: 4 },
  { bond: 'kjeragShip',    name: '耶拉冈德的低语',  layers: { n: 12, scope: 'kjeragShip' },   layerMul: 2, startLayers: 20, perTopAtk: 0.015, perTopHp: 0.015 },
  { bond: 'lateranoShip',  name: '圣城齐射',        layers: { n: 12, scope: 'lateranoShip' }, layerMul: 2, startLayers: 20, perTopAtk: 0.015, perTopHp: 0.015 },
  { bond: 'egirShip',      name: '溟痕',            layers: { n: 12, scope: 'egirShip' },     layerMul: 2, startLayers: 20, perTopAtk: 0.016, perTopHp: 0.016 },
  { bond: 'siracusaShip',  name: '家族之夜',        layers: { n: 12, scope: 'siracusaShip' }, layerMul: 2, startLayers: 20, perTopAtk: 0.014, perTopHp: 0.014 },
  { bond: 'kazimierzShip', name: '大骑士领',        layers: { n: 12, scope: 'kazimierzShip' },layerMul: 2, startLayers: 20, perTopAtk: 0.008, perTopHp: 0.008, perTopDef: 0.2 },
]);

const CORE_BONDS = EXCLUSIVE_DECISIONS.map((d) => d.bond);

/** 盟约 id → 中文名 (下发文本里用中文, 不要出现英文 id)。 */
export const BOND_NAME = Object.freeze({
  yanShip: '炎', sargonShip: '萨尔贡', victoriaShip: '维多利亚', kjeragShip: '谢拉格',
  lateranoShip: '拉特兰', egirShip: '阿戈尔', siracusaShip: '叙拉古', kazimierzShip: '卡西米尔',
});

/**
 * 套装 / 联动 (author 2026-10-12): 集齐 `ids` 里的全部条目 (藏品 id 或决策 key) → 触发一次加成。
 * 与「单件」效果不同, 组合奖励**只算一次** (藏一家/凑一套), 且可以有多种机制: 攻/血/防/伤害/资金/每回合层数。
 * 例: 剑盾护体 = 坚守盾牌 + 战栗维式重锤 → 全队防御 +200、造成伤害 +10%。
 */
export const COMBOS = Object.freeze([
  { key: 'sword_shield', name: '剑盾护体', ids: ['chess_item_1_02_e_a', 'chess_item_2_03_e_a'], layers: { n: 5, scope: 'active' } },
  { key: 'blast_pair',   name: '精准爆破', ids: ['chess_item_3_02_e_a', 'chess_item_3_11_e_a'], layers: { n: 4, scope: 'top' } },
  { key: 'glacier_forge', name: '冰川锻造', ids: ['chess_item_5_02_e_a', 'chess_item_4_09_e_a'], layers: { n: 5, scope: 'active' } },
  { key: 'resonance_core', name: '共鸣核心', ids: ['chess_item_6_03_e_a', 'chess_item_6_09_e_a'], layers: { n: 5, scope: 'active' } },
  { key: 'merchant_league', name: '商会同盟', ids: ['chess_item_3_12_e_a', 'convoy', 'collector'], funds: 12 },
  { key: 'deep_sea',     name: '深海意志', ids: ['chess_item_6_04_e_a', 'chess_item_4_11_e_a'], layers: { n: 5, scope: 'active' } },
  { key: 'sand_caravan', name: '荒原商队', ids: ['chess_item_2_07_e_a', 'convoy'], funds: 8, layers: { n: 3, scope: 'top' } },
  // —— 三件套 / 决策组合 (author 2026-10-13): 围绕「阈值条件 / 取舍 / 经济」三条构筑线 ——
  { key: 'collector_set', name: '收藏大家', ids: ['collector_grand', 'collector', 'hoarder'], atk: 0.10, layers: { n: 4, scope: 'active' } },
  { key: 'economy_set',   name: '精算之道', ids: ['tycoon', 'convoy', 'midas'], funds: 12 },
  { key: 'all_in_set',    name: '破釜沉舟', ids: ['allin', 'glass'], dmg: 0.15, layers: { n: 4, scope: 'top' } },
  { key: 'apex_climb',    name: '直上青云', ids: ['apex', 'simmer', 'ladder'], layers: { n: 6, scope: 'top' } },
]);

/** 一个条目 (藏品有 id / 决策有 key) 的键。 */
const entryKey = (def) => (def && (def.id || def.key)) || null;

/** 条目键 → 中文名 (藏品 find RELICS, 决策 find GENERAL_DECISIONS)。 */
export function nameOfEntry(id) {
  const r = RELICS.find((d) => d.id === id);
  if (r) return r.name;
  const d = GENERAL_DECISIONS.find((x) => x.key === id);
  return d ? d.name : id;
}

/** 组合的文字描述 (「全队防御 +200、造成伤害 +10%…」)。 */
export function comboText(c) {
  const parts = [];
  if (c.layers) {
    const s = c.layers.scope;
    const who = s === 'active' ? '所有已激活盟约' : s === 'top' ? '层数最高的盟约' : `【${BOND_NAME[s] || s}】`;
    parts.push(`每回合，${who} +${c.layers.n} 层`);
  }
  if (c.atk) parts.push(`全队攻击 +${Math.round(c.atk * 100)}%`);
  if (c.hp) parts.push(`全队生命 +${Math.round(c.hp * 100)}%`);
  if (c.def) parts.push(`全队防御 +${c.def}`);
  if (c.dmg) parts.push(`全队造成伤害 +${Math.round(c.dmg * 100)}%`);
  if (c.funds) parts.push(`每回合资金 +${c.funds}`);
  return parts.join('、') || '—';
}

/** 该条目所属的组合 (用于卡面文本提示「凑齐 X + Y」)。 */
export function combosOfEntry(def) {
  const k = entryKey(def);
  return k ? COMBOS.filter((c) => c.ids.includes(k)) : [];
}

/** 集齐全部 ids 的组合 (玩家当前拥有的 entries 里判定)。 */
export function activeCombos(entries) {
  const has = (id) => entries.some((e) => e.def && e.count > 0 && entryKey(e.def) === id);
  return COMBOS.filter((c) => c.ids.every(has));
}

/**
 * 阈值条件 (author 2026-10-13, 参考 杀戮尖塔「条件牌」): 一条藏品/决策可带 `minRelics/minColor/minActive/maxActive/minTop`
 * 之一或多个; 全部满足时, 才结算其 `condAtk/condHp/condDef/condDmg/condFunds/condLayers` 收益。
 * `c` = condCtx(ps, entries) 的结果。
 */
export function condMet(def, c) {
  if (!def || !c) return false;
  if (def.minRelics != null && !(c.relicCount >= def.minRelics)) return false;
  if (def.minColor != null && !(c.colorCount >= def.minColor)) return false;
  if (def.minActive != null && !(c.activeCount >= def.minActive)) return false;
  if (def.maxActive != null && !(c.activeCount <= def.maxActive)) return false;
  if (def.minTop != null && !(c.top >= def.minTop)) return false;
  return true;
}

/** 条件求值的上下文: 藏品总数 / 炫彩藏品数 / 已激活盟约数 / 最高盟约层数。 */
export function condCtx(ps, entries) {
  const { activeCount, top } = bondStats(ps);
  let relicCount = 0, colorCount = 0;
  for (const { def, count } of entries) {
    if (!def || !(count > 0) || !def.id) continue;
    relicCount += count;
    if (def.rarity === 'color') colorCount += count;
  }
  return { relicCount, colorCount, activeCount, top };
}

/** 摘要文本 (下发客户端展示用)。 */
export function relicText(def) {
  const parts = [];
  if (def.layers) {
    const s = def.layers.scope;
    const who = s === 'active' ? '所有已激活盟约' : s === 'core' ? '所有核心盟约' : s === 'top' ? '层数最高的盟约' : s === 'lowest' ? '层数最低的盟约' : s === 'random' ? '随机一个已激活盟约' : `【${BOND_NAME[s] || s}】`;
    parts.push(`每回合，${who} +${def.layers.n} 层`);
  }
  if (def.layerMul > 1) parts.push(`【${BOND_NAME[def.bond] || def.bond}】获得的一切层数 ×${def.layerMul}`);
  if (def.startLayers) parts.push(`选中即获得 ${def.startLayers} 层`);
  if (def.perActiveAtk || def.perActiveHp) parts.push(`每有 1 个已激活盟约，全队攻/血 +${Math.round((def.perActiveAtk || def.perActiveHp) * 100)}%`);
  if (def.perTopAtk || def.perTopHp) parts.push(`每 1 点最高盟约层数，全队攻/血 +${((def.perTopAtk || def.perTopHp) * 100).toFixed(1)}%`);
  if (def.perTopDef) parts.push(`每 1 点最高盟约层数，全队防御 +${def.perTopDef}`);
  if (def.perRelicAtk) parts.push(`每拥有 1 件藏品，全队攻击 +${Math.round(def.perRelicAtk * 100)}%`);
  if (def.perRelicHp) parts.push(`每拥有 1 件藏品，全队生命 +${Math.round(def.perRelicHp * 100)}%`);
  if (def.perRelicFunds) parts.push(`每拥有 1 件藏品，每回合资金 +${def.perRelicFunds}`);
  if (def.stepTop) {
    const bits = [];
    if (def.perStepAtk) bits.push(`攻击 +${Math.round(def.perStepAtk * 100)}%`);
    if (def.perStepHp) bits.push(`生命 +${Math.round(def.perStepHp * 100)}%`);
    if (def.perStepDef) bits.push(`防御 +${def.perStepDef}`);
    if (def.perStepFunds) bits.push(`资金 +${def.perStepFunds}`);
    parts.push(`每 ${def.stepTop} 层最高盟约，全队${bits.join('、')}`);
  }
  if (def.perColorFunds) parts.push(`每件炫彩藏品，每回合资金 +${def.perColorFunds}`);
  if (def.perGoldFunds) parts.push(`每件传说藏品，每回合资金 +${def.perGoldFunds}`);
  if (def.perDecisionAtk) parts.push(`每拥有 1 个决策，全队攻击 +${Math.round(def.perDecisionAtk * 100)}%`);
  if (def.perDecisionHp) parts.push(`每拥有 1 个决策，全队生命 +${Math.round(def.perDecisionHp * 100)}%`);
  if (def.perDecisionFunds) parts.push(`每拥有 1 个决策，每回合资金 +${def.perDecisionFunds}`);
  if (def.pairWith) {
    const nm = RELICS.find((r) => r.id === def.pairWith)?.name || def.pairWith;
    const bits = [];
    if (def.pairAtk) bits.push(`攻击 +${Math.round(def.pairAtk * 100)}%`);
    if (def.pairHp) bits.push(`生命 +${Math.round(def.pairHp * 100)}%`);
    if (def.pairDef) bits.push(`防御 +${def.pairDef}`);
    if (def.pairDmg) bits.push(`造成伤害 +${Math.round(def.pairDmg * 100)}%`);
    if (bits.length) parts.push(`与【${nm}】同持时，全队${bits.join('、')}`);
  }
  if (def.atk) parts.push(`全队攻击 +${Math.round(def.atk * 100)}%`);
  if (def.hp) parts.push(`全队生命 +${Math.round(def.hp * 100)}%`);
  if (def.def) parts.push(`全队防御 +${def.def}`);
  if (def.dmg) parts.push(`全队造成伤害 +${Math.round(def.dmg * 100)}%`);
  if (def.funds) parts.push(`每回合资金 +${def.funds}`);
  // 阈值条件 (达成才结算 cond* 收益)
  const condBits = [];
  if (def.minRelics != null) condBits.push(`持有 ≥${def.minRelics} 件藏品`);
  if (def.minColor != null) condBits.push(`持有 ≥${def.minColor} 件炫彩藏品`);
  if (def.minActive != null) condBits.push(`激活 ≥${def.minActive} 个盟约`);
  if (def.maxActive != null) condBits.push(`激活 ≤${def.maxActive} 个盟约`);
  if (def.minTop != null) condBits.push(`最高盟约 ≥${def.minTop} 层`);
  if (condBits.length) parts.push(`【条件】${condBits.join(' + ')}`);
  if (def.condAtk) parts.push(`达成条件时，全队攻击 +${Math.round(def.condAtk * 100)}%`);
  if (def.condHp) parts.push(`达成条件时，全队生命 +${Math.round(def.condHp * 100)}%`);
  if (def.condDef) parts.push(`达成条件时，全队防御 +${def.condDef}`);
  if (def.condDmg) parts.push(`达成条件时，全队造成伤害 +${Math.round(def.condDmg * 100)}%`);
  if (def.condFunds) parts.push(`达成条件时，每回合资金 +${def.condFunds}`);
  if (def.condLayers) parts.push(`达成条件时，每回合给层数最高的盟约 +${def.condLayers} 层`);
  // 战斗内核触发 (落到战斗 flags)
  if (def.exec) parts.push(`对生命低于 ${Math.round(def.exec.thresh * 100)}% 的敌人，造成伤害 ×${def.exec.mul}`);
  if (def.rampage) parts.push(`每击杀 1 个敌人，全队攻击 +${Math.round(def.rampage.perKill * 100)}%（上限 +${Math.round(def.rampage.max * 100)}%）`);
  // 组合提示: 该条目所属的套装 (凑齐触发)
  for (const c of combosOfEntry(def)) {
    const others = c.ids.filter((id) => id !== (def.id || def.key)).map(nameOfEntry).join(' ＋ ');
    parts.push(`【组合·${c.name}】与 ${others} 同持 → ${comboText(c)}`);
  }
  return parts.join('；') || '—';
}

const isActive = (ps, id) => !!(ps.bonds && ps.bonds[id] && ps.bonds[id].active);
const layersOf = (ps, id) => (ps.layers && Number(ps.layers[id])) || 0;

/** 已激活盟约数 / 最高层数 (用于 perActive* / perTop*)。 */
function bondStats(ps) {
  let activeCount = 0, top = 0;
  for (const id of Object.keys(ps.bonds || {})) {
    if (ps.bonds[id] && ps.bonds[id].active) activeCount += 1;
    const l = layersOf(ps, id);
    if (l > top) top = l;
  }
  return { activeCount, top };
}

/** 层数目标盟约 (给 layers.scope 求值): 返回 bondId 或 null。 */
function layerTarget(ps, scope) {
  if (!scope) return null;
  if (scope === 'active' || scope === 'core') {
    // 简化: 优先最高层的已激活盟约; 无则 null (给「所有已激活」v2 再逐条)
    let best = null, bl = -1;
    for (const id of Object.keys(ps.bonds || {})) {
      if (scope === 'core' && !CORE_BONDS.includes(id)) continue;
      if (!isActive(ps, id)) continue;
      const l = layersOf(ps, id);
      if (l > bl) { bl = l; best = id; }
    }
    return best;
  }
  if (scope === 'top' || scope === 'lowest') {
    let best = null, bl = scope === 'top' ? -1 : Infinity;
    for (const id of Object.keys(ps.bonds || {})) {
      if (!isActive(ps, id)) continue;
      const l = layersOf(ps, id);
      if (scope === 'top' ? l > bl : l < bl) { bl = l; best = id; }
    }
    return best;
  }
  return scope; // a bondId
}

/** 一套「藏品/决策」(def + 叠层 count) 聚合成全队攻/血 % 与每回合资金。 */
export function aggregateStats(ps, entries) {
  const { activeCount, top } = bondStats(ps);
  // 联动: 藏品总数 / 决策总数 (藏品有 id, 决策有 key; 专属盟约两者皆无 → 不计)
  let relicCount = 0, decisionCount = 0, colorCount = 0, goldCount = 0;
  for (const { def, count } of entries) {
    if (!def || !(count > 0)) continue;
    if (def.id) { relicCount += count; if (def.rarity === 'color') colorCount += count; else if (def.rarity === 'gold') goldCount += count; }
    if (def.key) decisionCount += count;
  }
  const cond = { relicCount, colorCount, activeCount, top };
  const owned = (id) => entries.some((e) => e.def && e.def.id === id && e.count > 0);
  let atk = 0, hp = 0, def0 = 0, dmg = 0, funds = 0;
  for (const { def, count } of entries) {
    if (!def || !(count > 0)) continue;
    atk += (def.atk || 0) * count;
    hp += (def.hp || 0) * count;
    def0 += (def.def || 0) * count;   // 全队防御 +平铺
    dmg += (def.dmg || 0) * count;    // 全队造成伤害 +x (小数)
    funds += (def.funds || 0) * count;
    if (def.perActiveAtk) atk += def.perActiveAtk * activeCount * count;
    if (def.perActiveHp) hp += def.perActiveHp * activeCount * count;
    if (def.perTopAtk) atk += def.perTopAtk * top * count;
    if (def.perTopHp) hp += def.perTopHp * top * count;
    if (def.perTopDef) def0 += def.perTopDef * top * count;   // 全队防御 随最高盟约层数 (平铺/层)
    // 收藏联动 (每件藏品) / 决策联动 (每个决策) —— 跨藏品/决策的成长
    if (def.perRelicAtk) atk += def.perRelicAtk * relicCount * count;
    if (def.perRelicHp) hp += def.perRelicHp * relicCount * count;
    if (def.perRelicFunds) funds += def.perRelicFunds * relicCount * count;
    // 层数里程碑 (每 stepTop 点最高盟约层数 → 一档收益)
    if (def.stepTop > 0) {
      const steps = Math.floor(top / def.stepTop);
      if (steps > 0) {
        atk += (def.perStepAtk || 0) * steps * count;
        hp += (def.perStepHp || 0) * steps * count;
        def0 += (def.perStepDef || 0) * steps * count;
        funds += (def.perStepFunds || 0) * steps * count;
      }
    }
    // 按藏品品阶给资金 (炫彩/传说)
    if (def.perColorFunds) funds += def.perColorFunds * colorCount * count;
    if (def.perGoldFunds) funds += def.perGoldFunds * goldCount * count;
    if (def.perDecisionAtk) atk += def.perDecisionAtk * decisionCount * count;
    if (def.perDecisionHp) hp += def.perDecisionHp * decisionCount * count;
    if (def.perDecisionFunds) funds += def.perDecisionFunds * decisionCount * count;
    // 成套联动 (pairWith): 同持指定藏品时追加收益
    if (def.pairWith && owned(def.pairWith)) {
      atk += (def.pairAtk || 0) * count;
      hp += (def.pairHp || 0) * count;
      def0 += (def.pairDef || 0) * count;
      dmg += (def.pairDmg || 0) * count;
    }
    // 阈值条件 (minRelics/minColor/minActive/maxActive/minTop): 达成才结算 cond* 收益
    if (condMet(def, cond)) {
      atk += (def.condAtk || 0) * count;
      hp += (def.condHp || 0) * count;
      def0 += (def.condDef || 0) * count;
      dmg += (def.condDmg || 0) * count;
      funds += (def.condFunds || 0) * count;
    }
  }
  // 套装/联动组合 (集齐即触发, 只算一次)
  for (const c of activeCombos(entries)) {
    atk += c.atk || 0; hp += c.hp || 0; def0 += c.def || 0; dmg += c.dmg || 0; funds += c.funds || 0;
  }
  return { atk, hp, def: def0, dmg, funds };
}

/**
 * 每回合要加的层数 (给 layers) — 返回 [{ bondId, n }]。
 * scope 'active' / 'core' → **每一条**已激活（核心）盟约各 +n；'top' → 层数最高的盟约 +n；具体 bondId → 该盟约 +n。
 */
export function roundLayerGains(ps, entries) {
  const out = [];
  const pushSpec = (spec, mult) => {
    if (!spec || !(spec.n > 0)) return;
    const scope = spec.scope;
    const n = spec.n * mult;
    if (scope === 'active' || scope === 'core') {
      for (const id of Object.keys(ps.bonds || {})) {
        if (!isActive(ps, id)) continue;
        if (scope === 'core' && !CORE_BONDS.includes(id)) continue;
        out.push({ bondId: id, n });
      }
    } else if (scope === 'random') {
      // 随机给一个「已激活盟约」补层 (每回合换一个)
      const act = Object.keys(ps.bonds || {}).filter((id) => isActive(ps, id));
      if (act.length) out.push({ bondId: act[Math.floor(Math.random() * act.length)], n });
    } else {
      const bondId = layerTarget(ps, scope);
      if (bondId) out.push({ bondId, n });
    }
  };
  const cond = condCtx(ps, entries);
  for (const { def, count } of entries) {
    if (!def || !(count > 0)) continue;
    if (def.layers) pushSpec(def.layers, count);
    // 阈值条件: 达成时每回合给「层数最高的盟约」+condLayers
    if (def.condLayers && condMet(def, cond)) pushSpec({ n: def.condLayers, scope: 'top' }, count);
  }
  // 套装/联动组合的每回合层数 (集齐即触发)
  for (const c of activeCombos(entries)) pushSpec(c.layers, 1);
  return out;
}

export const CORE_BOND_IDS = Object.freeze(CORE_BONDS.slice());

/** 按权重不重复抽 count 个。 */
function weightedSample(rng, items, weightOf, count) {
  const pool = items.slice();
  const out = [];
  while (out.length < count && pool.length) {
    let total = 0;
    for (const it of pool) total += Math.max(0, weightOf(it));
    if (!(total > 0)) { out.push(...pool.splice(0, count - out.length)); break; }
    let r = rng() * total, idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) { r -= Math.max(0, weightOf(pool[i])); if (r < 0) { idx = i; break; } }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * 藏品 3 选 1 候选: 保证 1 个是你专属盟约对应的核心藏品 (若有)，其余按稀有度权重抽 (彩只在你选了对应核心盟约时出)。
 * @returns {typeof RELICS} 候选 def 数组
 */
export function rollRelics(rng, ps, round, n = 3) {
  const w = relicWeights(round);
  const weightOf = (d) => (d.rarity === 'color' ? w.color : d.rarity === 'gold' ? w.gold : d.rarity === 'blue' ? w.blue : w.white);
  // 纯稀有度加权 (彩 2%/5%) —— 不再给「专属盟约的核心彩藏品」保底 (那会导致每轮必出彩; author 2026-10-12「彩色概率太高」)。
  // 只保留一点点偏置: 若本轮抽到彩, 优先出「你已选专属盟约」对应的核心藏品 (仍是随概率出, 不是必出)。
  return weightedSample(rng, RELICS, weightOf, n);
}

/** 通用决策 3 选 1 候选 (排除已持有的)。 */
export function rollDecisions(rng, ps, n = 3) {
  const owned = new Set(ps.decisions || []);
  const w = { white: 55, blue: 33, gold: 12 };
  const pool = GENERAL_DECISIONS.filter((d) => !owned.has(d.key));
  return weightedSample(rng, pool, (d) => w[d.rarity] || 1, n);
}

/** 专属盟约 3 选 1 候选: 随机 n 个核心盟约专属 (不动原数组)。 */
export function rollExclusives(rng, n = 3) {
  const pool = EXCLUSIVE_DECISIONS.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp; }
  return pool.slice(0, Math.min(n, pool.length));
}

export function relicDefById(id) { return RELICS.find((d) => d.id === id) || null; }
export function decisionDefByKey(key) { return GENERAL_DECISIONS.find((d) => d.key === key) || null; }
export function exclusiveDefByBond(bond) { return EXCLUSIVE_DECISIONS.find((d) => d.bond === bond) || null; }

/**
 * 本命盟约的层数获取倍率 (专属盟约的 `layerMul`): 当 `bondId` 正是该玩家的专属盟约时返回倍率 (默认 1)。
 * 用于「本命盟约的一切层数 ×倍」——prep 的 addLayers 与战斗结算的 IN_BATTLE 层数都过这里。
 */
export function exclusiveLayerMul(ps, bondId) {
  if (!ps || !ps.exclusiveBond || ps.exclusiveBond !== bondId) return 1;
  const def = exclusiveDefByBond(ps.exclusiveBond);
  return def && def.layerMul > 1 ? def.layerMul : 1;
}
