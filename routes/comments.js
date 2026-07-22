const express = require('express');

function router(pool) {
  const r = express.Router();

  // GET /api/comments - Fetch recent comments from automation_logs
  r.get('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const limit = parseInt(req.query.limit) || 50;
      
      // Get connections for this user to filter by their accounts
      const connectionsRes = await pool.query(
        'SELECT account_id, page_id, platform FROM connections WHERE user_id = $1 AND is_connected = true',
        [userId]
      );
      const accountIds = connectionsRes.rows.map(c => c.account_id || c.page_id);
      
      if (accountIds.length === 0) {
        return res.json([]);
      }
      
      const result = await pool.query(
        `SELECT id, platform, trigger_type, trigger_text, media_id, sender_id, account_id, 
                automation_id, automation_name, response_type, response_content, reply_location, 
                success, error_message, created_at
         FROM automation_logs
         WHERE account_id = ANY($1) AND trigger_type = 'comment'
         ORDER BY created_at DESC
         LIMIT $2`,
        [accountIds, limit]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/comments/:id/reply - Reply to a comment
  r.post('/:id/reply', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const commentId = req.params.id;
      const { message } = req.body;
      
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: 'message is required' });
      }

      // Get the original comment log to find platform and account
      const logRes = await pool.query(
        'SELECT platform, account_id FROM automation_logs WHERE id = $1',
        [commentId]
      );
      
      if (logRes.rows.length === 0) {
        return res.status(404).json({ error: 'Comment not found' });
      }
      
      const { platform, account_id } = logRes.rows[0];
      
      // Get the connection token
      const connRes = await pool.query(
        'SELECT access_token FROM connections WHERE user_id = $1 AND (account_id = $2 OR page_id = $2) AND is_connected = true',
        [userId, account_id]
      );
      
      if (connRes.rows.length === 0) {
        return res.status(400).json({ error: 'No connected account found for this platform' });
      }
      
      const { decrypt } = require('../lib/crypto');
      const token = decrypt(connRes.rows[0].access_token);
      
      // Reply based on platform
      let replyId;
      if (platform === 'facebook') {
        const facebook = require('../platforms/facebook');
        replyId = await facebook.replyToComment(token, commentId, message);
      } else if (platform === 'instagram') {
        const instagram = require('../platforms/instagram');
        replyId = await instagram.replyToComment(token, commentId, message);
      } else {
        return res.status(400).json({ error: `Unsupported platform: ${platform}` });
      }
      
      // Log the manual reply
      await pool.query(
        `INSERT INTO automation_logs 
         (platform, trigger_type, trigger_text, media_id, sender_id, account_id, 
          automation_id, automation_name, response_type, response_content, reply_location, success)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          platform,
          'manual_reply',
          null,
          null,
          null,
          account_id,
          null,
          'Manual Reply',
          'text',
          message,
          'comment',
          true
        ]
      );
      
      res.json({ success: true, reply_id: replyId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
