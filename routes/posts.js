const express = require('express');
const { publishDuePostById } = require('../scheduler');

function router(pool) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const result = await pool.query('SELECT * FROM posts WHERE user_id = $1 ORDER BY scheduled_date DESC', [userId]);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { title, caption, hook, platforms, scheduled_date, media_url, google_drive_file_id } = req.body;
      const result = await pool.query(
        `INSERT INTO posts (user_id, title, caption, hook, platforms, scheduled_date, media_url, google_drive_file_id, status)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8, CASE WHEN $6 IS NULL THEN 'draft' ELSE 'scheduled' END)
         RETURNING *`,
        [userId, title, caption, hook, JSON.stringify(platforms || []), scheduled_date || null, media_url || null, google_drive_file_id || null]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.put('/:id', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { id } = req.params;
      const { title, caption, hook, platforms, scheduled_date, status, media_url, google_drive_file_id } = req.body;
      const result = await pool.query(
        `UPDATE posts SET title=$1, caption=$2, hook=$3, platforms=$4, scheduled_date=$5::timestamptz,
           status=$6, media_url=$7, google_drive_file_id=$8, updated_at=CURRENT_TIMESTAMP WHERE id=$9 AND user_id=$10 RETURNING *`,
        [title, caption, hook, JSON.stringify(platforms || []), scheduled_date || null, status || 'draft', media_url || null, google_drive_file_id || null, id, userId]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      await pool.query('DELETE FROM posts WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual trigger — publish immediately instead of waiting for the cron tick
  r.post('/:id/publish-now', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      // Verify ownership
      const check = await pool.query('SELECT 1 FROM posts WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Post not found' });
      }
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
