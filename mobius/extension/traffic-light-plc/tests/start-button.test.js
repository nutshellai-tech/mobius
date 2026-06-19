const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const url = process.env.TRAFFIC_LIGHT_URL
  || 'http://127.0.0.1:45616/extension/traffic-light-plc/';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PW_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--single-process', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.selectOption('#speedSel', '0.25');
    await page.click('#btnStart');
    await page.waitForTimeout(300);

    assert.deepEqual(errors, [], `页面脚本不应报错: ${errors.join('; ')}`);
    assert.equal(
      await page.locator('#runPill').textContent(),
      '运行中',
      '一次启动点击必须被 PLC 扫描捕获，即使仿真倍率为 0.25×',
    );
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
