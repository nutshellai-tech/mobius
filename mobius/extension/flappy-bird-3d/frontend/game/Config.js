// game/Config.js — 全局配置 / 调参
export const CONFIG = {
  // 世界
  world: {
    laneWidth: 7,
    ceilingY: 7.5,
    floorY: -7.5,
    fogNear: 18,
    fogFar: 95,
    bg: 0x05030f,
  },

  // 小鸟
  bird: {
    radius: 0.6,
    gravity: -32,
    flapVelocity: 11.2,
    maxFallSpeed: -28,
    tiltMin: -Math.PI / 3.2,
    tiltMax: Math.PI / 2.4,
    startX: -2,
    startY: 0,
    startZ: 0,
  },

  // 管道
  pipe: {
    spacing: 9,         // 相邻管道 X 距离
    gap: 3.6,           // 上下间隙
    pipeRadius: 1.5,
    pipeThickness: 0.45,
    initialOffset: 16,  // 第一根管道距离起点
    scrollSpeed: 9,     // 基础前移速度
    speedRamp: 0.012,   // 每分加速
    speedMax: 16,
    wallHeight: 16,
  },

  // 道具
  powerup: {
    spawnEveryN: 4,     // 每 N 根管道尝试生成一个
    spawnChance: 0.65,
    radius: 0.55,
    pickupRadius: 1.5,
  },

  // 道具效果时长 (秒)
  effects: {
    shield: Infinity,   // 一次性
    magnet: 5,
    slow: 3,
    double: 8,
    tiny: 6,
  },

  // 颜色
  colors: {
    cyan: 0x00f0ff,
    pink: 0xff2bd6,
    purple: 0xb026ff,
    yellow: 0xffe600,
    green: 0x39ff14,
    orange: 0xff8a3d,
  },
};

export const PIPE_PALETTE = [
  0x00f0ff,
  0xff2bd6,
  0xb026ff,
  0xff8a3d,
];

export const POWERUP_TYPES = ['shield', 'magnet', 'slow', 'double', 'tiny'];

export const POWERUP_META = {
  shield: { color: 0x00f0ff, hex: '#00f0ff', label: 'SHD', icon: '◈' },
  magnet: { color: 0xb026ff, hex: '#b026ff', label: 'MAG', icon: '✦' },
  slow:   { color: 0x39ff14, hex: '#39ff14', label: 'SLO', icon: '◷' },
  double: { color: 0xffe600, hex: '#ffe600', label: 'X2',  icon: '✕' },
  tiny:   { color: 0xff2bd6, hex: '#ff2bd6', label: 'TNY', icon: '◌' },
};
