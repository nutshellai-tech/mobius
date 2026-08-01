import * as THREE from 'three';
import { extCall } from '/extension/_sdk/ext.js';

const WORLD = Object.freeze({
  width: 20,
  depth: 30,
  spawnZ: -13.5,
  baseZ: 10.3,
  lanes: [-6, 0, 6],
  maxEnemies: 700,
  maxProjectiles: 260,
});

const THEMES = Object.freeze({
  zombie: {
    id: 'zombie',
    order: '01',
    title: '尸潮防线',
    english: 'HORDE OVERDRIVE',
    eyebrow: '把广告里玩不到的游戏真的做出来',
    description: '左右移动唯一的主炮台，决定这一秒守哪一路。打爆尸潮结界和隐藏补给，让火力、射速与炮台数量在一局里不断膨胀。',
    features: ['横移主炮台', '可击破 Bonus', '永久数值叠加', '尸王演出'],
    roster: ['腐烂行尸', '狂奔者', '屠夫肉盾', '变异精英', '巨型尸王'],
    speech: {
      normal: ['脑——子——在哪边？', '开门！社区送温暖！', '我只是路过吃个夜宵。', '这路怎么还有炮？'],
      runner: ['等等我，鞋跑掉了！', '冲错路了！先别开炮！', '我为什么跑这么快？', '前面的僵尸让一让！'],
      tank: ['轻点，我刚吃饱。', '大块头申请优先通行！', '这炮是在给我挠痒吗？', '谁把门修得这么结实？'],
      elite: ['谁把我从午睡里叫醒的？', '今天这座基地必须拆！', '我闻到了人类加班的味道。', '普通僵尸都靠边站！'],
      boss: ['都别挤，我才是尸王！', '广告里我可是最终主角！', '这城墙看起来很有嚼劲。', '三路都让开，我走中间！'],
    },
    startButton: '开始守城',
    startButtonHint: '点击后尸潮立即来袭',
    startHint: 'A / D 左右移动 · S 回到中路 · P 暂停 · 空格触发超载',
    brandKicker: 'AD FANTASY LAB / 01',
    leaderboardKicker: 'TOP SURVIVORS',
    leaderboardTitle: '尸潮最高战绩',
    baseLabel: '基地完整度',
    laneControlLabel: '主炮台横移',
    lanes: ['左路', '中路', '右路'],
    laneHint: '一次只能攻击当前一路；A / D 左右横移，点击战场可直接换路',
    weaponLabels: ['火力', '射速', '尸爆', '连锁', '冰冻'],
    upgradeEyebrow: '火力模块已就绪',
    upgradeTitle: '选择一项夸张升级',
    resumeLabel: '继续屠杀',
    roundDuration: 75,
    bossAt: 55,
    firstUpgradeAt: 10,
    upgradeInterval: 12,
    spawnMultiplier: 1,
    hpMultiplier: 1,
    speedMultiplier: 1,
    bossHpMultiplier: 1,
    bossSpeed: 0.42,
    palette: {
      bg: 0x07111f, fog: 0x07111f, ground: 0x102638,
      wall: 0x274e61, wallEmissive: 0x0d2d34, core: 0x4fffd2,
      accent: '#4fffd2', secondary: '#8fff65', yellow: '#ffd84f', projectile: 0xffe36d,
      enemies: { normal: 0x83f26e, runner: 0xffa943, tank: 0xb47cff, elite: 0xff668a, boss: 0xff4f5d },
    },
    bonus: {
      damage: ['▰', '高爆弹匣', '永久火力 +18%'],
      rate: ['⚡', '电磁供弹', '永久射速 +14%'],
      crit: ['◎', '猎杀标记', '永久暴击率 +5%'],
      mystery: ['?', '诅咒宝箱', '击破后揭晓隐藏大奖'],
      barrier: ['◇', '尸潮结界', '击碎可获得强化与炮台碎片'],
    },
    director: {
      frenzyIcon: '☣', frenzyLabel: '十倍尸潮', frenzyDescription: '8 秒敌潮 ×10，敌人变脆',
      overdriveIcon: '⚡', overdriveLabel: '火力超载', overdriveDescription: '10 秒伤害 ×2.45、射速 ×2.4',
      bossIcon: '♛', bossLabel: '尸王立即登场', bossDescription: '不用等到最后',
      frenzyToast: '十倍尸潮已启动：密度拉满，但敌人会稍微变脆',
      frenzyBanner: 'TENFOLD HORDE',
      overdriveToast: '火力超载：伤害与射速暴涨 10 秒',
      overdriveBanner: 'FIREPOWER OVERDRIVE',
      bailoutToast: '防线濒危：隐藏救场协议自动触发',
      bailoutBanner: 'LAST STAND PROTOCOL',
      bossToast: '警告：巨型尸王突破封锁线',
      manualBossToast: '直播导演指令：尸王提前入场',
      bossBanner: 'OMEGA BOSS INBOUND',
    },
    bossName: '巨型尸王 · OMEGA',
    openingToast: '主炮台只打一条路：A / D 横移，优先抢下会发光的 Bonus 与结界',
    victoryTitle: '防线守住了',
    victoryDescription: '广告里的那一局，这次真的打完了。你可以直接重开，或者继续用导演台折腾下一局。',
    defeatTitle: '城墙被吃光了',
    defeatDescription: '这局不是骗氪点，按一下就能原地再来。下一局会重新洗升级选项。',
    victoryBanner: 'OMEGA ELIMINATED',
    victoryToast: '巨型尸王已击杀：正在统计这场离谱战绩',
    upgrades: {
      damage: ['口径膨胀', '所有子弹伤害继续暴涨，普通尸群更快蒸发'],
      rate: ['射速失控', '当前战线的全部炮台射击间隔继续缩短'],
      blast: ['尸爆协议', '子弹命中产生范围爆炸，等级越高波及范围越大'],
      chain: ['连锁闪电', '命中有概率跳向附近敌人，形成可见的闪电链'],
      frost: ['绝对零度', '命中有概率冻结敌人两秒，减慢整片尸潮'],
      multi: ['分裂弹头', '当前战线同时锁定更多目标，子弹数量肉眼可见地增加'],
      cannon: ['炮台复制', '增加一座炮台；所有炮台仍然只攻击你当前选择的一路'],
      crit: ['暴击算法', '提高暴击概率与倍率，让伤害数字更不讲道理'],
      repair: ['防线焊死', '立即修复基地，并获得一段短暂火力加成'],
    },
  },
  deadline: {
    id: 'deadline',
    order: '02',
    title: '程序员保卫 DDL',
    english: 'SHIP IT OR DIE',
    eyebrow: '今晚不修完这些 Bug，谁都别想下班',
    description: '把唯一的救火小组左右调度到前端、后端或生产。击破咖啡补给、隐藏需求和流程结界，让修复倍率一路失控。',
    features: ['横移救火小组', '隐藏需求 Bonus', '永久数值叠加', '甲方 Boss'],
    roster: ['开发同事', '狂奔实习生', '产品经理', '暴躁 Leader', '甲方老板'],
    speech: {
      normal: ['开发：这 Bug 不是我引入的！', '开发：我本地明明是好的。', '开发：谁动了我的分支？', '开发：先让我看一下日志。'],
      runner: ['实习生：我直接改生产了！', '实习生：测试环境在哪儿？', '实习生：我只删了一个分号。', '实习生：Leader，我先提交啦！'],
      tank: ['产品经理：这个需求很简单。', '产品经理：就改亿点点。', '产品经理：用户说今天必须上。', '产品经理：按钮要五彩斑斓的黑。'],
      elite: ['Leader：今晚必须上线！', 'Leader：大家再坚持五分钟。', 'Leader：先解决问题，锅以后分。', 'Leader：进度为什么还是 99%？'],
      boss: ['甲方：上线前我再改一下。', '甲方：我不懂技术，但这很简单。', '甲方：明早给我看完整版本。', '甲方：原型不是已经能点了吗？'],
    },
    startButton: '开始上线',
    startButtonHint: '点击后立即进入救火模式',
    startHint: 'A / D 左右调度 · S 回到后端 · P 暂停 · 空格咖啡续命',
    brandKicker: 'AD FANTASY LAB / 02',
    leaderboardKicker: 'TOP ENGINEERS',
    leaderboardTitle: '上线最高战绩',
    baseLabel: '服务器稳定度',
    laneControlLabel: '救火小组调度',
    lanes: ['前端', '后端', '生产'],
    laneHint: '一次只修当前服务；A / D 左右调度，点击战场可直接切换',
    weaponLabels: ['修复', '编译', '异常', '调用链', '冻结'],
    upgradeEyebrow: '新的补丁已经通过 Review',
    upgradeTitle: '选择一项上线前热修',
    resumeLabel: '继续救火',
    roundDuration: 70,
    bossAt: 50,
    firstUpgradeAt: 9,
    upgradeInterval: 11,
    spawnMultiplier: 1.18,
    hpMultiplier: 0.82,
    speedMultiplier: 1.1,
    bossHpMultiplier: 0.92,
    bossSpeed: 0.47,
    palette: {
      bg: 0x071022, fog: 0x071022, ground: 0x101d39,
      wall: 0x263d73, wallEmissive: 0x0b2861, core: 0x62a8ff,
      accent: '#62a8ff', secondary: '#45f0d0', yellow: '#ffca5c', projectile: 0x88d9ff,
      enemies: { normal: 0xff5c6c, runner: 0xffc857, tank: 0x7c83ff, elite: 0xd66bff, boss: 0xff3d81 },
    },
    bonus: {
      damage: ['⌘', '热修补丁', '永久修复力 +18%'],
      rate: ['☕', '咖啡补给', '永久处理速度 +14%'],
      crit: ['✓', '一次通过', '永久无警告率 +5%'],
      mystery: ['?', '隐藏需求', '击破后揭晓离谱加成'],
      barrier: ['▦', '流程结界', '击穿可获得算力与团队碎片'],
    },
    director: {
      frenzyIcon: '⚠', frenzyLabel: '需求井喷', frenzyDescription: '8 秒需求量 ×10，需求变脆',
      overdriveIcon: '☕', overdriveLabel: '咖啡续命', overdriveDescription: '10 秒修复 ×2.45、处理速度 ×2.4',
      bossIcon: '☎', bossLabel: '甲方立即来电', bossDescription: '提前触发最终需求',
      frenzyToast: '群聊里突然多了 99+ 条新需求：需求井喷已启动',
      frenzyBanner: 'SCOPE CREEP ×10',
      overdriveToast: '咖啡因超频：编译与热修速度暴涨 10 秒',
      overdriveBanner: 'CAFFEINE OVERCLOCK',
      bailoutToast: '生产环境濒危：自动执行紧急回滚与咖啡续命',
      bailoutBanner: 'EMERGENCY ROLLBACK',
      bossToast: '警告：上线前临时改需求正在冲击生产环境',
      manualBossToast: '直播导演指令：甲方提前来电',
      bossBanner: 'CLIENT CALL INBOUND',
    },
    bossName: '上线前临时改需求 · FINAL',
    openingToast: '救火小组一次只修一个服务：A / D 调度，优先抢咖啡、补丁与隐藏需求',
    victoryTitle: '居然准时上线了',
    victoryDescription: '所有 Bug 被压进了发布包，临时需求也被当场打回。现在可以再模拟一次更离谱的上线夜。',
    defeatTitle: '生产环境炸了',
    defeatDescription: '服务器没有永久损坏。点击重来，下一次可以更早使用紧急回滚和咖啡续命。',
    victoryBanner: 'SHIPMENT SUCCESS',
    victoryToast: '临时改需求已被拒绝：正在生成上线战报',
    upgrades: {
      damage: ['代码热修', '每次修复能够消灭更多 Bug，严重异常也会快速掉血'],
      rate: ['咖啡因超频', '真实缩短当前服务的编译与部署间隔'],
      blast: ['异常连锁', '修掉一个异常时顺便清理附近同类堆栈'],
      chain: ['调用链追踪', '沿调用关系跳转并修复附近 Bug'],
      frost: ['冻结需求', '临时冻结需求流入，为生产环境争取时间'],
      multi: ['多线程处理', '当前服务同时锁定更多问题并行修复'],
      cannon: ['召集支援小组', '增加一个救火小组；所有小组仍只处理当前服务'],
      crit: ['一次过编译', '提高无警告通过概率，出现夸张的绿色通过数字'],
      repair: ['紧急回滚', '恢复服务器稳定度，并获得短暂咖啡因加成'],
    },
  },
});

const els = {
  shell: document.getElementById('gameShell'),
  stage: document.getElementById('stage'),
  fxCanvas: document.getElementById('fxCanvas'),
  brandKicker: document.getElementById('brandKicker'),
  brandTitle: document.getElementById('brandTitle'),
  score: document.getElementById('scoreValue'),
  kills: document.getElementById('killsValue'),
  combo: document.getElementById('comboValue'),
  time: document.getElementById('timeValue'),
  baseHpText: document.getElementById('baseHpText'),
  baseHpFill: document.getElementById('baseHpFill'),
  baseStatusLabel: document.getElementById('baseStatusLabel'),
  bossHud: document.getElementById('bossHud'),
  bossName: document.getElementById('bossName'),
  bossHpText: document.getElementById('bossHpText'),
  bossHpFill: document.getElementById('bossHpFill'),
  bonusDamageValue: document.getElementById('bonusDamageValue'),
  bonusRateValue: document.getElementById('bonusRateValue'),
  cannonCountValue: document.getElementById('cannonCountValue'),
  cannonShardValue: document.getElementById('cannonShardValue'),
  bonusCountValue: document.getElementById('bonusCountValue'),
  soundBtn: document.getElementById('soundBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  directorPanel: document.querySelector('.director-panel'),
  directorToggle: document.getElementById('directorToggle'),
  frenzyBtn: document.getElementById('frenzyBtn'),
  frenzyIcon: document.getElementById('frenzyIcon'),
  frenzyLabel: document.getElementById('frenzyLabel'),
  frenzyDescription: document.getElementById('frenzyDescription'),
  overdriveBtn: document.getElementById('overdriveBtn'),
  overdriveIcon: document.getElementById('overdriveIcon'),
  overdriveLabel: document.getElementById('overdriveLabel'),
  overdriveDescription: document.getElementById('overdriveDescription'),
  bossBtn: document.getElementById('bossBtn'),
  bossIcon: document.getElementById('bossIcon'),
  bossButtonLabel: document.getElementById('bossButtonLabel'),
  bossButtonDescription: document.getElementById('bossButtonDescription'),
  speedRange: document.getElementById('speedRange'),
  speedLabel: document.getElementById('speedLabel'),
  autoPickInput: document.getElementById('autoPickInput'),
  laneButtons: [...document.querySelectorAll('.lane-button')],
  laneControlLabel: document.getElementById('laneControlLabel'),
  laneLabels: [0, 1, 2].map((index) => document.getElementById(`laneLabel${index}`)),
  laneHint: document.getElementById('laneHint'),
  damageChipLabel: document.getElementById('damageChipLabel'),
  rateChipLabel: document.getElementById('rateChipLabel'),
  blastChipLabel: document.getElementById('blastChipLabel'),
  chainChipLabel: document.getElementById('chainChipLabel'),
  frostChipLabel: document.getElementById('frostChipLabel'),
  damageLevel: document.getElementById('damageLevel'),
  rateLevel: document.getElementById('rateLevel'),
  blastLevel: document.getElementById('blastLevel'),
  chainLevel: document.getElementById('chainLevel'),
  frostLevel: document.getElementById('frostLevel'),
  toast: document.getElementById('toast'),
  overdriveBanner: document.getElementById('overdriveBanner'),
  startOverlay: document.getElementById('startOverlay'),
  startEyebrow: document.getElementById('startEyebrow'),
  startTitle: document.getElementById('startTitle'),
  startEnglish: document.getElementById('startEnglish'),
  startDescription: document.getElementById('startDescription'),
  enemyRoster: document.getElementById('enemyRoster'),
  featureRow: document.getElementById('featureRow'),
  themeButtons: [...document.querySelectorAll('.theme-card')],
  startBtn: document.getElementById('startBtn'),
  startButtonLabel: document.getElementById('startButtonLabel'),
  startButtonHint: document.getElementById('startButtonHint'),
  startHint: document.getElementById('startHint'),
  leaderboardList: document.getElementById('leaderboardList'),
  leaderboardKicker: document.getElementById('leaderboardKicker'),
  leaderboardTitle: document.getElementById('leaderboardTitle'),
  identity: document.getElementById('identityValue'),
  upgradeOverlay: document.getElementById('upgradeOverlay'),
  upgradeEyebrow: document.getElementById('upgradeEyebrow'),
  upgradeTitle: document.getElementById('upgradeTitle'),
  upgradeCountdown: document.getElementById('upgradeCountdown'),
  upgradeOptions: document.getElementById('upgradeOptions'),
  pauseOverlay: document.getElementById('pauseOverlay'),
  resumeBtn: document.getElementById('resumeBtn'),
  resumeButtonLabel: document.getElementById('resumeButtonLabel'),
  restartBtn: document.getElementById('restartBtn'),
  resultOverlay: document.getElementById('resultOverlay'),
  resultEyebrow: document.getElementById('resultEyebrow'),
  resultTitle: document.getElementById('resultTitle'),
  resultDescription: document.getElementById('resultDescription'),
  finalScore: document.getElementById('finalScore'),
  finalKills: document.getElementById('finalKills'),
  finalCombo: document.getElementById('finalCombo'),
  finalRank: document.getElementById('finalRank'),
  newBestBadge: document.getElementById('newBestBadge'),
  againBtn: document.getElementById('againBtn'),
  menuBtn: document.getElementById('menuBtn'),
};

const fxCtx = els.fxCanvas.getContext('2d');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (a, b, t) => a + (b - a) * t;
const formatScore = (value) => Math.max(0, Math.round(value)).toLocaleString('zh-CN');
const cssHex = (value) => `#${Number(value).toString(16).padStart(6, '0')}`;

function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value += 0x6D2B79F5;
    let n = value;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

let audioContext = null;
let muted = localStorage.getItem('toy-toy-toy-muted') === '1';

function ensureAudio() {
  if (muted) return null;
  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      audioContext = null;
    }
  }
  if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

function tone(frequency, duration = 0.08, type = 'square', gainValue = 0.035, delay = 0) {
  const context = ensureAudio();
  if (!context) return;
  const start = context.currentTime + delay;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(gainValue, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

const sfx = {
  shoot() { tone(180, 0.025, 'square', 0.008); },
  hit() { tone(95, 0.035, 'sawtooth', 0.01); },
  upgrade() {
    tone(440, 0.09, 'triangle', 0.04);
    tone(660, 0.1, 'triangle', 0.04, 0.09);
    tone(990, 0.13, 'triangle', 0.05, 0.18);
  },
  warning() {
    tone(140, 0.16, 'sawtooth', 0.05);
    tone(110, 0.16, 'sawtooth', 0.05, 0.2);
  },
  overdrive() {
    tone(220, 0.1, 'square', 0.05);
    tone(440, 0.12, 'square', 0.05, 0.08);
    tone(880, 0.16, 'square', 0.045, 0.17);
  },
  boss() {
    tone(90, 0.45, 'sawtooth', 0.065);
    tone(70, 0.55, 'sawtooth', 0.06, 0.32);
  },
  victory() {
    [523, 659, 784, 1047].forEach((frequency, index) => tone(frequency, 0.2, 'triangle', 0.05, index * 0.12));
  },
};

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
els.stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07111f);
scene.fog = new THREE.FogExp2(0x07111f, 0.011);

const camera = new THREE.OrthographicCamera(-16, 16, 16, -16, 0.1, 100);
const cameraHome = new THREE.Vector3(0, 23, 25);
camera.position.copy(cameraHome);
camera.lookAt(0, 0, 1.5);

scene.add(new THREE.AmbientLight(0xd8f4ff, 1.35));
scene.add(new THREE.HemisphereLight(0xaeefff, 0x102238, 2.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(-7, 17, 6);
scene.add(keyLight);
const baseLight = new THREE.PointLight(0x4fffd2, 18, 22, 2);
baseLight.position.set(0, 3, 10);
scene.add(baseLight);

const worldGroup = new THREE.Group();
scene.add(worldGroup);

const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x102638, roughness: 0.82, metalness: 0.16 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD.width + 1, WORLD.depth + 2), groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.position.set(0, -0.11, 0);
worldGroup.add(ground);

const grid = new THREE.GridHelper(31, 31, 0x3a8096, 0x1a4052);
grid.position.y = -0.075;
grid.material.transparent = true;
grid.material.opacity = 0.46;
worldGroup.add(grid);

for (const x of [-3, 3]) {
  const divider = new THREE.Mesh(
    new THREE.PlaneGeometry(0.08, WORLD.depth),
    new THREE.MeshBasicMaterial({ color: 0x4fffd2, transparent: true, opacity: 0.12 }),
  );
  divider.rotation.x = -Math.PI / 2;
  divider.position.set(x, -0.055, 0);
  worldGroup.add(divider);
}

const focusLaneMaterial = new THREE.MeshBasicMaterial({
  color: 0x4fffd2,
  transparent: true,
  opacity: 0.075,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const focusLaneGlow = new THREE.Mesh(new THREE.PlaneGeometry(5.25, WORLD.depth), focusLaneMaterial);
focusLaneGlow.rotation.x = -Math.PI / 2;
focusLaneGlow.position.set(0, -0.045, 0);
worldGroup.add(focusLaneGlow);

const focusRailMaterial = new THREE.MeshBasicMaterial({ color: 0x4fffd2, transparent: true, opacity: 0.75 });
const focusRail = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.08, 0.16), focusRailMaterial);
focusRail.position.set(0, 0.06, 9.55);
worldGroup.add(focusRail);

for (let side = -1; side <= 1; side += 2) {
  for (let i = 0; i < 11; i += 1) {
    const height = 0.6 + ((i * 17) % 9) * 0.22;
    const ruin = new THREE.Mesh(
      new THREE.BoxGeometry(0.75 + (i % 3) * 0.22, height, 1.1 + (i % 4) * 0.25),
      new THREE.MeshStandardMaterial({
        color: i % 2 ? 0x19354a : 0x142d40,
        roughness: 0.88,
        emissive: i % 3 === 0 ? 0x102d36 : 0x000000,
        emissiveIntensity: 0.45,
      }),
    );
    ruin.position.set(side * (10.8 + (i % 2) * 0.8), height / 2 - 0.08, -12.5 + i * 2.55);
    ruin.rotation.y = side * (0.08 + (i % 4) * 0.05);
    worldGroup.add(ruin);
  }
}

const baseGroup = new THREE.Group();
worldGroup.add(baseGroup);

const wallMaterial = new THREE.MeshStandardMaterial({
  color: 0x274e61,
  roughness: 0.52,
  metalness: 0.62,
  emissive: 0x0d2d34,
  emissiveIntensity: 0.8,
});
const wall = new THREE.Mesh(new THREE.BoxGeometry(20.5, 1.5, 1.35), wallMaterial);
wall.position.set(0, 0.75, 11.25);
baseGroup.add(wall);

for (let i = -9; i <= 9; i += 2) {
  const light = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 0.12, 0.08),
    new THREE.MeshBasicMaterial({ color: i % 4 ? 0x4fffd2 : 0xffd84f }),
  );
  light.position.set(i, 1.18, 10.54);
  baseGroup.add(light);
}

const coreMaterial = new THREE.MeshStandardMaterial({
  color: 0x193e55,
  metalness: 0.7,
  roughness: 0.25,
  emissive: 0x4fffd2,
  emissiveIntensity: 0.55,
});
const core = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.8, 2.3, 8), coreMaterial);
core.position.set(0, 1.2, 13.1);
baseGroup.add(core);

const turretGroups = [];
for (let lane = 0; lane < WORLD.lanes.length; lane += 1) {
  const turret = new THREE.Group();
  turret.position.set(0, 0, 10.2);
  turret.visible = lane === 0;
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.92, 0.75, 10),
    new THREE.MeshStandardMaterial({ color: 0x28475b, metalness: 0.72, roughness: 0.28 }),
  );
  pedestal.position.y = 0.36;
  turret.add(pedestal);

  const pivot = new THREE.Group();
  pivot.position.y = 0.9;
  const housingMaterial = new THREE.MeshStandardMaterial({
    color: 0x4fffd2,
    metalness: 0.48,
    roughness: 0.25,
    emissive: 0x164f4a,
    emissiveIntensity: 0.7,
  });
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.58, 0.9), housingMaterial);
  pivot.add(housing);
  const barrelMaterial = new THREE.MeshStandardMaterial({
    color: 0xd7f8f2,
    metalness: 0.84,
    roughness: 0.16,
    emissive: 0x4fffd2,
    emissiveIntensity: 0.35,
  });
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 1.85), barrelMaterial);
  barrel.position.z = -1.18;
  pivot.add(barrel);
  turret.add(pivot);
  turretGroups.push({ group: turret, pivot, housingMaterial, barrelMaterial, targetRotation: 0, recoil: 0 });
  baseGroup.add(turret);
}

const ENEMY_TYPES = ['normal', 'runner', 'tank', 'elite', 'boss'];
const ENEMY_ATLAS_FRAMES = Object.freeze({ normal: 0, runner: 1, tank: 2, elite: 3, boss: 4 });
const textureLoader = new THREE.TextureLoader();
const enemyPlaneGeometry = new THREE.PlaneGeometry(1.95, 2.55);
enemyPlaneGeometry.translate(0, 1.275, 0);

function createEnemyMaterial(themeId, type) {
  const texture = textureLoader.load(`./assets/characters/${themeId}-atlas.svg?v=0.6.0`);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(0.2, 1);
  texture.offset.set(ENEMY_ATLAS_FRAMES[type] * 0.2, 0);
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return new THREE.MeshBasicMaterial({
    map: texture,
    color: 0xffffff,
    transparent: true,
    alphaTest: 0.08,
    depthWrite: true,
    fog: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

const enemyVisuals = {
  normal: { shadow: 0.72 },
  runner: { shadow: 0.58 },
  tank: { shadow: 0.9 },
  elite: { shadow: 0.92 },
  boss: { shadow: 1.08 },
};
for (const [type, visual] of Object.entries(enemyVisuals)) {
  visual.materials = {
    zombie: createEnemyMaterial('zombie', type),
    deadline: createEnemyMaterial('deadline', type),
  };
  visual.mesh = new THREE.InstancedMesh(
    enemyPlaneGeometry,
    visual.materials.zombie,
    WORLD.maxEnemies,
  );
  visual.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  visual.mesh.setColorAt(0, new THREE.Color(0xffffff));
  visual.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  visual.mesh.frustumCulled = false;
  visual.mesh.count = 0;
  worldGroup.add(visual.mesh);
}

const enemyShadowGeometry = new THREE.CircleGeometry(0.72, 20);
enemyShadowGeometry.rotateX(-Math.PI / 2);
const enemyShadowMesh = new THREE.InstancedMesh(
  enemyShadowGeometry,
  new THREE.MeshBasicMaterial({ color: 0x010407, transparent: true, opacity: 0.46, depthWrite: false, fog: true }),
  WORLD.maxEnemies,
);
enemyShadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
enemyShadowMesh.frustumCulled = false;
enemyShadowMesh.count = 0;
worldGroup.add(enemyShadowMesh);

const projectileGeometry = new THREE.SphereGeometry(0.13, 8, 6);
const projectileMaterial = new THREE.MeshBasicMaterial({ color: 0xffe36d, toneMapped: false });
const projectilePool = [];
for (let i = 0; i < WORLD.maxProjectiles; i += 1) {
  const mesh = new THREE.Mesh(projectileGeometry, projectileMaterial);
  mesh.visible = false;
  worldGroup.add(mesh);
  projectilePool.push({ active: false, mesh, x: 0, y: 0, z: 0, target: null, damage: 0, lane: 0 });
}

const matrixDummy = new THREE.Object3D();
const shadowDummy = new THREE.Object3D();
const enemyTint = new THREE.Color();
const enemies = [];
const bonusTargets = [];
const BONUS_CONFIG = Object.freeze({
  damage: { color: 0xffc857, hp: 72, speed: 1.28, score: 320, scale: 1 },
  rate: { color: 0x4fffd2, hp: 68, speed: 1.34, score: 320, scale: 1 },
  crit: { color: 0xff6fbc, hp: 82, speed: 1.22, score: 420, scale: 1.04 },
  mystery: { color: 0xb37cff, hp: 145, speed: 1.05, score: 900, scale: 1.16 },
  barrier: { color: 0xff7a55, hp: 260, speed: 0.82, score: 1400, scale: 1.35 },
});
const shockwaves = [];
const fxItems = [];
const lightningItems = [];
const speechBubbles = [];

const state = {
  mode: 'menu',
  themeId: THEMES[localStorage.getItem('toy-toy-toy-theme')] ? localStorage.getItem('toy-toy-toy-theme') : 'zombie',
  seed: 0,
  random: Math.random,
  elapsed: 0,
  score: 0,
  kills: 0,
  combo: 1,
  maxCombo: 1,
  comboUntil: 0,
  baseHp: 100,
  focusLane: 1,
  fireAcc: [0, 0, 0],
  spawnAcc: 0,
  nextBonusAt: 5.5,
  nextBarrierAt: 14,
  nextMysteryAt: 23,
  nextSpeechAt: 2.8,
  nextUpgradeAt: 10,
  upgradeDeadline: 0,
  currentUpgrades: [],
  speed: 1,
  frenzyUntil: 0,
  overdriveUntil: 0,
  bailoutUsed: false,
  bossSpawned: false,
  bossAlive: false,
  bossDefeated: false,
  finishAt: 0,
  shake: 0,
  flash: 0,
  lastTs: performance.now(),
  lastUiAt: 0,
  lastShotSoundAt: 0,
  lastKillSoundAt: 0,
  telemetry: {
    spawned: 0,
    shots: 0,
    speech: 0,
    frenzyUses: 0,
    overdriveUses: 0,
    bossUses: 0,
    upgrades: 0,
  },
  bonuses: {
    damage: 1,
    rate: 1,
    crit: 0,
    count: 0,
    shards: 0,
    barriers: 0,
  },
  levels: {
    damage: 1,
    rate: 1,
    blast: 0,
    chain: 0,
    frost: 0,
    multi: 0,
    crit: 0,
    cannon: 1,
  },
};

const upgrades = [
  {
    id: 'damage', icon: '▰', title: '口径膨胀', color: '#ffd84f', max: 7,
    describe: () => `所有子弹伤害提高 ${state.levels.damage < 4 ? 55 : 42}%`,
    apply: () => { state.levels.damage += 1; },
  },
  {
    id: 'rate', icon: '»', title: '射速失控', color: '#4fffd2', max: 7,
    describe: () => '当前战线的全部炮台射击间隔继续缩短',
    apply: () => { state.levels.rate += 1; },
  },
  {
    id: 'blast', icon: '✦', title: '尸爆协议', color: '#ff9f43', max: 5,
    describe: () => '子弹命中产生范围爆炸，等级越高波及范围越大',
    apply: () => { state.levels.blast += 1; },
  },
  {
    id: 'chain', icon: 'ϟ', title: '连锁闪电', color: '#b37cff', max: 5,
    describe: () => '命中有概率跳向附近敌人，形成可见的闪电链',
    apply: () => { state.levels.chain += 1; },
  },
  {
    id: 'frost', icon: '❄', title: '绝对零度', color: '#6edbff', max: 4,
    describe: () => '命中有概率冻结敌人两秒，减慢整片尸潮',
    apply: () => { state.levels.frost += 1; },
  },
  {
    id: 'multi', icon: '⑶', title: '同步齐射', color: '#8fff65', max: 3,
    describe: () => '每座炮台同时锁定更多目标，子弹数量肉眼可见地增加',
    apply: () => { state.levels.multi += 1; },
  },
  {
    id: 'crit', icon: '※', title: '暴击算法', color: '#ff6f91', max: 5,
    describe: () => '提高暴击概率与暴击倍率，伤害数字变得更不讲道理',
    apply: () => { state.levels.crit += 1; },
  },
  {
    id: 'cannon', icon: '▥', title: '炮台复制', color: '#ff7cf4', max: 3,
    describe: () => '增加一座并排炮台，但所有炮台始终只攻击当前战线',
    apply: () => { state.levels.cannon = Math.min(3, state.levels.cannon + 1); },
  },
  {
    id: 'repair', icon: '✚', title: '防线焊死', color: '#76ff9d', max: 99,
    describe: () => '立即修复 28% 基地完整度，并获得短暂火力加成',
    apply: () => {
      state.baseHp = Math.min(100, state.baseHp + 28);
      state.overdriveUntil = Math.max(state.overdriveUntil, state.elapsed + 4);
    },
  },
];

function currentTheme() {
  return THEMES[state.themeId] || THEMES.zombie;
}

function upgradePresentation(upgrade) {
  const copy = currentTheme().upgrades[upgrade.id];
  return {
    title: copy?.[0] || upgrade.title,
    description: copy?.[1] || upgrade.describe(),
  };
}

function applyTheme(themeId, { persist = true, refreshLeaderboard = true } = {}) {
  const theme = THEMES[themeId];
  if (!theme) return;
  state.themeId = themeId;
  if (persist) localStorage.setItem('toy-toy-toy-theme', themeId);

  document.title = `广告爽游实验室 · ${theme.title}`;
  document.documentElement.style.setProperty('--mint', theme.palette.accent);
  document.documentElement.style.setProperty('--lime', theme.palette.secondary);
  document.documentElement.style.setProperty('--yellow', theme.palette.yellow);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', `#${theme.palette.bg.toString(16).padStart(6, '0')}`);

  els.brandKicker.textContent = theme.brandKicker;
  els.brandTitle.textContent = theme.title;
  els.startEyebrow.textContent = theme.eyebrow;
  els.startTitle.textContent = theme.title;
  els.startEnglish.textContent = theme.english;
  els.startDescription.textContent = theme.description;
  els.enemyRoster.innerHTML = theme.roster.map((name, index) => `
    <div class="enemy-roster-item">
      <i style="background-image:url('./assets/characters/${theme.id}-atlas.svg?v=0.6.0');background-position:${index * 25}% center"></i>
      <span>${name}</span>
    </div>
  `).join('');
  els.featureRow.innerHTML = theme.features.map((feature) => `<span>${feature}</span>`).join('');
  els.startButtonLabel.textContent = theme.startButton;
  els.startButtonHint.textContent = theme.startButtonHint;
  els.startHint.textContent = theme.startHint;
  els.leaderboardKicker.textContent = theme.leaderboardKicker;
  els.leaderboardTitle.textContent = theme.leaderboardTitle;
  els.baseStatusLabel.textContent = theme.baseLabel;
  els.laneControlLabel.textContent = theme.laneControlLabel;
  theme.lanes.forEach((label, index) => { els.laneLabels[index].textContent = label; });
  els.laneHint.textContent = theme.laneHint;
  [els.damageChipLabel, els.rateChipLabel, els.blastChipLabel, els.chainChipLabel, els.frostChipLabel]
    .forEach((element, index) => { element.textContent = theme.weaponLabels[index]; });
  els.upgradeEyebrow.textContent = theme.upgradeEyebrow;
  els.upgradeTitle.textContent = theme.upgradeTitle;
  els.resumeButtonLabel.textContent = theme.resumeLabel;
  els.frenzyIcon.textContent = theme.director.frenzyIcon;
  els.frenzyLabel.textContent = theme.director.frenzyLabel;
  els.frenzyDescription.textContent = theme.director.frenzyDescription;
  els.overdriveIcon.textContent = theme.director.overdriveIcon;
  els.overdriveLabel.textContent = theme.director.overdriveLabel;
  els.overdriveDescription.textContent = theme.director.overdriveDescription;
  els.bossIcon.textContent = theme.director.bossIcon;
  els.bossButtonLabel.textContent = theme.director.bossLabel;
  els.bossButtonDescription.textContent = theme.director.bossDescription;
  els.themeButtons.forEach((button) => button.classList.toggle('active', button.dataset.theme === themeId));

  scene.background.setHex(theme.palette.bg);
  scene.fog.color.setHex(theme.palette.fog);
  groundMaterial.color.setHex(theme.palette.ground);
  wallMaterial.color.setHex(theme.palette.wall);
  wallMaterial.emissive.setHex(theme.palette.wallEmissive);
  coreMaterial.emissive.setHex(theme.palette.core);
  coreMaterial.color.setHex(theme.palette.wall);
  baseLight.color.setHex(theme.palette.core);
  projectileMaterial.color.setHex(theme.palette.projectile);
  focusLaneMaterial.color.setHex(theme.palette.core);
  focusRailMaterial.color.setHex(theme.palette.core);
  for (const visual of Object.values(enemyVisuals)) {
    visual.mesh.material = visual.materials[theme.id];
  }
  turretGroups.forEach(({ housingMaterial, barrelMaterial }) => {
    housingMaterial.color.setHex(theme.palette.core);
    housingMaterial.emissive.setHex(theme.palette.core);
    barrelMaterial.emissive.setHex(theme.palette.core);
  });

  els.time.textContent = String(theme.roundDuration);
  if (refreshLeaderboard) loadLeaderboard();
}

function randomBetween(min, max) {
  return min + (max - min) * state.random();
}

function setOverlay(element, visible) {
  element.classList.toggle('visible', visible);
}

let toastTimer = 0;
function showToast(message, duration = 1900) {
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove('visible'), duration);
}

function showOverdriveBanner(text = 'FIREPOWER OVERDRIVE') {
  els.overdriveBanner.textContent = text;
  els.overdriveBanner.classList.remove('visible');
  void els.overdriveBanner.offsetWidth;
  els.overdriveBanner.classList.add('visible');
}

function resize() {
  const width = Math.max(1, els.stage.clientWidth);
  const height = Math.max(1, els.stage.clientHeight);
  renderer.setSize(width, height, false);
  const viewHeight = 31;
  const aspect = width / height;
  camera.left = -(viewHeight * aspect) / 2;
  camera.right = (viewHeight * aspect) / 2;
  camera.top = viewHeight / 2;
  camera.bottom = -viewHeight / 2;
  camera.updateProjectionMatrix();

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  els.fxCanvas.width = Math.round(width * dpr);
  els.fxCanvas.height = Math.round(height * dpr);
  els.fxCanvas.style.width = `${width}px`;
  els.fxCanvas.style.height = `${height}px`;
  fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function clearWorldState() {
  enemies.length = 0;
  speechBubbles.length = 0;
  bonusTargets.splice(0).forEach(disposeBonusTarget);
  Object.values(enemyVisuals).forEach((visual) => { visual.mesh.count = 0; });
  enemyShadowMesh.count = 0;
  projectilePool.forEach((projectile) => {
    projectile.active = false;
    projectile.mesh.visible = false;
  });
  shockwaves.splice(0).forEach((wave) => {
    worldGroup.remove(wave.mesh);
    wave.mesh.material.dispose();
  });
  fxItems.length = 0;
  lightningItems.length = 0;
}

function resetGame() {
  const theme = currentTheme();
  clearWorldState();
  state.seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  state.random = mulberry32(state.seed);
  state.elapsed = 0;
  state.score = 0;
  state.kills = 0;
  state.combo = 1;
  state.maxCombo = 1;
  state.comboUntil = 0;
  state.baseHp = 100;
  state.focusLane = 1;
  state.fireAcc = [0, 0, 0];
  state.spawnAcc = 0;
  state.nextBonusAt = 5.5;
  state.nextBarrierAt = 14;
  state.nextMysteryAt = 23;
  state.nextSpeechAt = 2.8 + randomBetween(0, 1.6);
  state.nextUpgradeAt = theme.firstUpgradeAt;
  state.upgradeDeadline = 0;
  state.currentUpgrades = [];
  state.frenzyUntil = 0;
  state.overdriveUntil = 0;
  state.bailoutUsed = false;
  state.bossSpawned = false;
  state.bossAlive = false;
  state.bossDefeated = false;
  state.finishAt = 0;
  state.shake = 0;
  state.flash = 0;
  state.telemetry = { spawned: 0, shots: 0, speech: 0, frenzyUses: 0, overdriveUses: 0, bossUses: 0, upgrades: 0 };
  state.bonuses = { damage: 1, rate: 1, crit: 0, count: 0, shards: 0, barriers: 0 };
  state.levels = { damage: 1, rate: 1, blast: 0, chain: 0, frost: 0, multi: 0, crit: 0, cannon: 1 };
  wallMaterial.color.setHex(theme.palette.wall);
  wallMaterial.emissive.setHex(theme.palette.wallEmissive);
  coreMaterial.emissive.setHex(theme.palette.core);
  baseLight.color.setHex(theme.palette.core);
  baseLight.intensity = 18;
  focusLaneGlow.position.x = 0;
  focusRail.position.x = 0;
  turretGroups.forEach((turret, index) => {
    turret.group.visible = index === 0;
    turret.group.position.x = 0;
    turret.group.scale.setScalar(1);
    turret.pivot.position.z = 0;
    turret.recoil = 0;
  });
  els.bossHud.classList.add('hidden');
  selectLane(1);
  updateHud(true);
}

function startGame() {
  const theme = currentTheme();
  ensureAudio();
  resetGame();
  state.mode = 'playing';
  state.lastTs = performance.now();
  setOverlay(els.startOverlay, false);
  setOverlay(els.resultOverlay, false);
  setOverlay(els.pauseOverlay, false);
  setOverlay(els.upgradeOverlay, false);
  showToast(theme.openingToast);
  for (let i = 0; i < 10; i += 1) spawnEnemy(i < 2 ? 'runner' : 'normal');
}

function showMenu() {
  state.mode = 'menu';
  setOverlay(els.resultOverlay, false);
  setOverlay(els.pauseOverlay, false);
  setOverlay(els.upgradeOverlay, false);
  setOverlay(els.startOverlay, true);
  loadLeaderboard();
}

function togglePause(forceResume = false) {
  if (state.mode === 'playing' && !forceResume) {
    state.mode = 'paused';
    setOverlay(els.pauseOverlay, true);
    els.pauseBtn.textContent = '继续';
    updateHud(true);
    return;
  }
  if (state.mode === 'paused') {
    state.mode = 'playing';
    state.lastTs = performance.now();
    setOverlay(els.pauseOverlay, false);
    els.pauseBtn.textContent = '暂停';
    updateHud(true);
  }
}

function spawnEnemy(forceType = null) {
  const theme = currentTheme();
  if (enemies.filter((enemy) => enemy.active).length >= WORLD.maxEnemies) return null;
  const progress = clamp(state.elapsed / theme.roundDuration, 0, 1);
  let type = forceType;
  if (!type) {
    const roll = state.random();
    if (progress > 0.48 && roll < 0.08) type = 'tank';
    else if (progress > 0.2 && roll < 0.22) type = 'runner';
    else if (progress > 0.66 && roll < 0.29) type = 'elite';
    else type = 'normal';
  }

  const lane = type === 'boss' ? 1 : Math.floor(state.random() * 3);
  const baseHp = (20 + state.elapsed * 0.72) * theme.hpMultiplier;
  const enemy = {
    active: true,
    id: `${state.seed}-${state.elapsed}-${enemies.length}`,
    type,
    lane,
    x: WORLD.lanes[lane] + randomBetween(-1.15, 1.15),
    y: 0.62,
    z: WORLD.spawnZ - randomBetween(0, 2.2),
    hp: baseHp,
    maxHp: baseHp,
    speed: (1.28 + progress * 1.05) * theme.speedMultiplier,
    scale: 1,
    score: 11,
    baseDamage: 5,
    slowUntil: 0,
    hitUntil: 0,
    wobble: randomBetween(0, Math.PI * 2),
    speechCount: 0,
  };

  if (type === 'runner') {
    enemy.hp *= 0.62;
    enemy.maxHp = enemy.hp;
    enemy.speed *= 1.72;
    enemy.scale = 0.72;
    enemy.score = 14;
    enemy.baseDamage = 4;
  } else if (type === 'tank') {
    enemy.hp *= 3.4;
    enemy.maxHp = enemy.hp;
    enemy.speed *= 0.55;
    enemy.scale = 1.45;
    enemy.score = 35;
    enemy.baseDamage = 13;
  } else if (type === 'elite') {
    enemy.hp *= 5.5;
    enemy.maxHp = enemy.hp;
    enemy.speed *= 0.78;
    enemy.scale = 1.72;
    enemy.score = 90;
    enemy.baseDamage = 19;
  } else if (type === 'boss') {
    enemy.x = 0;
    enemy.z = WORLD.spawnZ - 1.5;
    enemy.hp = (1750 + state.elapsed * 14) * theme.bossHpMultiplier;
    enemy.maxHp = enemy.hp;
    enemy.speed = theme.bossSpeed;
    enemy.scale = 3.2;
    enemy.score = 5000;
    enemy.baseDamage = 100;
    state.bossSpawned = true;
    state.bossAlive = true;
    els.bossName.textContent = theme.bossName;
    els.bossHud.classList.remove('hidden');
  }

  enemies.push(enemy);
  state.telemetry.spawned += 1;
  return enemy;
}

function summonBoss(manual = false) {
  const theme = currentTheme();
  if (state.mode !== 'playing' || state.bossSpawned || state.bossAlive || state.bossDefeated) return;
  const boss = spawnEnemy('boss');
  if (!boss) {
    showToast('战场单位已满，清出空间后才能召唤 Boss', 1800);
    return;
  }
  if (manual) state.telemetry.bossUses += 1;
  state.shake = Math.max(state.shake, 0.85);
  showToast(manual ? theme.director.manualBossToast : theme.director.bossToast, 2600);
  showOverdriveBanner(theme.director.bossBanner);
  sfx.boss();
  for (let i = 0; i < 18; i += 1) addFxParticle(boss.x, 1, boss.z, cssHex(theme.palette.enemies.boss), 1.1);
  const bossLines = theme.speech?.boss || [];
  if (bossLines.length) showEnemySpeech(boss, bossLines[Math.floor(state.random() * bossLines.length)], 3.6);
}

function triggerFrenzy() {
  const theme = currentTheme();
  if (state.mode !== 'playing') return;
  state.telemetry.frenzyUses += 1;
  state.frenzyUntil = Math.max(state.frenzyUntil, state.elapsed + 8);
  showToast(theme.director.frenzyToast);
  showOverdriveBanner(theme.director.frenzyBanner);
  state.shake = Math.max(state.shake, 0.42);
  sfx.warning();
  for (let i = 0; i < 30; i += 1) spawnEnemy(i % 4 === 0 ? 'runner' : 'normal');
}

function triggerOverdrive(auto = false) {
  const theme = currentTheme();
  if (state.mode !== 'playing') return;
  state.telemetry.overdriveUses += 1;
  state.overdriveUntil = Math.max(state.overdriveUntil, state.elapsed + 10);
  showToast(auto ? theme.director.bailoutToast : theme.director.overdriveToast);
  showOverdriveBanner(auto ? theme.director.bailoutBanner : theme.director.overdriveBanner);
  state.shake = Math.max(state.shake, 0.36);
  sfx.overdrive();
}

function showEnemySpeech(enemy, text, life = 2.8) {
  if (!enemy?.active || !text) return;
  enemy.speechCount += 1;
  speechBubbles.push({ enemy, text, life, maxLife: life });
  state.telemetry.speech += 1;
}

function scheduleCharacterSpeech() {
  if (state.elapsed < state.nextSpeechAt || speechBubbles.length >= 2) return;
  state.nextSpeechAt = state.elapsed + randomBetween(2.6, 5.2);
  // 大多数时间让战场保持干净，台词只作为偶尔冒出来的身份彩蛋。
  if (state.random() > 0.72) return;
  const activeSpeechLanes = new Set(speechBubbles.map((bubble) => bubble.enemy?.lane));
  const candidates = enemies.filter((enemy) => (
    enemy.active
    && enemy.type !== 'boss'
    && enemy.speechCount < 1
    && enemy.z > WORLD.spawnZ + 1.2
    && enemy.z < WORLD.baseZ - 3.5
    && !activeSpeechLanes.has(enemy.lane)
  ));
  if (!candidates.length) return;
  const enemy = candidates[Math.floor(state.random() * candidates.length)];
  const lines = currentTheme().speech?.[enemy.type] || currentTheme().speech?.normal || [];
  if (!lines.length) return;
  showEnemySpeech(enemy, lines[Math.floor(state.random() * lines.length)]);
}

function updateCharacterSpeech(dt) {
  scheduleCharacterSpeech();
  for (let index = speechBubbles.length - 1; index >= 0; index -= 1) {
    const bubble = speechBubbles[index];
    bubble.life -= dt;
    if (bubble.life <= 0 || !bubble.enemy?.active) speechBubbles.splice(index, 1);
  }
}

function bonusCanvasSprite(icon, title, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(3, 10, 18, 0.9)';
  ctx.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.roundRect(8, 8, 496, 176, 28);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.font = '900 84px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(icon, 84, 96);
  ctx.fillStyle = '#effaff';
  ctx.font = '900 31px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, 145, 78);
  ctx.fillStyle = '#94afbf';
  ctx.font = '700 22px system-ui, sans-serif';
  ctx.fillText('击破获取永久强化', 145, 119);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, fog: true }));
  sprite.scale.set(3.15, 1.18, 1);
  sprite.position.y = 1.62;
  sprite.renderOrder = 12;
  return sprite;
}

function createBonusTarget(type, lane, z = WORLD.spawnZ + 4.2) {
  const theme = currentTheme();
  const config = BONUS_CONFIG[type];
  const copy = theme.bonus[type] || theme.bonus.mystery;
  const group = new THREE.Group();
  group.position.set(WORLD.lanes[lane], 0.04, z);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: config.color,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.84, 0.105, 10, 30), ringMaterial);
  ring.rotation.x = -0.72;
  ring.renderOrder = 10;
  group.add(ring);
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: config.color,
    transparent: true,
    opacity: type === 'barrier' ? 0.14 : 0.28,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const coreMesh = new THREE.Mesh(new THREE.CircleGeometry(0.69, 24), coreMaterial);
  coreMesh.rotation.x = -0.72;
  coreMesh.renderOrder = 9;
  group.add(coreMesh);
  const floorMaterial = new THREE.MeshBasicMaterial({
    color: config.color,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const floorHalo = new THREE.Mesh(new THREE.RingGeometry(0.76, 1.08, 28), floorMaterial);
  floorHalo.rotation.x = -Math.PI / 2;
  floorHalo.position.y = 0.02;
  group.add(floorHalo);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.16, 3.2, 10),
    new THREE.MeshBasicMaterial({ color: config.color, transparent: true, opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  beam.position.y = 1.6;
  group.add(beam);
  if (type === 'barrier') {
    const barrierMaterial = new THREE.MeshBasicMaterial({
      color: config.color,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const barrier = new THREE.Mesh(new THREE.PlaneGeometry(4.3, 1.72), barrierMaterial);
    barrier.rotation.x = -0.72;
    barrier.position.y = 0.9;
    group.add(barrier);
    [-1.7, 1.7].forEach((x) => {
      const pylon = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 2.2, 0.22),
        new THREE.MeshBasicMaterial({ color: config.color, transparent: true, opacity: 0.82, blending: THREE.AdditiveBlending }),
      );
      pylon.position.set(x, 1.05, 0);
      group.add(pylon);
    });
  }
  group.add(bonusCanvasSprite(copy[0], copy[1], config.color));
  worldGroup.add(group);
  const target = {
    active: true,
    kind: 'bonus',
    rewardType: type,
    lane,
    x: WORLD.lanes[lane],
    y: 0.8,
    z,
    hp: config.hp * (1 + state.elapsed * 0.018),
    maxHp: config.hp * (1 + state.elapsed * 0.018),
    scale: config.scale,
    speed: config.speed,
    score: config.score,
    wobble: randomBetween(0, Math.PI * 2),
    hitUntil: 0,
    group,
    ring,
    ringMaterial,
    coreMaterial,
  };
  bonusTargets.push(target);
  return target;
}

function disposeBonusTarget(target) {
  if (!target?.group) return;
  worldGroup.remove(target.group);
  target.group.traverse((child) => {
    if (!child.isMesh && !child.isSprite) return;
    child.geometry?.dispose();
    const material = child.material;
    if (material?.map) material.map.dispose();
    material?.dispose();
  });
  target.active = false;
}

function expireBonusTarget(target, missed = false) {
  if (!target?.active) return;
  if (missed) addFxText(target.x, 1.05, target.z, 'BONUS 错过', '#8ba6b8', 0.8, 11);
  disposeBonusTarget(target);
  const index = bonusTargets.indexOf(target);
  if (index >= 0) bonusTargets.splice(index, 1);
}

function addCannonShard(amount) {
  state.bonuses.shards += amount;
  let gained = 0;
  while (state.bonuses.shards >= 2 && state.levels.cannon < 3) {
    state.bonuses.shards -= 2;
    state.levels.cannon += 1;
    gained += 1;
  }
  return gained;
}

function grantBonus(target) {
  const theme = currentTheme();
  const copy = theme.bonus[target.rewardType] || theme.bonus.mystery;
  let message = copy[2];
  let banner = `${copy[0]} ${copy[1]}`;
  let cannonGained = 0;
  if (target.rewardType === 'damage') state.bonuses.damage += 0.18;
  else if (target.rewardType === 'rate') state.bonuses.rate += 0.14;
  else if (target.rewardType === 'crit') state.bonuses.crit += 0.05;
  else if (target.rewardType === 'barrier') {
    state.bonuses.barriers += 1;
    state.bonuses.damage += 0.12;
    state.bonuses.rate += 0.1;
    cannonGained = addCannonShard(1);
    state.baseHp = Math.min(100, state.baseHp + 8);
    message = `结界击破：火力 +12%，射速 +10%，炮台碎片 +1${cannonGained ? '，新炮台解锁' : ''}`;
    banner = `${copy[0]} 结界击破`;
  } else {
    const roll = state.random();
    if (roll < 0.34) {
      state.bonuses.damage += 0.28;
      state.bonuses.rate += 0.2;
      message = '隐藏大奖：火力 +28%，射速 +20%';
    } else if (roll < 0.68) {
      cannonGained = addCannonShard(2);
      state.bonuses.damage += 0.1;
      message = `隐藏大奖：火力 +10%，炮台碎片 +2${cannonGained ? '，新炮台解锁' : ''}`;
    } else {
      state.bonuses.crit += 0.12;
      state.bonuses.damage += 0.15;
      message = '隐藏大奖：暴击率 +12%，火力 +15%';
    }
    banner = `${copy[0]} 隐藏大奖`;
  }
  state.bonuses.count += 1;
  state.score += Math.round(target.score * (1 + state.bonuses.count * 0.08));
  addShockwave(target.x, target.z, cssHex(BONUS_CONFIG[target.rewardType].color), target.rewardType === 'barrier' ? 2.8 : 1.25);
  for (let i = 0; i < (target.rewardType === 'barrier' ? 22 : 10); i += 1) {
    addFxParticle(target.x, 1, target.z, cssHex(BONUS_CONFIG[target.rewardType].color), target.rewardType === 'barrier' ? 1.2 : 0.8);
  }
  showOverdriveBanner(banner);
  showToast(message, 2500);
  sfx.upgrade();
  updateHud(true);
}

function updateBonusSpawning() {
  if (state.elapsed >= state.nextBonusAt) {
    const lanes = [0, 1, 2].sort(() => state.random() - 0.5);
    const types = ['damage', 'rate', 'crit'].sort(() => state.random() - 0.5);
    createBonusTarget(types[0], lanes[0]);
    createBonusTarget(types[1], lanes[1]);
    state.nextBonusAt += 8.5 + randomBetween(0, 2.4);
    showToast('两路 Bonus 已进入：移动炮台，选择你要的永久强化', 1600);
  }
  if (state.elapsed >= state.nextBarrierAt) {
    createBonusTarget('barrier', Math.floor(state.random() * 3), WORLD.spawnZ + 2.4);
    state.nextBarrierAt += 18 + randomBetween(0, 4);
    showToast('结界出现：打穿它，炮台会继续进化', 1700);
  }
  if (state.elapsed >= state.nextMysteryAt) {
    createBonusTarget('mystery', Math.floor(state.random() * 3), WORLD.spawnZ + 1.8);
    state.nextMysteryAt += 24 + randomBetween(0, 4);
    showToast('隐藏 Bonus 出现：里面可能是倍率，也可能直接复制炮台', 1800);
  }
}

function updateBonusTargets(dt) {
  for (let index = bonusTargets.length - 1; index >= 0; index -= 1) {
    const target = bonusTargets[index];
    if (!target.active) {
      bonusTargets.splice(index, 1);
      continue;
    }
    target.z += target.speed * dt;
    target.wobble += dt * 3.5;
    target.group.position.set(target.x, 0.04 + Math.sin(target.wobble) * 0.05, target.z);
    const pulse = target.scale * (1 + Math.sin(target.wobble * 1.7) * 0.08);
    target.group.scale.setScalar(state.elapsed < target.hitUntil ? pulse * 1.12 : pulse);
    target.ring.rotation.z += dt * (target.rewardType === 'barrier' ? -1.8 : 2.6);
    target.ringMaterial.opacity = state.elapsed < target.hitUntil ? 1 : 0.72 + Math.sin(target.wobble) * 0.18;
    if (target.z >= WORLD.baseZ + 0.2) expireBonusTarget(target, true);
  }
}

function selectLane(lane) {
  state.focusLane = clamp(Number(lane) || 0, 0, 2);
  els.laneButtons.forEach((button) => button.classList.toggle('active', Number(button.dataset.lane) === state.focusLane));
}

function moveLane(direction) {
  selectLane(state.focusLane + direction);
}

function livingEnemies() {
  return enemies.filter((enemy) => enemy.active);
}

function updateSpawning(dt) {
  const theme = currentTheme();
  const progress = clamp(state.elapsed / theme.roundDuration, 0, 1);
  const living = livingEnemies();
  const nearestZ = living.reduce((max, enemy) => Math.max(max, enemy.z), WORLD.spawnZ);
  let spawnRate = (1.7 + progress * 5.5) * theme.spawnMultiplier;
  if (state.elapsed < state.frenzyUntil) spawnRate *= 10;
  if (living.length < 18 && nearestZ < 4) spawnRate *= 1.55;
  if (living.length > 360) spawnRate *= 0.42;
  if (state.bossAlive) spawnRate *= 0.62;
  state.spawnAcc += spawnRate * dt;

  while (state.spawnAcc >= 1) {
    state.spawnAcc -= 1;
    const enemy = spawnEnemy();
    if (enemy && state.elapsed < state.frenzyUntil) {
      enemy.hp *= 0.76;
      enemy.maxHp = enemy.hp;
      enemy.score = Math.round(enemy.score * 1.2);
    }
  }

  if (!state.bossSpawned && state.elapsed >= theme.bossAt) summonBoss(false);
}

function updateEnemies(dt) {
  const theme = currentTheme();
  for (const enemy of enemies) {
    if (!enemy.active) continue;
    const slowed = state.elapsed < enemy.slowUntil;
    enemy.z += enemy.speed * (slowed ? 0.44 : 1) * dt;
    enemy.wobble += dt * (enemy.type === 'runner' ? 7 : 3.2);
    enemy.x += Math.sin(enemy.wobble) * dt * 0.08;

    if (enemy.z >= WORLD.baseZ) {
      enemy.active = false;
      state.baseHp = Math.max(0, state.baseHp - enemy.baseDamage);
      state.shake = Math.max(state.shake, enemy.type === 'boss' ? 1.8 : 0.28 + enemy.scale * 0.1);
      addFxText(enemy.x, 1.2, WORLD.baseZ, `${theme.baseLabel} -${enemy.baseDamage}%`, '#ff6b57', 1.15);
      addShockwave(enemy.x, WORLD.baseZ, '#ff5f57', enemy.type === 'boss' ? 3.4 : 1.2);
      for (let i = 0; i < 8; i += 1) addFxParticle(enemy.x, 0.7, WORLD.baseZ, '#ff6b57', 0.75);
      sfx.warning();
    }
  }

  if (state.baseHp <= 0) endGame(false);
  if (state.baseHp < 30 && !state.bailoutUsed && state.mode === 'playing') {
    state.bailoutUsed = true;
    state.baseHp = Math.max(state.baseHp, 22);
    triggerOverdrive(true);
  }
}

function findTargets(lane, count = 1) {
  const rewards = bonusTargets
    .filter((target) => target.active && target.lane === lane)
    .sort((a, b) => b.z - a.z);
  if (rewards.length) return [rewards[0]];
  return enemies
    .filter((enemy) => enemy.active && enemy.lane === lane)
    .sort((a, b) => b.z - a.z)
    .slice(0, count);
}

function acquireProjectile() {
  return projectilePool.find((projectile) => !projectile.active) || null;
}

function fireProjectile(turret, target, damage) {
  const projectile = acquireProjectile();
  if (!projectile || !target) return;
  projectile.active = true;
  projectile.mesh.visible = true;
  projectile.x = turret.group.position.x + randomBetween(-0.14, 0.14);
  projectile.y = 1.02;
  projectile.z = 9.1;
  projectile.target = target;
  projectile.damage = damage;
  projectile.lane = state.focusLane;
  projectile.mesh.position.set(projectile.x, projectile.y, projectile.z);
  turret.recoil = 1;
  state.telemetry.shots += 1;
}

function currentCombatStats() {
  const overdrive = state.elapsed < state.overdriveUntil;
  return {
    overdrive,
    fireInterval: 0.24
      / (1 + (state.levels.rate - 1) * 0.22)
      / state.bonuses.rate
      / (overdrive ? 2.4 : 1),
    damage: 22
      * Math.pow(1.5, state.levels.damage - 1)
      * state.bonuses.damage
      * (overdrive ? 2.45 : 1),
  };
}

function updateTurrets(dt) {
  const cannonCount = Math.min(3, state.levels.cannon);
  const laneX = WORLD.lanes[state.focusLane];
  focusLaneGlow.position.x = lerp(focusLaneGlow.position.x, laneX, Math.min(1, dt * 10));
  focusRail.position.x = lerp(focusRail.position.x, laneX, Math.min(1, dt * 12));
  const combat = currentCombatStats();
  const baseInterval = combat.fireInterval;
  const baseDamage = combat.damage;
  const targetCount = 1 + Math.min(3, state.levels.multi);
  const targets = findTargets(state.focusLane, targetCount);
  const offsets = cannonCount === 1 ? [0] : cannonCount === 2 ? [-0.72, 0.72] : [-1.05, 0, 1.05];

  turretGroups.forEach((turret, index) => {
    const active = index < cannonCount;
    turret.group.visible = active;
    if (!active) {
      turret.recoil = 0;
      turret.pivot.position.z = 0;
      return;
    }
    const targetX = laneX + offsets[index];
    turret.group.position.x = lerp(turret.group.position.x, targetX, Math.min(1, dt * 11));
    if (targets[0]) {
      const dx = targets[0].x - turret.group.position.x;
      const dz = targets[0].z - 10.2;
      turret.targetRotation = -Math.atan2(dx, -dz);
    }
    turret.pivot.rotation.y = lerp(turret.pivot.rotation.y, turret.targetRotation, Math.min(1, dt * 9));
    turret.recoil = Math.max(0, turret.recoil - dt * 11);
    turret.pivot.position.z = turret.recoil * 0.16;
    const scale = 1.14 + (state.focusLane === 1 ? 0.02 : 0);
    turret.group.scale.lerp(new THREE.Vector3(scale, scale, scale), Math.min(1, dt * 8));
    state.fireAcc[index] += dt;
    const aligned = Math.abs(turret.group.position.x - targetX) < 0.28;
    let safety = 0;
    while (aligned && state.fireAcc[index] >= baseInterval && targets.length && safety < 7) {
      state.fireAcc[index] -= baseInterval;
      targets.forEach((target, targetIndex) => fireProjectile(turret, target, baseDamage * (targetIndex ? 0.78 : 1)));
      safety += 1;
      if (performance.now() - state.lastShotSoundAt > 48) {
        state.lastShotSoundAt = performance.now();
        sfx.shoot();
      }
    }
  });
}

function retireProjectile(projectile) {
  projectile.active = false;
  projectile.target = null;
  projectile.mesh.visible = false;
}

function updateProjectiles(dt) {
  for (const projectile of projectilePool) {
    if (!projectile.active) continue;
    const target = projectile.target;
    if (!target?.active) {
      retireProjectile(projectile);
      continue;
    }
    const targetY = target.kind === 'bonus' ? 1.05 * target.scale : 0.68 * target.scale;
    const dx = target.x - projectile.x;
    const dy = targetY - projectile.y;
    const dz = target.z - projectile.z;
    const distance = Math.hypot(dx, dy, dz);
    const step = 25 * dt;
    if (distance <= step + target.scale * 0.25) {
      projectile.x = target.x;
      projectile.y = targetY;
      projectile.z = target.z;
      applyDamage(target, projectile.damage, { primary: true });
      retireProjectile(projectile);
      continue;
    }
    projectile.x += (dx / distance) * step;
    projectile.y += (dy / distance) * step;
    projectile.z += (dz / distance) * step;
    projectile.mesh.position.set(projectile.x, projectile.y, projectile.z);
  }
}

function applyDamage(enemy, amount, options = {}) {
  if (!enemy?.active) return;
  if (enemy.kind === 'bonus') {
    let bonusDamage = amount;
    const bonusCriticalChance = 0.06 + state.levels.crit * 0.085 + state.bonuses.crit;
    const bonusCritical = options.primary && state.random() < bonusCriticalChance;
    if (bonusCritical) bonusDamage *= 1.8 + state.levels.crit * 0.18;
    enemy.hp -= bonusDamage;
    enemy.hitUntil = Math.max(enemy.hitUntil, state.elapsed + (bonusCritical ? 0.16 : 0.09));
    const ratio = clamp(enemy.hp / enemy.maxHp, 0, 1);
    addFxText(
      enemy.x,
      1.35 * enemy.scale,
      enemy.z,
      enemy.hp > 0 ? `${bonusCritical ? '暴击 ' : ''}${Math.ceil(ratio * 100)}%` : 'BREAK!',
      bonusCritical ? '#ffd84f' : cssHex(BONUS_CONFIG[enemy.rewardType].color),
      0.75,
      bonusCritical ? 16 : 12,
    );
    state.shake = Math.max(state.shake, bonusCritical ? 0.18 : 0.06);
    if (enemy.hp <= 0) {
      grantBonus(enemy);
      expireBonusTarget(enemy);
    }
    return;
  }
  let damage = amount;
  let critical = false;
  if (options.primary) {
    const criticalChance = 0.06 + state.levels.crit * 0.085 + state.bonuses.crit;
    if (state.random() < criticalChance) {
      critical = true;
      damage *= 1.8 + state.levels.crit * 0.18;
    }
  }

  enemy.hp -= damage;
  enemy.hitUntil = Math.max(enemy.hitUntil, state.elapsed + (critical ? 0.15 : 0.085));
  addFxText(enemy.x, 0.8 * enemy.scale, enemy.z, `${critical ? '暴击 ' : ''}${Math.round(damage)}`, critical ? '#ffd84f' : '#e9fff9', critical ? 1.2 : 0.78, critical ? 17 : 12);
  for (let i = 0; i < (critical ? 5 : 2); i += 1) addFxParticle(enemy.x, 0.7, enemy.z, critical ? '#ffd84f' : '#4fffd2', critical ? 0.85 : 0.5);
  state.shake = Math.max(state.shake, critical ? 0.16 : 0.04);

  if (options.primary && state.levels.frost > 0 && state.random() < 0.1 + state.levels.frost * 0.08) {
    enemy.slowUntil = Math.max(enemy.slowUntil, state.elapsed + 2.2 + state.levels.frost * 0.2);
  }

  if (options.primary && state.levels.blast > 0) {
    const radius = 0.65 + state.levels.blast * 0.58;
    addShockwave(enemy.x, enemy.z, '#ff9f43', radius);
    for (const other of enemies) {
      if (!other.active || other === enemy) continue;
      const distance = Math.hypot(other.x - enemy.x, other.z - enemy.z);
      if (distance <= radius) applyDamage(other, damage * 0.34, { splash: true });
    }
  }

  if (options.primary && state.levels.chain > 0 && state.random() < 0.16 + state.levels.chain * 0.1) {
    const candidates = enemies
      .filter((other) => other.active && other !== enemy && other.lane === enemy.lane && Math.hypot(other.x - enemy.x, other.z - enemy.z) < 5.4)
      .sort((a, b) => Math.hypot(a.x - enemy.x, a.z - enemy.z) - Math.hypot(b.x - enemy.x, b.z - enemy.z))
      .slice(0, state.levels.chain + 1);
    let source = enemy;
    for (const target of candidates) {
      lightningItems.push({
        ax: source.x, ay: 0.8 * source.scale, az: source.z,
        bx: target.x, by: 0.8 * target.scale, bz: target.z,
        life: 0.14, maxLife: 0.14,
      });
      applyDamage(target, damage * 0.42, { chain: true });
      source = target;
    }
  }

  if (enemy.hp <= 0) killEnemy(enemy, critical);
}

function killEnemy(enemy, critical = false) {
  const theme = currentTheme();
  if (!enemy.active) return;
  enemy.active = false;
  state.kills += 1;
  state.combo = state.elapsed <= state.comboUntil ? Math.min(999, state.combo + 1) : 1;
  state.comboUntil = state.elapsed + 1.35;
  state.maxCombo = Math.max(state.maxCombo, state.combo);
  const comboBonus = 1 + Math.min(2.5, state.combo / 80);
  state.score += Math.round(enemy.score * comboBonus * (critical ? 1.18 : 1));
  state.shake = Math.max(state.shake, enemy.type === 'boss' ? 1.45 : 0.08 * enemy.scale);
  addShockwave(
    enemy.x,
    enemy.z,
    enemy.type === 'boss' ? cssHex(theme.palette.enemies.boss) : theme.palette.secondary,
    enemy.type === 'boss' ? 5.5 : 0.7 + enemy.scale * 0.4,
  );
  const particles = enemy.type === 'boss' ? 55 : Math.min(14, 4 + Math.round(enemy.scale * 4));
  for (let i = 0; i < particles; i += 1) {
    addFxParticle(
      enemy.x,
      enemy.scale * 0.7,
      enemy.z,
      enemy.type === 'boss' ? cssHex(theme.palette.enemies.boss) : theme.palette.secondary,
      enemy.type === 'boss' ? 1.6 : 0.75,
    );
  }

  if (enemy.type === 'boss') {
    state.bossAlive = false;
    state.bossDefeated = true;
    state.finishAt = state.elapsed + 1.8;
    els.bossHud.classList.add('hidden');
    showOverdriveBanner(theme.victoryBanner);
    showToast(theme.victoryToast, 2600);
    sfx.victory();
  } else if (performance.now() - state.lastKillSoundAt > 105) {
    state.lastKillSoundAt = performance.now();
    sfx.hit();
  }
}

function addShockwave(x, z, color, maxScale = 1) {
  if (shockwaves.length > 35) return;
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.25, 0.34, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.03, z);
  worldGroup.add(mesh);
  shockwaves.push({ mesh, life: 0.42, maxLife: 0.42, maxScale });
}

function updateShockwaves(dt) {
  for (let index = shockwaves.length - 1; index >= 0; index -= 1) {
    const wave = shockwaves[index];
    wave.life -= dt;
    const progress = 1 - wave.life / wave.maxLife;
    const scale = 0.3 + progress * wave.maxScale;
    wave.mesh.scale.setScalar(scale);
    wave.mesh.material.opacity = Math.max(0, (1 - progress) * 0.82);
    if (wave.life <= 0) {
      worldGroup.remove(wave.mesh);
      wave.mesh.material.dispose();
      shockwaves.splice(index, 1);
    }
  }
}

function addFxText(x, y, z, text, color = '#ffffff', life = 0.8, size = 12) {
  if (fxItems.length > 170) fxItems.splice(0, 20);
  fxItems.push({ kind: 'text', x, y, z, text, color, life, maxLife: life, size, vy: 1.25 });
}

function addFxParticle(x, y, z, color, power = 1) {
  if (fxItems.length > 190) return;
  fxItems.push({
    kind: 'particle', x, y, z, color,
    vx: randomBetween(-2.4, 2.4) * power,
    vy: randomBetween(1.2, 4.2) * power,
    vz: randomBetween(-2.1, 2.1) * power,
    life: randomBetween(0.32, 0.72),
    maxLife: 0.72,
    size: randomBetween(2, 5) * power,
  });
}

function updateFx(dt) {
  for (let index = fxItems.length - 1; index >= 0; index -= 1) {
    const item = fxItems[index];
    item.life -= dt;
    if (item.kind === 'text') {
      item.y += item.vy * dt;
      item.vy *= Math.pow(0.3, dt);
    } else {
      item.x += item.vx * dt;
      item.y += item.vy * dt;
      item.z += item.vz * dt;
      item.vy -= 7.2 * dt;
      item.vx *= Math.pow(0.18, dt);
      item.vz *= Math.pow(0.18, dt);
    }
    if (item.life <= 0) fxItems.splice(index, 1);
  }
  for (let index = lightningItems.length - 1; index >= 0; index -= 1) {
    lightningItems[index].life -= dt;
    if (lightningItems[index].life <= 0) lightningItems.splice(index, 1);
  }
}

function projectToScreen(x, y, z) {
  const vector = new THREE.Vector3(x, y, z).project(camera);
  const width = els.stage.clientWidth;
  const height = els.stage.clientHeight;
  return {
    x: (vector.x * 0.5 + 0.5) * width,
    y: (-vector.y * 0.5 + 0.5) * height,
    visible: vector.z > -1 && vector.z < 1,
  };
}

function wrapSpeechText(text, maxWidth) {
  const lines = [];
  let line = '';
  for (const character of [...text]) {
    const candidate = `${line}${character}`;
    if (line && fxCtx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = character;
      if (lines.length === 2) break;
    } else {
      line = candidate;
    }
  }
  if (line && lines.length < 2) lines.push(line);
  if (lines.length === 2 && lines.join('').length < text.length) {
    while (lines[1].length > 1 && fxCtx.measureText(`${lines[1]}…`).width > maxWidth) lines[1] = lines[1].slice(0, -1);
    lines[1] = `${lines[1]}…`;
  }
  return lines;
}

function renderSpeechBubble(bubble, stageWidth, stageHeight) {
  const enemy = bubble.enemy;
  if (!enemy?.active) return;
  const point = projectToScreen(enemy.x, Math.max(1.75, enemy.scale * 1.75), enemy.z);
  if (!point.visible || point.x < -80 || point.x > stageWidth + 80 || point.y < 20 || point.y > stageHeight - 30) return;
  const progress = clamp(bubble.life / bubble.maxLife, 0, 1);
  const alpha = Math.min(1, (1 - progress) * 7, progress * 4.5);
  const fontSize = stageWidth < 620 ? 10 : 12;
  const maxTextWidth = stageWidth < 620 ? 126 : 176;
  fxCtx.save();
  fxCtx.font = `800 ${fontSize}px Inter, system-ui, sans-serif`;
  const lines = wrapSpeechText(bubble.text, maxTextWidth);
  const lineHeight = fontSize + 4;
  const widest = Math.max(...lines.map((line) => fxCtx.measureText(line).width), 60);
  const bubbleWidth = Math.min(maxTextWidth + 22, widest + 22);
  const bubbleHeight = lines.length * lineHeight + 16;
  const left = clamp(point.x - bubbleWidth / 2, 8, stageWidth - bubbleWidth - 8);
  const top = clamp(point.y - bubbleHeight - 18, 68, stageHeight - bubbleHeight - 22);
  const tailX = clamp(point.x, left + 16, left + bubbleWidth - 16);
  const accent = currentTheme().palette.accent;
  fxCtx.globalAlpha = alpha;
  fxCtx.fillStyle = 'rgba(4, 12, 21, 0.94)';
  fxCtx.strokeStyle = accent;
  fxCtx.lineWidth = 1.4;
  fxCtx.shadowColor = accent;
  fxCtx.shadowBlur = 10;
  fxCtx.beginPath();
  fxCtx.roundRect(left, top, bubbleWidth, bubbleHeight, 9);
  fxCtx.fill();
  fxCtx.stroke();
  fxCtx.shadowBlur = 0;
  fxCtx.beginPath();
  fxCtx.moveTo(tailX - 6, top + bubbleHeight - 1);
  fxCtx.lineTo(tailX, top + bubbleHeight + 8);
  fxCtx.lineTo(tailX + 7, top + bubbleHeight - 1);
  fxCtx.closePath();
  fxCtx.fill();
  fxCtx.stroke();
  fxCtx.fillStyle = '#f4fbff';
  fxCtx.textAlign = 'center';
  fxCtx.textBaseline = 'middle';
  lines.forEach((line, index) => {
    fxCtx.fillText(line, left + bubbleWidth / 2, top + 9 + lineHeight * (index + 0.5));
  });
  fxCtx.restore();
}

function renderFx() {
  const width = els.stage.clientWidth;
  const height = els.stage.clientHeight;
  fxCtx.clearRect(0, 0, width, height);

  for (const line of lightningItems) {
    const a = projectToScreen(line.ax, line.ay, line.az);
    const b = projectToScreen(line.bx, line.by, line.bz);
    if (!a.visible || !b.visible) continue;
    const alpha = clamp(line.life / line.maxLife, 0, 1);
    fxCtx.save();
    fxCtx.globalAlpha = alpha;
    fxCtx.strokeStyle = '#d9c2ff';
    fxCtx.lineWidth = 2.4;
    fxCtx.shadowColor = '#9b6cff';
    fxCtx.shadowBlur = 11;
    fxCtx.beginPath();
    fxCtx.moveTo(a.x, a.y);
    const midX = (a.x + b.x) / 2 + randomBetween(-10, 10);
    const midY = (a.y + b.y) / 2 + randomBetween(-10, 10);
    fxCtx.quadraticCurveTo(midX, midY, b.x, b.y);
    fxCtx.stroke();
    fxCtx.restore();
  }

  for (const item of fxItems) {
    const point = projectToScreen(item.x, item.y, item.z);
    if (!point.visible) continue;
    const alpha = clamp(item.life / item.maxLife, 0, 1);
    fxCtx.save();
    fxCtx.globalAlpha = alpha;
    if (item.kind === 'text') {
      fxCtx.fillStyle = item.color;
      fxCtx.font = `900 ${item.size}px Inter, system-ui, sans-serif`;
      fxCtx.textAlign = 'center';
      fxCtx.shadowColor = item.color;
      fxCtx.shadowBlur = 8;
      fxCtx.fillText(item.text, point.x, point.y);
    } else {
      fxCtx.fillStyle = item.color;
      fxCtx.shadowColor = item.color;
      fxCtx.shadowBlur = 8;
      fxCtx.beginPath();
      fxCtx.arc(point.x, point.y, item.size * alpha, 0, Math.PI * 2);
      fxCtx.fill();
    }
    fxCtx.restore();
  }

  for (const bubble of speechBubbles) renderSpeechBubble(bubble, width, height);
}

function showUpgrade() {
  if (state.mode !== 'playing') return;
  const available = upgrades.filter((upgrade) => {
    if (upgrade.id === 'repair') return state.baseHp < 78;
    return state.levels[upgrade.id] < upgrade.max;
  });
  for (let index = available.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(state.random() * (index + 1));
    [available[index], available[swap]] = [available[swap], available[index]];
  }
  state.currentUpgrades = available.slice(0, 3);
  while (state.currentUpgrades.length < 3) state.currentUpgrades.push(upgrades.find((upgrade) => upgrade.id === 'repair'));
  state.mode = 'upgrade';
  state.upgradeDeadline = performance.now() + 7000;
  els.upgradeOptions.innerHTML = '';
  state.currentUpgrades.forEach((upgrade, index) => {
    const presentation = upgradePresentation(upgrade);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'upgrade-option';
    button.style.setProperty('--upgrade-color', upgrade.color);
    const currentLevel = upgrade.id === 'repair' ? '即时生效' : `当前 Lv.${state.levels[upgrade.id] || 0}`;
    button.innerHTML = `
      <span class="upgrade-index">${index + 1}</span>
      <span class="upgrade-icon">${upgrade.icon}</span>
      <b>${presentation.title}</b>
      <p>${presentation.description}</p>
      <small>${currentLevel}</small>
    `;
    button.addEventListener('click', () => selectUpgrade(index));
    els.upgradeOptions.appendChild(button);
  });
  setOverlay(els.upgradeOverlay, true);
  sfx.upgrade();
}

function selectUpgrade(index) {
  if (state.mode !== 'upgrade') return;
  const upgrade = state.currentUpgrades[index];
  if (!upgrade) return;
  const presentation = upgradePresentation(upgrade);
  upgrade.apply();
  state.telemetry.upgrades += 1;
  state.mode = 'playing';
  state.lastTs = performance.now();
  state.nextUpgradeAt += currentTheme().upgradeInterval;
  setOverlay(els.upgradeOverlay, false);
  showToast(`${upgrade.icon} ${presentation.title} 已安装：${presentation.description}`);
  updateHud(true);
}

function updateUpgradeCountdown(now) {
  if (state.mode !== 'upgrade') return;
  if (!els.autoPickInput.checked) {
    els.upgradeCountdown.textContent = '直播自动选择已关闭，等待你的决定';
    return;
  }
  const seconds = Math.max(0, Math.ceil((state.upgradeDeadline - now) / 1000));
  els.upgradeCountdown.textContent = `自动选择倒计时 ${seconds} 秒`;
  if (seconds <= 0) selectUpgrade(0);
}

function updateGame(dt) {
  const theme = currentTheme();
  state.elapsed += dt;
  if (state.elapsed > state.comboUntil) state.combo = 1;

  updateSpawning(dt);
  updateBonusSpawning();
  updateCharacterSpeech(dt);
  updateEnemies(dt);
  updateBonusTargets(dt);
  if (state.mode !== 'playing') return;
  updateTurrets(dt);
  updateProjectiles(dt);
  updateShockwaves(dt);
  updateFx(dt);

  if (state.elapsed >= state.nextUpgradeAt && !state.bossDefeated) showUpgrade();
  if (state.bossDefeated && state.finishAt && state.elapsed >= state.finishAt) endGame(true);
  if (state.elapsed >= theme.roundDuration && !state.bossSpawned) summonBoss(false);
}

function endGame(victory) {
  const theme = currentTheme();
  if (!['playing', 'upgrade'].includes(state.mode)) return;
  state.mode = 'result';
  setOverlay(els.upgradeOverlay, false);
  els.resultEyebrow.textContent = victory ? `RUN COMPLETE / ${theme.english}` : `SIMULATION FAILED / ${theme.english}`;
  els.resultTitle.textContent = victory ? theme.victoryTitle : theme.defeatTitle;
  els.resultDescription.textContent = victory ? theme.victoryDescription : theme.defeatDescription;
  els.finalScore.textContent = formatScore(state.score);
  els.finalKills.textContent = formatScore(state.kills);
  els.finalCombo.textContent = `×${state.maxCombo}`;
  els.finalRank.textContent = '提交中';
  els.newBestBadge.classList.add('hidden');
  setOverlay(els.resultOverlay, true);
  submitRun(victory);
}

function renderEnemies() {
  const counts = { normal: 0, runner: 0, tank: 0, elite: 0, boss: 0 };
  let shadowCount = 0;
  let boss = null;
  for (const enemy of enemies) {
    if (!enemy.active) continue;
    const visual = enemyVisuals[enemy.type] || enemyVisuals.normal;
    const index = counts[enemy.type] || 0;
    if (index >= WORLD.maxEnemies) continue;
    const slowed = state.elapsed < enemy.slowUntil;
    const hit = state.elapsed < enemy.hitUntil;
    const stride = Math.sin(enemy.wobble * 2.15);
    matrixDummy.position.set(enemy.x, 0.025 + Math.abs(stride) * 0.045, enemy.z);
    const squash = 1 + stride * (enemy.type === 'runner' ? 0.085 : 0.045);
    const frozenScale = slowed ? 0.94 : 1;
    matrixDummy.scale.set(enemy.scale * squash * frozenScale, enemy.scale / squash, enemy.scale);
    matrixDummy.rotation.set(-0.72, 0, stride * (enemy.type === 'runner' ? 0.105 : 0.055));
    matrixDummy.updateMatrix();
    visual.mesh.setMatrixAt(index, matrixDummy.matrix);
    enemyTint.setHex(hit ? 0xff6d78 : slowed ? 0x79d9ff : 0xffffff);
    visual.mesh.setColorAt(index, enemyTint);

    shadowDummy.position.set(enemy.x, -0.065, enemy.z + 0.34 * enemy.scale);
    shadowDummy.rotation.set(0, 0, 0);
    shadowDummy.scale.set(enemy.scale * visual.shadow * (hit ? 1.12 : 1), 1, enemy.scale * visual.shadow * 0.7);
    shadowDummy.updateMatrix();
    enemyShadowMesh.setMatrixAt(shadowCount, shadowDummy.matrix);
    shadowCount += 1;
    if (enemy.type === 'boss') boss = enemy;
    counts[enemy.type] = index + 1;
  }
  for (const [type, visual] of Object.entries(enemyVisuals)) {
    visual.mesh.count = counts[type] || 0;
    visual.mesh.instanceMatrix.needsUpdate = true;
    if (visual.mesh.instanceColor) visual.mesh.instanceColor.needsUpdate = true;
  }
  enemyShadowMesh.count = shadowCount;
  enemyShadowMesh.instanceMatrix.needsUpdate = true;

  if (boss?.active) {
    const ratio = clamp(boss.hp / boss.maxHp, 0, 1);
    els.bossHpFill.style.width = `${ratio * 100}%`;
    els.bossHpText.textContent = `${Math.ceil(ratio * 100)}%`;
  }
}

function updateHud(force = false) {
  const theme = currentTheme();
  const now = performance.now();
  if (!force && now - state.lastUiAt < 90) return;
  state.lastUiAt = now;
  els.score.textContent = formatScore(state.score);
  els.kills.textContent = formatScore(state.kills);
  els.combo.textContent = `×${state.combo}`;
  const remaining = Math.max(0, Math.ceil(theme.roundDuration - state.elapsed));
  els.time.textContent = remaining > 0 ? String(remaining) : state.bossAlive ? 'BOSS' : '0';
  els.baseHpText.textContent = `${Math.ceil(state.baseHp)}%`;
  els.baseHpFill.style.width = `${clamp(state.baseHp, 0, 100)}%`;
  els.shell.classList.toggle('danger-state', state.baseHp < 30 && state.mode === 'playing');
  els.damageLevel.textContent = `Lv.${state.levels.damage}`;
  els.rateLevel.textContent = `Lv.${state.levels.rate}`;
  els.blastLevel.textContent = `Lv.${state.levels.blast}`;
  els.chainLevel.textContent = `Lv.${state.levels.chain}`;
  els.frostLevel.textContent = `Lv.${state.levels.frost}`;
  els.bonusDamageValue.textContent = `×${state.bonuses.damage.toFixed(2)}`;
  els.bonusRateValue.textContent = `×${state.bonuses.rate.toFixed(2)}`;
  els.cannonCountValue.textContent = `${state.levels.cannon} / 3`;
  els.cannonShardValue.textContent = state.levels.cannon >= 3 ? 'MAX' : `${state.bonuses.shards} / 2`;
  els.bonusCountValue.textContent = `BONUS ×${state.bonuses.count}`;
  const frenzyRemaining = Math.max(0, state.frenzyUntil - state.elapsed);
  const overdriveRemaining = Math.max(0, state.overdriveUntil - state.elapsed);
  els.frenzyBtn.classList.toggle('active', frenzyRemaining > 0);
  els.overdriveBtn.classList.toggle('active', overdriveRemaining > 0);
  els.bossBtn.classList.toggle('active', state.bossAlive);
  els.frenzyBtn.setAttribute('aria-pressed', frenzyRemaining > 0 ? 'true' : 'false');
  els.overdriveBtn.setAttribute('aria-pressed', overdriveRemaining > 0 ? 'true' : 'false');
  els.bossBtn.setAttribute('aria-pressed', state.bossAlive ? 'true' : 'false');
  els.frenzyDescription.textContent = frenzyRemaining > 0
    ? `生效中 ${frenzyRemaining.toFixed(1)} 秒 · 实际敌潮 ×10`
    : `${theme.director.frenzyDescription}${state.telemetry.frenzyUses ? ` · 已触发 ${state.telemetry.frenzyUses} 次` : ''}`;
  els.overdriveDescription.textContent = overdriveRemaining > 0
    ? `生效中 ${overdriveRemaining.toFixed(1)} 秒 · 伤害 ×2.45 / 射速 ×2.4`
    : `${theme.director.overdriveDescription}${state.telemetry.overdriveUses ? ` · 已触发 ${state.telemetry.overdriveUses} 次` : ''}`;
  els.bossButtonDescription.textContent = state.bossAlive
    ? '已登场 · 固定中路 · 仅当前路可攻击'
    : state.bossSpawned
      ? '本局 Boss 已处理，不能重复召唤'
      : theme.director.bossDescription;
  els.frenzyBtn.disabled = state.mode !== 'playing';
  els.overdriveBtn.disabled = state.mode !== 'playing';
  els.bossBtn.disabled = state.mode !== 'playing' || state.bossSpawned;
  baseLight.intensity = state.elapsed < state.overdriveUntil ? 34 : 18;
  baseLight.color.setHex(state.elapsed < state.overdriveUntil ? 0xffd84f : state.baseHp < 30 ? 0xff5f57 : theme.palette.core);
  wallMaterial.emissive.setHex(state.baseHp < 30 ? 0x66141a : state.elapsed < state.overdriveUntil ? 0x5c4810 : theme.palette.wallEmissive);
}

function renderScene(dt) {
  renderEnemies();
  state.shake = Math.max(0, state.shake - dt * 2.7);
  const shakeAmount = state.shake * state.shake;
  camera.position.set(
    cameraHome.x + randomBetween(-shakeAmount, shakeAmount),
    cameraHome.y + randomBetween(-shakeAmount * 0.35, shakeAmount * 0.35),
    cameraHome.z + randomBetween(-shakeAmount, shakeAmount),
  );
  renderer.render(scene, camera);
  renderFx();
}

function frame(now) {
  const rawDt = clamp((now - state.lastTs) / 1000, 0, 0.05);
  state.lastTs = now;
  if (state.mode === 'playing') updateGame(rawDt * state.speed);
  else if (state.mode === 'upgrade') updateUpgradeCountdown(now);
  updateHud();
  renderScene(rawDt);
  requestAnimationFrame(frame);
}

function renderLeaderboard(rows) {
  els.leaderboardList.innerHTML = '';
  if (!Array.isArray(rows) || !rows.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '还没有战绩，你可以拿下第一名。';
    els.leaderboardList.appendChild(empty);
    return;
  }
  rows.slice(0, 8).forEach((row) => {
    const item = document.createElement('li');
    const name = document.createElement('b');
    const score = document.createElement('em');
    name.textContent = row.display_name || row.username || '匿名玩家';
    score.textContent = formatScore(row.score || 0);
    item.append(name, score);
    els.leaderboardList.appendChild(item);
  });
}

async function loadIdentity() {
  try {
    const result = await extCall({ action: 'whoami' });
    if (result?.ok) els.identity.textContent = result.display_name || result.username || '玩家';
  } catch {
    els.identity.textContent = '本地玩家';
  }
}

async function loadLeaderboard() {
  const requestedTheme = state.themeId;
  try {
    const result = await extCall({ action: 'get_leaderboard', theme: requestedTheme });
    if (state.themeId !== requestedTheme) return;
    if (result?.ok) renderLeaderboard(result.leaderboard);
    else renderLeaderboard([]);
  } catch {
    if (state.themeId === requestedTheme) renderLeaderboard([]);
  }
}

async function submitRun(victory) {
  const localKey = `toy-toy-toy-high-score-${state.themeId}`;
  const previousLocal = Number(localStorage.getItem(localKey) || 0);
  const localBest = state.score > previousLocal;
  if (localBest) localStorage.setItem(localKey, String(Math.round(state.score)));
  try {
    const result = await extCall({
      action: 'submit_run',
      theme: state.themeId,
      score: Math.round(state.score),
      kills: state.kills,
      duration: Math.round(state.elapsed),
      victory,
      seed: state.seed,
    });
    if (!result?.ok) throw new Error(result?.error || 'submit failed');
    els.finalRank.textContent = result.rank ? `#${result.rank}` : '100+';
    els.newBestBadge.classList.toggle('hidden', !(result.is_best || localBest));
    renderLeaderboard(result.leaderboard);
  } catch {
    els.finalRank.textContent = '本地';
    els.newBestBadge.classList.toggle('hidden', !localBest);
  }
}

window.__TOY_TOY_TOY_DEBUG__ = Object.freeze({
  snapshot() {
    const combat = currentCombatStats();
    return {
      version: '0.6.0',
      mode: state.mode,
      theme: state.themeId,
      elapsed: state.elapsed,
      speed: state.speed,
      focusLane: state.focusLane,
      livingEnemies: livingEnemies().length,
      activeBonusTargets: bonusTargets.filter((target) => target.active).map((target) => target.rewardType),
      activeSpeech: speechBubbles.map((bubble) => ({ type: bubble.enemy?.type, text: bubble.text })),
      effects: {
        frenzyRemaining: Math.max(0, state.frenzyUntil - state.elapsed),
        overdriveRemaining: Math.max(0, state.overdriveUntil - state.elapsed),
        bossSpawned: state.bossSpawned,
        bossAlive: state.bossAlive,
      },
      combat: {
        damage: combat.damage,
        fireInterval: combat.fireInterval,
        cannonCount: state.levels.cannon,
        targetCount: 1 + Math.min(3, state.levels.multi),
      },
      bonuses: { ...state.bonuses },
      levels: { ...state.levels },
      telemetry: { ...state.telemetry },
      controls: {
        autoPick: els.autoPickInput.checked,
        muted,
        frenzyDisabled: els.frenzyBtn.disabled,
        overdriveDisabled: els.overdriveBtn.disabled,
        bossDisabled: els.bossBtn.disabled,
      },
    };
  },
});

els.startBtn.addEventListener('click', startGame);
els.themeButtons.forEach((button) => button.addEventListener('click', () => {
  if (state.mode !== 'menu') return;
  applyTheme(button.dataset.theme);
  updateHud(true);
}));
els.againBtn.addEventListener('click', startGame);
els.menuBtn.addEventListener('click', showMenu);
els.pauseBtn.addEventListener('click', () => togglePause());
els.resumeBtn.addEventListener('click', () => togglePause(true));
els.restartBtn.addEventListener('click', startGame);
els.frenzyBtn.addEventListener('click', triggerFrenzy);
els.overdriveBtn.addEventListener('click', () => triggerOverdrive(false));
els.bossBtn.addEventListener('click', () => summonBoss(true));
els.directorToggle.addEventListener('click', () => {
  const collapsed = els.directorPanel.classList.toggle('collapsed');
  els.directorToggle.textContent = collapsed ? '+' : '−';
  els.directorToggle.setAttribute('aria-label', collapsed ? '展开导演台' : '收起导演台');
});
els.speedRange.addEventListener('input', () => {
  state.speed = Number(els.speedRange.value);
  els.speedLabel.textContent = `${state.speed}×`;
});
els.soundBtn.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('toy-toy-toy-muted', muted ? '1' : '0');
  els.soundBtn.textContent = muted ? '声音 OFF' : '声音 ON';
  if (!muted) {
    ensureAudio();
    tone(660, 0.09, 'triangle', 0.04);
  }
});
els.laneButtons.forEach((button) => button.addEventListener('click', () => selectLane(Number(button.dataset.lane))));

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (state.mode !== 'playing') return;
  const rect = renderer.domElement.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  selectLane(x < 0.36 ? 0 : x > 0.64 ? 2 : 1);
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyP' || event.code === 'Escape') {
    if (state.mode === 'playing' || state.mode === 'paused') togglePause();
    return;
  }
  if (state.mode === 'upgrade' && ['Digit1', 'Digit2', 'Digit3'].includes(event.code)) {
    selectUpgrade(Number(event.code.slice(-1)) - 1);
    return;
  }
  if (state.mode !== 'playing') return;
  if (event.code === 'KeyA' || event.code === 'ArrowLeft') moveLane(-1);
  else if (event.code === 'KeyS' || event.code === 'ArrowDown') selectLane(1);
  else if (event.code === 'KeyD' || event.code === 'ArrowRight') moveLane(1);
  else if (event.code === 'Space') {
    event.preventDefault();
    triggerOverdrive(false);
  }
});

window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.mode === 'playing') togglePause();
});

els.soundBtn.textContent = muted ? '声音 OFF' : '声音 ON';
els.autoPickInput.checked = localStorage.getItem('toy-toy-toy-auto-pick') !== '0';
els.autoPickInput.addEventListener('change', () => {
  localStorage.setItem('toy-toy-toy-auto-pick', els.autoPickInput.checked ? '1' : '0');
});

if (window.matchMedia('(max-width: 760px)').matches) {
  els.directorPanel.classList.add('collapsed');
  els.directorToggle.textContent = '+';
  els.directorToggle.setAttribute('aria-label', '展开导演台');
}

resize();
applyTheme(state.themeId, { persist: false, refreshLeaderboard: false });
resetGame();
Promise.allSettled([loadIdentity(), loadLeaderboard()]);
requestAnimationFrame(frame);
