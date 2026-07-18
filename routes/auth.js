const express = require('express');
const { login, register } = require('../lib/auth');

function router(pool) {
  const r = express.Router();

  r.post('/register', async (req, res) => {
    try {
      const { email, password, name } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password required' });
      }
      const result = await register(pool, email, password, name);
      if (result.error) {
        return res.status(400).json({ error: result.error });
      }
      // Set session for persistence
      req.session.userId = result.user.id;
      req.session.email = result.user.email;
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password required' });
      }
      const result = await login(pool, email, password);
      if (result.error) {
        return res.status(401).json({ error: result.error });
      }
      // Set session for persistence
      req.session.userId = result.user.id;
      req.session.email = result.user.email;
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/me', async (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const result = await pool.query('SELECT id, email, name FROM users WHERE id = $1 AND is_active = true', [req.session.userId]);
    if (result.rows.length === 0) {
      req.session.destroy();
      return res.status(401).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  });
  
  r.post('/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: 'Logout failed' });
      }
      res.json({ success: true });
    });
  });

  return r;
}

module.exports = router;
