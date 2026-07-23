const express = require('express');

function router(pool) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const result = await pool.query('SELECT * FROM automations WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { name, type, keywords, platforms, ai_prompt, variations, reply_location, response_type, response_data, is_active, target_post_id, target_published_ids } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      // Support both single trigger type and 'both' for comment+dm
      const validTypes = ['comment', 'dm', 'both'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `type must be "comment", "dm", or "both", got "${type}"` });
      }
      let targetPostId = null;
      let processedTargetPublishedIds = null;
      
      // Handle new per-platform targeting (target_published_ids takes precedence)
      if (target_published_ids && typeof target_published_ids === 'object' && Object.keys(target_published_ids).length > 0) {
        // Validate each post ID in the target_published_ids object
        processedTargetPublishedIds = {};
        for (const [platform, postId] of Object.entries(target_published_ids)) {
          if (postId) {
            const postCheck = await pool.query('SELECT id FROM posts WHERE id=$1 AND user_id=$2', [postId, userId]);
            if (!postCheck.rows.length) {
              return res.status(400).json({ error: `target_published_ids.${platform} does not refer to one of your posts` });
            }
            processedTargetPublishedIds[platform] = String(postId);
          }
        }
        if (Object.keys(processedTargetPublishedIds).length === 0) {
          processedTargetPublishedIds = null;
        }
      } else if (target_post_id !== undefined && target_post_id !== null && target_post_id !== '') {
        // Legacy single-post targeting
        const postCheck = await pool.query('SELECT id FROM posts WHERE id=$1 AND user_id=$2', [target_post_id, userId]);
        if (!postCheck.rows.length) {
          return res.status(400).json({ error: 'target_post_id does not refer to one of your posts' });
        }
        targetPostId = postCheck.rows[0].id;
      }
      
      // Process response_data to extract variations and ai_prompt for backward compatibility
      let processedVariations = variations || [];
      let processedAiPrompt = ai_prompt || null;
      
      if (response_data) {
        // Extract variations from response_data if present
        if (response_data.variations && Array.isArray(response_data.variations)) {
          processedVariations = response_data.variations;
        }
        // Also check for comment-specific variations
        if (response_data.comment && response_data.comment.variations) {
          processedVariations = response_data.comment.variations;
        }
        // Extract ai_prompt from response_data if present
        if (response_data.system_prompt) {
          processedAiPrompt = response_data.system_prompt;
        }
        if (response_data.comment && response_data.comment.system_prompt) {
          processedAiPrompt = response_data.comment.system_prompt;
        }
      }
      
      const result = await pool.query(
        `INSERT INTO automations (user_id, name, type, keywords, platforms, ai_prompt, variations, reply_location, response_type, response_data, is_active, target_post_id, target_published_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          userId,
          name,
          type,
          JSON.stringify(keywords || []),
          JSON.stringify(platforms || ['instagram', 'facebook', 'threads']),
          processedAiPrompt,
          JSON.stringify(processedVariations),
          reply_location || 'comment',
          response_type || 'text',
          JSON.stringify(response_data || {}),
          is_active !== undefined ? is_active : false,
          targetPostId,
          processedTargetPublishedIds ? JSON.stringify(processedTargetPublishedIds) : null
        ]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.patch('/:id/toggle', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const result = await pool.query(
        'UPDATE automations SET is_active = NOT is_active WHERE id=$1 AND user_id=$2 RETURNING *',
        [req.params.id, userId]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.put('/:id', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { name, type, keywords, platforms, ai_prompt, variations, reply_location, response_type, response_data, is_active, target_post_id, target_published_ids } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      // Support both single trigger type and 'both' for comment+dm
      const validTypes = ['comment', 'dm', 'both'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `type must be "comment", "dm", or "both", got "${type}"` });
      }
      
      // Verify ownership of the automation
      const existing = await pool.query('SELECT id FROM automations WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
      if (!existing.rows.length) {
        return res.status(404).json({ error: 'Automation not found' });
      }
      
      let targetPostId = null;
      let processedTargetPublishedIds = null;
      
      // Handle new per-platform targeting (target_published_ids takes precedence)
      if (target_published_ids && typeof target_published_ids === 'object' && Object.keys(target_published_ids).length > 0) {
        // Validate each post ID in the target_published_ids object
        processedTargetPublishedIds = {};
        for (const [platform, postId] of Object.entries(target_published_ids)) {
          if (postId) {
            const postCheck = await pool.query('SELECT id FROM posts WHERE id=$1 AND user_id=$2', [postId, userId]);
            if (!postCheck.rows.length) {
              return res.status(400).json({ error: `target_published_ids.${platform} does not refer to one of your posts` });
            }
            processedTargetPublishedIds[platform] = String(postId);
          }
        }
        if (Object.keys(processedTargetPublishedIds).length === 0) {
          processedTargetPublishedIds = null;
        }
      } else if (target_post_id !== undefined && target_post_id !== null && target_post_id !== '') {
        // Legacy single-post targeting
        const postCheck = await pool.query('SELECT id FROM posts WHERE id=$1 AND user_id=$2', [target_post_id, userId]);
        if (!postCheck.rows.length) {
          return res.status(400).json({ error: 'target_post_id does not refer to one of your posts' });
        }
        targetPostId = postCheck.rows[0].id;
      }
      
      // Process response_data to extract variations and ai_prompt for backward compatibility
      let processedVariations = variations || [];
      let processedAiPrompt = ai_prompt || null;
      
      if (response_data) {
        // Extract variations from response_data if present
        if (response_data.variations && Array.isArray(response_data.variations)) {
          processedVariations = response_data.variations;
        }
        // Also check for comment-specific variations
        if (response_data.comment && response_data.comment.variations) {
          processedVariations = response_data.comment.variations;
        }
        // Extract ai_prompt from response_data if present
        if (response_data.system_prompt) {
          processedAiPrompt = response_data.system_prompt;
        }
        if (response_data.comment && response_data.comment.system_prompt) {
          processedAiPrompt = response_data.comment.system_prompt;
        }
      }
      
      const result = await pool.query(
        `UPDATE automations 
         SET name=$1, type=$2, keywords=$3, platforms=$4, ai_prompt=$5, variations=$6, 
             reply_location=$7, response_type=$8, response_data=$9, is_active=$10, target_post_id=$11, target_published_ids=$12
         WHERE id=$13 AND user_id=$14 RETURNING *`,
        [
          name,
          type,
          JSON.stringify(keywords || []),
          JSON.stringify(platforms || ['instagram', 'facebook', 'threads']),
          processedAiPrompt,
          JSON.stringify(processedVariations),
          reply_location || 'comment',
          response_type || 'text',
          JSON.stringify(response_data || {}),
          is_active !== undefined ? is_active : false,
          targetPostId,
          processedTargetPublishedIds ? JSON.stringify(processedTargetPublishedIds) : null,
          req.params.id,
          userId
        ]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      await pool.query('DELETE FROM automations WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
