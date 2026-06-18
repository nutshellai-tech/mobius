const express = require('express');
const { auth } = require('../middleware/auth');
const { Messages } = require('../repositories/messages');

const router = express.Router();

router.patch('/:id/bookmark', auth, (req, res) => {
  const msg = Messages.findWithUser(req.params.id);
  if (!msg || msg.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const newVal = msg.bookmarked ? 0 : 1;
  Messages.setBookmark(req.params.id, newVal);
  res.json({ id: msg.id, bookmarked: newVal });
});

module.exports = router;
