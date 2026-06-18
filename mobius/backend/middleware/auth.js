const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { Users } = require('../repositories/users');

function loadUser(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  return Users.findAuthById(payload.id);
}

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const dbUser = loadUser(token);
    if (!dbUser) return res.status(401).json({ error: 'User not found' });
    req.user = dbUser;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// Download 路由也接受 ?token= query
function downloadAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const dbUser = loadUser(token);
    if (!dbUser) return res.status(401).json({ error: 'User not found' });
    req.user = dbUser;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function authOrQuery(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const dbUser = loadUser(token);
    if (!dbUser) return res.status(401).json({ error: 'User not found' });
    req.user = dbUser;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { auth, adminAuth, downloadAuth, authOrQuery };
