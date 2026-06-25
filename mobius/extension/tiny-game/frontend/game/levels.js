/**
 * 关卡定义. 每关: 限时 / 障碍生成间隔 / 障碍下落速度 / 障碍尺寸 / 特性开关.
 * 8 关, 难度递增. 最后一关 = BOSS 关 (最高密度).
 */
export const LEVELS = [
  { n: 1, duration: 20, spawnMs: 900, speed: 1.6, size: 22, lasers: false, splitter: false },
  { n: 2, duration: 22, spawnMs: 780, speed: 1.9, size: 22, lasers: false, splitter: false },
  { n: 3, duration: 24, spawnMs: 680, speed: 2.2, size: 20, lasers: true,  splitter: false },
  { n: 4, duration: 26, spawnMs: 600, speed: 2.5, size: 20, lasers: true,  splitter: false },
  { n: 5, duration: 28, spawnMs: 520, speed: 2.9, size: 18, lasers: true,  splitter: true },
  { n: 6, duration: 30, spawnMs: 460, speed: 3.3, size: 18, lasers: true,  splitter: true },
  { n: 7, duration: 32, spawnMs: 400, speed: 3.7, size: 16, lasers: true,  splitter: true },
  { n: 8, duration: 35, spawnMs: 350, speed: 4.2, size: 16, lasers: true,  splitter: true },
];

export const TOTAL_LEVELS = LEVELS.length;

export function getLevel(n) {
  return LEVELS[Math.min(Math.max(n, 1), TOTAL_LEVELS) - 1];
}

/**
 * 关卡计分.
 * - 生存: +10 × 关卡 / 秒
 * - 拾取核心: +50 × 关卡
 * - 通关奖励: +500 × 关卡
 */
export function scorePerSecond(level) { return 10 * level; }
export function scorePerOrb(level) { return 50 * level; }
export function scoreLevelClear(level) { return 500 * level; }
export const VICTORY_BONUS = 5000;
