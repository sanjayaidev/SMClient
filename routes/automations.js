const express = require('express');

function router(pool) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      const userId = req.user.sub;
      const result = await pool.query('SELECT * FROM automations WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    try {
      const userId = req.user.sub;
      const { name, type, keywords, ai_prompt, variations, platforms } = req.body;
      if (type !== 'comment' && type !== 'dm') {
        return res.status(400).json({ error: `type must be "comment" or "dm", got "${type}"` });
      }
      const result = await pool.query(
        `INSERT INTO automations (user_id, name, type, keywords, ai_prompt, variations, platforms)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          userId,
          name,
          type,
          JSON.stringify(keywords || []),
          ai_prompt || null,
          JSON.stringify(variations || []),
          JSON.stringify(platforms || ['instagram', 'facebook', 'threads']),
        ]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.patch('/:id/toggle', async (req, res) => {
    try {
      const userId = req.user.sub;
      const result = await pool.query(
        'UPDATE automations SET is_active = NOT is_active WHERE id=$1 AND user_id=$2 RETURNING *',
        [req.params.id, userId]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      const userId = req.user.sub;
      await pool.query('DELETE FROM automations WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
