// main.js — 入口
import { Game } from './game/Game.js';
import { UI } from './game/UI.js';
import { Backend } from './game/Backend.js';

async function boot() {
  const ui = new UI();
  const backend = new Backend();

  // 拿当前用户名, 排行榜高亮用
  const me = await backend.whoami();
  if (me) {
    window.__EXT_USER__ = me.username;
  }

  let game;
  try {
    game = new Game({ stage: ui.el.stage, ui, backend });
  } catch (e) {
    console.error('game init failed', e);
    ui.el.loader.querySelector('.loader-text').textContent =
      '初始化失败: ' + (e && e.message ? e.message : e);
    return;
  }

  ui.hideLoader();
  game.start();
}

boot().catch((e) => {
  console.error('boot failed', e);
  const loader = document.getElementById('loader');
  if (loader) {
    loader.querySelector('.loader-text').textContent =
      '启动失败: ' + (e && e.message ? e.message : e);
  }
});
