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
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
