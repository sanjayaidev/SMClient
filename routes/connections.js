const express = require('express');
const { encrypt } = require('../lib/crypto');

function router(pool) {
  const r = express.Router();

  // Never send access_token back to the client, even to an authed admin —
  // no legitimate UI need, and it shrinks the blast radius of any XSS.
  const SAFE_FIELDS = 'id, platform, account_name, account_id, page_id, is_connected, token_expires_at, created_at, updated_at';

  r.get('/', async (req, res) => {
    try {
      const userId = req.user.sub;
      const result = await pool.query(`SELECT ${SAFE_FIELDS} FROM connections WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    try {
      const userId = req.user.sub;
      const { platform, account_name, account_id, page_id, access_token, token_expires_at } = req.body;
      if (!platform || !account_id || !access_token) {
        return res.status(400).json({ error: 'platform, account_id, and access_token are required' });
      }
      const encryptedToken = encrypt(access_token);
      const result = await pool.query(
        `INSERT INTO connections (user_id, platform, account_name, account_id, page_id, access_token, is_connected, token_expires_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, platform, account_id) DO UPDATE SET
           account_name=EXCLUDED.account_name, page_id=EXCLUDED.page_id,
           access_token=EXCLUDED.access_token, is_connected=true,
           token_expires_at=EXCLUDED.token_expires_at, updated_at=CURRENT_TIMESTAMP
         RETURNING ${SAFE_FIELDS}`,
        [userId, platform, account_name, account_id, page_id || null, encryptedToken, token_expires_at || null]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      const userId = req.user.sub;
      await pool.query('DELETE FROM connections WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
