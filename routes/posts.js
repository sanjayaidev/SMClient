const express = require('express');
const { publishDuePostById } = require('../scheduler');

function router(pool) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM posts ORDER BY scheduled_date DESC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    try {
      const { title, caption, hook, platforms, scheduled_date, media_url } = req.body;
      const result = await pool.query(
        `INSERT INTO posts (title, caption, hook, platforms, scheduled_date, media_url, status)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $5 IS NULL THEN 'draft' ELSE 'scheduled' END)
         RETURNING *`,
        [title, caption, hook, JSON.stringify(platforms), scheduled_date, media_url || null]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.put('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { title, caption, hook, platforms, scheduled_date, status, media_url } = req.body;
      const result = await pool.query(
        `UPDATE posts SET title=$1, caption=$2, hook=$3, platforms=$4, scheduled_date=$5,
           status=$6, media_url=$7, updated_at=CURRENT_TIMESTAMP WHERE id=$8 RETURNING *`,
        [title, caption, hook, JSON.stringify(platforms), scheduled_date, status, media_url || null, id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM posts WHERE id=$1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual trigger — publish immediately instead of waiting for the cron tick
  r.post('/:id/publish-now', async (req, res) => {
    try {
      await publishDuePostById(pool, req.params.id);
      const result = await pool.query('SELECT * FROM posts WHERE id=$1', [req.params.id]);
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
