const express = require('express');
const crypto = require('crypto');
const { decrypt } = require('../lib/crypto');
const { findMatch, pickResponse } = require('../automations/matcher');
const { generateReply } = require('../lib/ai');
const instagram = require('../platforms/instagram');
const facebook = require('../platforms/facebook');
const threads = require('../platforms/threads');

// Platform-specific webhook configuration
const FB_VERIFY_TOKEN = process.env.FB_WEBHOOK_VERIFY_TOKEN;
const FB_APP_SECRET = process.env.FB_SECRET;
const IG_VERIFY_TOKEN = process.env.IG_WEBHOOK_VERIFY_TOKEN;
const IG_APP_SECRET = process.env.IG_SECRET;
const TH_VERIFY_TOKEN = process.env.TH_WEBHOOK_VERIFY_TOKEN;
const TH_APP_SECRET = process.env.TH_SECRET;

// Helper to log automation events to database
async function logAutomationEvent(pool, data) {
  try {
    await pool.query(
      `INSERT INTO automation_logs 
       (platform, trigger_type, trigger_text, media_id, sender_id, account_id, 
        automation_id, automation_name, response_type, response_content, reply_location, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        data.platform,
        data.triggerType,
        data.triggerText || null,
        data.mediaId || null,
        data.senderId || null,
        data.accountId || null,
        data.automationId || null,
        data.automationName || null,
        data.responseType || null,
        data.responseContent || null,
        data.replyLocation || null,
        data.success,
        data.errorMessage || null
      ]
    );
  } catch (err) {
    console.error('Failed to log automation event:', err.message);
  }
}

// Helper to get comment reply variations - picks 3 random variations for comments
function getCommentVariations(variations) {
  if (!variations || variations.length === 0) return [];
  // Shuffle and pick up to 3 variations
  const shuffled = [...variations].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(3, shuffled.length));
}

// Helper to pick response based on trigger type and automation config
async function getResponseForTrigger(automation, triggerType, platform, triggerText) {
  const variations = automation.variations || [];
  
  // For comments: use variations as alternative options (pick 3 random)
  if (triggerType === 'comment') {
    if (automation.ai_prompt) {
      const aiText = await generateReply(automation.ai_prompt);
      if (aiText) return { text: aiText, type: 'ai' };
    }
    if (variations.length) {
      // Pick random variation from the 3 pre-selected options
      const commentVariations = getCommentVariations(variations);
      if (commentVariations.length > 0) {
        const selectedVariation = commentVariations[Math.floor(Math.random() * commentVariations.length)];
        return { text: selectedVariation, type: 'variation' };
      }
      // Fallback to any variation if less than 3
      const selectedVariation = variations[Math.floor(Math.random() * variations.length)];
      return { text: selectedVariation, type: 'variation' };
    }
  }
  
  // For DMs: handle based on support type per platform
  if (triggerType === 'dm') {
    // Check if automation has platform-specific DM response configuration
    const responseData = automation.response_data || {};
    const platformConfig = responseData[platform] || responseData.general || {};
    
    if (platformConfig.support_type === 'tiered') {
      // Tiered support: escalate based on keywords or conversation history
      const tier = platformConfig.tiers?.find(t => 
        t.keywords?.some(k => (triggerText || '').toLowerCase().includes(k.toLowerCase()))
      );
      if (tier?.response) {
        return { text: tier.response, type: 'tiered_support' };
      }
    } else if (platformConfig.support_type === 'categorized') {
      // Categorized support: route based on issue type
      const category = platformConfig.categories?.find(c => 
        c.keywords?.some(k => (triggerText || '').toLowerCase().includes(k.toLowerCase()))
      );
      if (category?.response) {
        return { text: category.response, type: 'categorized_support' };
      }
    }
    
    // Fallback to AI or variations
    if (automation.ai_prompt) {
      const aiText = await generateReply(automation.ai_prompt);
      if (aiText) return { text: aiText, type: 'ai' };
    }
    if (variations.length) {
      const selectedVariation = variations[Math.floor(Math.random() * variations.length)];
      return { text: selectedVariation, type: 'variation' };
    }
  }
  
  return null;
}

function router(pool) {
  const r = express.Router();

  // Raw body needed for signature verification — mounted with express.raw
  // in server.js for these two routes specifically, ahead of express.json().

  function verifySignature(req, secret, header) {
    if (!secret) return true; // allow running without a secret in early dev, but warn
    const sig = req.headers[header];
    if (!sig) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  async function alreadyProcessed(eventId) {
    if (!eventId) return false;
    const existing = await pool.query('SELECT 1 FROM processed_webhook_events WHERE event_id=$1', [eventId]);
    if (existing.rows.length) return true;
    await pool.query(
      'INSERT INTO processed_webhook_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [eventId]
    );
    return false;
  }

  async function getConnection(platform, accountId) {
    // Threads' webhook payload doesn't give us a reliable per-account id to
    // match on (see call site below), so accountId is sometimes omitted —
    // passing a bare `undefined` straight to pg throws "could not determine
    // data type of parameter $2", so branch instead of relying on a fallback value.
    if (accountId === undefined || accountId === null) {
      const res = await pool.query(
        'SELECT * FROM connections WHERE platform=$1 AND is_connected=true ORDER BY updated_at DESC LIMIT 1',
        [platform]
      );
      return res.rows[0] || null;
    }
    const res = await pool.query(
      'SELECT * FROM connections WHERE platform=$1 AND (account_id=$2 OR page_id=$2) AND is_connected=true ORDER BY updated_at DESC LIMIT 1',
      [platform, accountId]
    );
    return res.rows[0] || null;
  }

  async function getActiveAutomations() {
    const res = await pool.query(
      `SELECT automations.*, posts.published_ids AS target_published_ids
       FROM automations
       LEFT JOIN posts ON posts.id = automations.target_post_id
       WHERE automations.is_active = true`
    );
    return res.rows;
  }

  // ===== Facebook Webhook =====
  r.get('/webhooks/facebook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  r.post('/webhooks/facebook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!verifySignature(req, FB_APP_SECRET, 'x-hub-signature-256')) {
      return res.sendStatus(403);
    }
    res.sendStatus(200); // ack immediately; Facebook expects a fast 200

    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return; }

    const platform = 'facebook';
    for (const entry of payload.entry || []) {
      // Comments arrive as "changes" with field "comments"
      for (const change of entry.changes || []) {
        if (change.field !== 'comments') continue;
        const value = change.value;
        const commentId = value.id;
        const text = value.text;
        const mediaId = value.media?.id || entry.id;
        if (await alreadyProcessed(`comment:${commentId}`)) continue;
        await handleTrigger({ platform, triggerType: 'comment', text, replyTargetId: commentId, mediaId, accountId: entry.id });
      }
      // DMs arrive under "messaging"
      for (const messaging of entry.messaging || []) {
        if (!messaging.message || messaging.message.is_echo) continue;
        const senderId = messaging.sender?.id;
        const text = messaging.message.text;
        const msgId = messaging.message.mid;
        if (await alreadyProcessed(`dm:${msgId}`)) continue;
        await handleTrigger({ platform, triggerType: 'dm', text, senderId, accountId: entry.id });
      }
    }

    async function handleTrigger({ platform, triggerType, text, replyTargetId, senderId, accountId, mediaId }) {
      console.log(`🔔 Webhook trigger: ${platform}/${triggerType} - Text: "${text?.substring(0, 50)}${text?.length > 50 ? '...' : ''}"`);
      
      const automations = await getActiveAutomations();
      const match = findMatch(automations, { platform, triggerType, text, mediaId });
      
      if (!match) {
        console.log(`⚠️  No matching automation found for ${platform}/${triggerType}`);
        // Log trigger even if no automation matched
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: null,
          automationName: null,
          responseType: null,
          responseContent: null,
          replyLocation: null,
          success: false,
          errorMessage: 'No matching automation found'
        });
        return;
      }
      
      console.log(`✅ Automation matched: "${match.name}" (ID: ${match.id})`);
      
      const responseResult = await getResponseForTrigger(match, triggerType, platform, text);
      const reply = responseResult?.text;
      
      if (!reply) {
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: match.id,
          automationName: match.name,
          responseType: null,
          responseContent: null,
          replyLocation: null,
          success: false,
          errorMessage: 'No response generated'
        });
        return;
      }

      const conn = await getConnection(platform, accountId);
      if (!conn) { 
        console.error(`No connected ${platform} account to reply with`); 
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: match.id,
          automationName: match.name,
          responseType: responseResult.type,
          responseContent: reply,
          replyLocation: triggerType === 'comment' ? 'comment' : 'dm',
          success: false,
          errorMessage: `No connected ${platform} account`
        });
        return; 
      }
      const token = decrypt(conn.access_token);

      try {
        if (triggerType === 'comment') {
          await facebook.replyToComment(token, replyTargetId, reply);
          await logAutomationEvent(pool, {
            platform,
            triggerType,
            triggerText: text,
            mediaId,
            senderId: null,
            accountId,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult.type,
            responseContent: reply,
            replyLocation: 'comment',
            success: true,
            errorMessage: null
          });
        } else if (triggerType === 'dm') {
          await facebook.sendDM(token, conn.account_id || conn.page_id, senderId, reply);
          await logAutomationEvent(pool, {
            platform,
            triggerType,
            triggerText: text,
            mediaId: null,
            senderId,
            accountId,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult.type,
            responseContent: reply,
            replyLocation: 'dm',
            success: true,
            errorMessage: null
          });
        }
      } catch (err) {
        const errorMsg = err.response?.data || err.message;
        console.error(`Auto-reply failed (${platform}/${triggerType}):`, errorMsg);
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: match.id,
          automationName: match.name,
          responseType: responseResult?.type,
          responseContent: reply,
          replyLocation: triggerType === 'comment' ? 'comment' : 'dm',
          success: false,
          errorMessage: errorMsg
        });
      }
    }
  });

  // ===== Instagram Webhook =====
  r.get('/webhooks/instagram', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === IG_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  r.post('/webhooks/instagram', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!verifySignature(req, IG_APP_SECRET, 'x-hub-signature-256')) {
      return res.sendStatus(403);
    }
    res.sendStatus(200);

    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return; }

    const platform = 'instagram';
    for (const entry of payload.entry || []) {
      // Comments arrive as "changes" with field "comments"
      for (const change of entry.changes || []) {
        if (change.field !== 'comments') continue;
        const value = change.value;
        const commentId = value.id;
        const text = value.text;
        const mediaId = value.media?.id || entry.id;
        if (await alreadyProcessed(`comment:${commentId}`)) continue;
        await handleTrigger({ platform, triggerType: 'comment', text, replyTargetId: commentId, mediaId, accountId: entry.id });
      }
      // DMs arrive under "messaging"
      for (const messaging of entry.messaging || []) {
        if (!messaging.message || messaging.message.is_echo) continue;
        const senderId = messaging.sender?.id;
        const text = messaging.message.text;
        const msgId = messaging.message.mid;
        if (await alreadyProcessed(`dm:${msgId}`)) continue;
        await handleTrigger({ platform, triggerType: 'dm', text, senderId, accountId: entry.id });
      }
    }

    async function handleTrigger({ platform, triggerType, text, replyTargetId, senderId, accountId, mediaId }) {
      console.log(`🔔 Webhook trigger: ${platform}/${triggerType} - Text: "${text?.substring(0, 50)}${text?.length > 50 ? '...' : ''}"`);
      
      const automations = await getActiveAutomations();
      const match = findMatch(automations, { platform, triggerType, text, mediaId });
      
      if (!match) {
        console.log(`⚠️  No matching automation found for ${platform}/${triggerType}`);
        // Log trigger even if no automation matched
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: null,
          automationName: null,
          responseType: null,
          responseContent: null,
          replyLocation: null,
          success: false,
          errorMessage: 'No matching automation found'
        });
        return;
      }
      
      console.log(`✅ Automation matched: "${match.name}" (ID: ${match.id})`);
      
      const responseResult = await getResponseForTrigger(match, triggerType, platform, text);
      const reply = responseResult?.text;
      
      if (!reply) {
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: match.id,
          automationName: match.name,
          responseType: null,
          responseContent: null,
          replyLocation: null,
          success: false,
          errorMessage: 'No response generated'
        });
        return;
      }

      const conn = await getConnection(platform, accountId);
      if (!conn) { 
        console.error(`No connected ${platform} account to reply with`); 
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: match.id,
          automationName: match.name,
          responseType: responseResult.type,
          responseContent: reply,
          replyLocation: triggerType === 'comment' ? 'comment' : 'dm',
          success: false,
          errorMessage: `No connected ${platform} account`
        });
        return; 
      }
      const token = decrypt(conn.access_token);

      try {
        if (triggerType === 'comment') {
          await instagram.replyToComment(token, replyTargetId, reply);
          await logAutomationEvent(pool, {
            platform,
            triggerType,
            triggerText: text,
            mediaId,
            senderId: null,
            accountId,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult.type,
            responseContent: reply,
            replyLocation: 'comment',
            success: true,
            errorMessage: null
          });
        } else if (triggerType === 'dm') {
          await instagram.sendDM(token, conn.account_id || conn.page_id, senderId, reply);
          await logAutomationEvent(pool, {
            platform,
            triggerType,
            triggerText: text,
            mediaId: null,
            senderId,
            accountId,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult.type,
            responseContent: reply,
            replyLocation: 'dm',
            success: true,
            errorMessage: null
          });
        }
      } catch (err) {
        const errorMsg = err.response?.data || err.message;
        console.error(`Auto-reply failed (${platform}/${triggerType}):`, errorMsg);
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: match.id,
          automationName: match.name,
          responseType: responseResult?.type,
          responseContent: reply,
          replyLocation: triggerType === 'comment' ? 'comment' : 'dm',
          success: false,
          errorMessage: errorMsg
        });
      }
    }
  });

  // ===== Threads Webhook =====
  // NOTE: Threads' webhook payload shape may need adjusting to match what
  // Meta actually sends for your app — verify against real deliveries in
  // the App Dashboard's webhook test tool before relying on this in prod.
  r.get('/webhooks/threads', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === TH_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  r.post('/webhooks/threads', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!verifySignature(req, TH_APP_SECRET, 'x-hub-signature-256')) {
      return res.sendStatus(403);
    }
    res.sendStatus(200);

    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return; }

    const platform = 'threads';
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'replies') continue; // adjust once real payloads are confirmed
        const value = change.value;
        const replyId = value.id;
        const text = value.text;
        const mediaId = value.media?.id || entry.id;
        if (await alreadyProcessed(`threads_reply:${replyId}`)) continue;

        console.log(`🔔 Webhook trigger: ${platform}/comment - Text: "${text?.substring(0, 50)}${text?.length > 50 ? '...' : ''}"`);

        const automations = await getActiveAutomations();
        const match = findMatch(automations, { platform, triggerType: 'comment', text, mediaId });
        
        if (!match) {
          console.log(`⚠️  No matching automation found for ${platform}/comment`);
          await logAutomationEvent(pool, {
            platform,
            triggerType: 'comment',
            triggerText: text,
            mediaId,
            senderId: null,
            accountId: entry.id,
            automationId: null,
            automationName: null,
            responseType: null,
            responseContent: null,
            replyLocation: null,
            success: false,
            errorMessage: 'No matching automation found'
          });
          continue;
        }
        
        console.log(`✅ Automation matched: "${match.name}" (ID: ${match.id})`);
        
        const responseResult = await getResponseForTrigger(match, 'comment', platform, text);
        const reply = responseResult?.text;
        
        if (!reply) {
          await logAutomationEvent(pool, {
            platform,
            triggerType: 'comment',
            triggerText: text,
            mediaId,
            senderId: null,
            accountId: entry.id,
            automationId: match.id,
            automationName: match.name,
            responseType: null,
            responseContent: null,
            replyLocation: null,
            success: false,
            errorMessage: 'No response generated'
          });
          continue;
        }

        const conn = await getConnection('threads');
        if (!conn) { 
          console.error('No connected Threads account to reply with'); 
          await logAutomationEvent(pool, {
            platform,
            triggerType: 'comment',
            triggerText: text,
            mediaId,
            senderId: null,
            accountId: entry.id,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult.type,
            responseContent: reply,
            replyLocation: 'comment',
            success: false,
            errorMessage: 'No connected Threads account'
          });
          continue; 
        }
        const token = decrypt(conn.access_token);
        try {
          await threads.replyToThread(token, conn.account_id, replyId, reply);
          await logAutomationEvent(pool, {
            platform,
            triggerType: 'comment',
            triggerText: text,
            mediaId,
            senderId: null,
            accountId: entry.id,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult.type,
            responseContent: reply,
            replyLocation: 'comment',
            success: true,
            errorMessage: null
          });
        } catch (err) {
          const errorMsg = err.response?.data || err.message;
          console.error('Threads auto-reply failed:', errorMsg);
          await logAutomationEvent(pool, {
            platform,
            triggerType: 'comment',
            triggerText: text,
            mediaId,
            senderId: null,
            accountId: entry.id,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult?.type,
            responseContent: reply,
            replyLocation: 'comment',
            success: false,
            errorMessage: errorMsg
          });
        }
      }
    }
  });

  // ===== External API Access with API Key Authentication =====
  // Allows other platforms/apps to access posts and automations with valid API key
  r.get('/api/public/posts', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    try {
      const result = await pool.query('SELECT id, title, caption, hook, platforms, scheduled_date, status, created_at FROM posts ORDER BY scheduled_date DESC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/api/public/automations', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    try {
      const result = await pool.query('SELECT id, name, type, keywords, ai_prompt, variations, is_active, created_at FROM automations WHERE is_active=true');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
