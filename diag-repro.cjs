const { chromium } = require('/home/tianyi/.npm/_npx/11e6a5b3df3e7c31/node_modules/playwright');
const BASE = 'http://127.0.0.1:45616';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));

  const loginRes = await page.request.post(BASE + '/api/auth/login', { data: { username: 'admin', password: 'admin' } });
  if (!loginRes.ok()) { console.error('login failed', loginRes.status()); process.exit(1); }
  const { token } = await loginRes.json();
  console.log('[repro] login OK token len', token.length);

  await ctx.addInitScript((t) => { try { localStorage.setItem('cc-token', t); } catch (e) {} }, token);

  let targetPath = '/u/fuqingxu';
  await page.goto(BASE + targetPath, { waitUntil: 'domcontentloaded' });
  try { await page.waitForSelector('[data-tour="user-project-card"]', { timeout: 8000 }); }
  catch (e) {
    console.log('[repro] no cards on', targetPath, '-> try /u/admin');
    targetPath = '/u/admin';
    await page.goto(BASE + targetPath, { waitUntil: 'domcontentloaded' });
    try { await page.waitForSelector('[data-tour="user-project-card"]', { timeout: 8000 }); }
    catch (e2) { console.log('[repro] still no cards; abort'); await browser.close(); return; }
  }
  console.log('[repro] page:', targetPath);

  await page.evaluate(() => { window.__blockNav = true; });

  // 自注入诊断: mousedown 记节点, mouseup 比对 + 录制期间 DOM 移除/添加详情(含最近 data-tour 祖先)
  await page.evaluate(() => {
    window.__diag = [];
    let mdNode = null, recording = false, domOps = [];
    const desc = (n) => {
      const el = n;
      if (!el || !el.tagName) return { kind: 'text', txt: ((n && n.textContent) || '').slice(0, 14) };
      const a = el.closest('[data-tour]');
      return { tag: el.tagName, tour: el.getAttribute('data-tour') || '', title: (el.getAttribute('title') || '').slice(0, 14), anc: a ? a.getAttribute('data-tour') : '', kids: el.childElementCount };
    };
    window.__mo = new MutationObserver((muts) => {
      if (!recording) return;
      for (const m of muts) {
        if (m.type !== 'childList') continue;
        m.removedNodes.forEach(n => domOps.push(Object.assign({ op: 'rm' }, desc(n))));
        m.addedNodes.forEach(n => domOps.push(Object.assign({ op: 'add' }, desc(n))));
      }
      if (domOps.length > 150) domOps.splice(0, domOps.length - 150);
    });
    window.__mo.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('mousedown', (e) => { mdNode = e.target; recording = true; domOps = []; }, { capture: true, passive: true });
    document.addEventListener('mouseup', (e) => { recording = false; window.__diag.push({ mdSameNode: e.target === mdNode, mdStillInDom: mdNode ? document.contains(mdNode) : null, domOps: domOps.slice() }); }, { capture: true, passive: true });
  });

  await page.waitForTimeout(2500); // 等异步 issues 加载触发重渲染

  const cards = await page.$$('[data-tour="user-project-card"]');
  console.log('[repro] cards:', cards.length);
  let target = null, targetTitle = '';
  for (const c of cards) {
    const btn = await c.$('button[title]');
    if (btn) { const t = (await btn.getAttribute('title')) || ''; if (t.toLowerCase().includes('self-develop')) { target = btn; targetTitle = t; break; } }
  }
  if (!target) { for (const c of cards) { const btn = await c.$('button[title]'); if (btn) { target = btn; targetTitle = (await btn.getAttribute('title')) || ''; break; } } }
  if (!target) { console.log('[repro] no target button; abort'); await browser.close(); return; }
  console.log('[repro] target button:', targetTitle);

  const box = await target.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.evaluate(() => { window.__diag = []; });

  for (let i = 0; i < 30; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // down 后注入一次重渲染(模拟 assistant 后台 setProjects / 异步 issues 完成), 让它落在 down->up 间
    await page.evaluate(() => {
      const s = window.__useStore;
      if (s && s.getState) {
        const cur = s.getState().projects || [];
        s.getState().setProjects(cur.map(p => ({ ...p })));
      }
    });
    await page.waitForTimeout(30 + (i % 4) * 15);
    await page.mouse.up();
    await page.waitForTimeout(35);
  }

  await page.waitForTimeout(600);
  const diag = await page.evaluate(() => window.__diag || []);
  console.log('[repro] clicks recorded:', diag.length);
  const swapped = diag.filter(d => d.mdSameNode === false);
  console.log('[repro] SWAPPED (mdSameNode=false):', swapped.length);
  let printed = 0;
  for (const d of swapped) {
    if (printed >= 4) break;
    console.log('=== swapped click === mdStillInDom:', d.mdStillInDom, 'domOps:', d.domOps.length);
    for (const op of d.domOps.slice(0, 24)) console.log('    ', op.op, op.tag, 'tour=' + op.tour, 'anc=' + op.anc, 'title=' + op.title, 'kids=' + op.kids);
    printed++;
  }
  if (!swapped.length) {
    const avg = diag.length ? (diag.reduce((s, d) => s + d.domOps.length, 0) / diag.length).toFixed(1) : 0;
    console.log('[repro] NO swap reproduced. normal click avg domOps:', avg);
    let maxD = null;
    for (const d of diag) if (!maxD || d.domOps.length > maxD.domOps.length) maxD = d;
    if (maxD && maxD.domOps.length > 0) {
      console.log('=== busiest click domOps:', maxD.domOps.length, '===');
      for (const op of maxD.domOps.slice(0, 20)) console.log('    ', op.op, op.tag, 'tour=' + op.tour, 'anc=' + op.anc, 'title=' + op.title);
    }
  }

  await browser.close();
})().catch(e => { console.error('[repro] error', e); process.exit(1); });
