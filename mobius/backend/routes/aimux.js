const express = require('express');
const { auth } = require('../middleware/auth');
const aimuxRemote = require('../services/aimux-remote');

const router = express.Router();

router.get('/remotes', auth, async (req, res) => {
  try {
    const remotes = await aimuxRemote.listRemotes();
    res.json({ remotes });
  } catch (e) {
    res.status(500).json({ error: e.message || '读取 aimux remote 清单失败' });
  }
});

router.post('/remotes/test', auth, async (req, res) => {
  try {
    const result = await aimuxRemote.testRemote(req.body?.name, req.body?.timeout);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || '测试 aimux remote 失败' });
  }
});

router.post('/remotes/hardware', auth, async (req, res) => {
  try {
    const result = await aimuxRemote.hardwareRemote(req.body?.name, req.body?.timeout);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || '探测 aimux remote 硬件失败' });
  }
});

router.post('/remotes/browse', auth, async (req, res) => {
  try {
    const result = await aimuxRemote.browseRemotePath(req.body?.name, req.body?.path, req.body?.timeout);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || '浏览 aimux remote 路径失败' });
  }
});

router.post('/remotes', auth, async (req, res) => {
  try {
    const result = await aimuxRemote.addRemote(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(400).json({
      error: e.message || '添加 aimux remote 失败',
      detail: e.result || null,
    });
  }
});

module.exports = router;
