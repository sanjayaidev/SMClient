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

// In-memory debug log for recent webhook events (last 100 events)
const webhookDebugLog = [];
const MAX_DEBUG_LOG_SIZE = 100;

function addToDebugLog(event) {
  event.timestamp = new Date().toISOString();
  webhookDebugLog.push(event);
  if (webhookDebugLog.length > MAX_DEBUG_LOG_SIZE) {
    webhookDebugLog.shift();
  }
}

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
  // First check response_data for platform-specific and trigger-specific configuration
  const responseData = automation.response_data || {};
  
  // For comments: check for comment-specific config first, then fallback to general
  if (triggerType === 'comment') {
    const commentConfig = responseData.comment || responseData.general || responseData;
    
    // Check AI prompt first
    const aiPrompt = commentConfig.system_prompt || automation.ai_prompt;
    if (aiPrompt) {
      const aiText = await generateReply(aiPrompt);
      if (aiText) return { text: aiText, type: 'ai' };
    }
    
    // Check for comment variations (up to 3)
    const commentVariations = commentConfig.variations || automation.variations || [];
    if (commentVariations.length > 0) {
      // Pick 3 random variations and select one
      const selectedVariations = getCommentVariations(commentVariations);
      if (selectedVariations.length > 0) {
        const selectedVariation = selectedVariations[Math.floor(Math.random() * selectedVariations.length)];
        return { text: selectedVariation, type: 'variation' };
      }
    }
    
    // Fallback to any variations
    const allVariations = automation.variations || [];
    if (allVariations.length > 0) {
      const selectedVariation = allVariations[Math.floor(Math.random() * allVariations.length)];
      return { text: selectedVariation, type: 'variation' };
    }
    
    // Check for button or media responses
    if (commentConfig.type === 'button' && commentConfig.button_text && commentConfig.button_url) {
      return { 
        text: commentConfig.message || commentConfig.button_text, 
        type: 'button',
        buttonText: commentConfig.button_text,
        buttonUrl: commentConfig.button_url
      };
    }
    
    if (commentConfig.type === 'media' && commentConfig.media_url) {
      return { 
        text: commentConfig.caption || '', 
        type: 'media',
        mediaUrl: commentConfig.media_url
      };
    }
  }
  
  // For DMs: handle based on support type per platform
  if (triggerType === 'dm') {
    const dmConfig = responseData.dm || responseData[platform] || responseData.general || responseData;
    
    if (dmConfig.support_type === 'tiered') {
      // Tiered support: escalate based on keywords or conversation history
      const tier = dmConfig.tiers?.find(t => 
        t.keywords?.some(k => (triggerText || '').toLowerCase().includes(k.toLowerCase()))
      );
      if (tier?.response) {
        return { text: tier.response, type: 'tiered_support' };
      }
    } else if (dmConfig.support_type === 'categorized') {
      // Categorized support: route based on issue type
      const category = dmConfig.categories?.find(c => 
        c.keywords?.some(k => (triggerText || '').toLowerCase().includes(k.toLowerCase()))
      );
      if (category?.response) {
        return { text: category.response, type: 'categorized_support' };
      }
    }
    
    // Check AI prompt for DMs
    const aiPrompt = dmConfig.system_prompt || automation.ai_prompt;
    if (aiPrompt) {
      const aiText = await generateReply(aiPrompt);
      if (aiText) return { text: aiText, type: 'ai' };
    }
    
    // Check for DM-specific variations
    const dmVariations = dmConfig.variations || automation.variations || [];
    if (dmVariations.length > 0) {
      const selectedVariation = dmVariations[Math.floor(Math.random() * dmVariations.length)];
      return { text: selectedVariation, type: 'variation' };
    }
    
    // Check for button or media responses for DMs
    if (dmConfig.type === 'button' && dmConfig.button_text && dmConfig.button_url) {
      return { 
        text: dmConfig.message || dmConfig.button_text, 
        type: 'button',
        buttonText: dmConfig.button_text,
        buttonUrl: dmConfig.button_url
      };
    }
    
    if (dmConfig.type === 'media' && dmConfig.media_url) {
      return { 
        text: dmConfig.caption || '', 
        type: 'media',
        mediaUrl: dmConfig.media_url
      };
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
    if (!sig) {
      console.log(`❌ Signature verification failed: Missing ${header} header`);
      addToDebugLog({ event: 'signature_check_failed', reason: 'missing_header', header });
      return false;
    }
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    let isValid = false;
    try {
      isValid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch (err) {
      console.log(`❌ Signature verification failed: ${err.message}`);
      addToDebugLog({ event: 'signature_check_failed', reason: 'error', error: err.message });
      return false;
    }
    if (!isValid) {
      console.log(`❌ Signature verification failed: Signature mismatch`);
      addToDebugLog({ event: 'signature_check_failed', reason: 'mismatch' });
    }
    return isValid;
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
    // Log raw payload for debugging BEFORE signature check
    const rawBody = req.body.toString('utf8');
    console.log('📥 Facebook webhook received - Raw payload:', rawBody.substring(0, 500));
    addToDebugLog({ 
      platform: 'facebook', 
      event: 'webhook_received', 
      headers: req.headers,
      rawPayload: JSON.parse(rawBody || '{}'),
      bodyLength: rawBody.length
    });
    
    if (!verifySignature(req, FB_APP_SECRET, 'x-hub-signature-256')) {
      return res.sendStatus(403);
    }
    res.sendStatus(200); // ack immediately; Facebook expects a fast 200

    let payload;
    try { 
      payload = JSON.parse(rawBody); 
    } catch (err) { 
      console.log(`❌ Failed to parse Facebook webhook payload: ${err.message}`);
      addToDebugLog({ platform: 'facebook', event: 'parse_error', error: err.message, rawBody });
      return; 
    }

    const platform = 'facebook';
    for (const entry of payload.entry || []) {
      // Comments arrive as "changes" with field "comments"
      for (const change of entry.changes || []) {
        if (change.field !== 'comments') {
          console.log(`⚠️  Skipping Facebook change with field: ${change.field}`);
          addToDebugLog({ platform, event: 'skipped_change', reason: 'field_mismatch', field: change.field });
          continue;
        }
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
    // Log raw payload for debugging BEFORE signature check
    const rawBody = req.body.toString('utf8');
    console.log('📥 Instagram webhook received - Raw payload:', rawBody.substring(0, 500));
    addToDebugLog({ 
      platform: 'instagram', 
      event: 'webhook_received', 
      headers: req.headers,
      rawPayload: JSON.parse(rawBody || '{}'),
      bodyLength: rawBody.length
    });
    
    // Signature verification with fallback: try IG_SECRET first, then FB_SECRET
    const secretsToTry = [IG_APP_SECRET, FB_APP_SECRET].filter(Boolean);
    let verified = false;
    let usedSecret = null;
    
    for (const secret of secretsToTry) {
      const secretName = secret === FB_APP_SECRET ? 'FB_APP_SECRET' : 'IG_APP_SECRET';
      console.log(`🔐 Trying ${secretName} for Instagram signature verification`);
      if (verifySignature(req, secret, 'x-hub-signature-256')) {
        verified = true;
        usedSecret = secretName;
        break;
      }
    }
    
    if (!verified) {
      console.log('❌ All signature verification attempts failed');
      return res.sendStatus(403);
    }
    
    console.log(`✅ Signature verified using ${usedSecret}`);
    res.sendStatus(200);

    let payload;
    try { 
      payload = JSON.parse(rawBody); 
    } catch (err) { 
      console.log(`❌ Failed to parse Instagram webhook payload: ${err.message}`);
      addToDebugLog({ platform: 'instagram', event: 'parse_error', error: err.message, rawBody });
      return; 
    }

    const platform = 'instagram';
    for (const entry of payload.entry || []) {
      // Comments arrive as "changes" with field "comments"
      for (const change of entry.changes || []) {
        if (change.field !== 'comments') {
          console.log(`⚠️  Skipping Instagram change with field: ${change.field}`);
          addToDebugLog({ platform, event: 'skipped_change', reason: 'field_mismatch', field: change.field });
          continue;
        }
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
      addToDebugLog({ 
        platform, 
        event: 'trigger_received', 
        triggerType, 
        text, 
        mediaId, 
        senderId, 
        accountId,
        replyTargetId 
      });
      
      const automations = await getActiveAutomations();
      const match = findMatch(automations, { platform, triggerType, text, mediaId });
      
      if (!match) {
        console.log(`⚠️  No matching automation found for ${platform}/${triggerType}`);
        addToDebugLog({ platform, event: 'no_automation_match', triggerType, text, mediaId });
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
      addToDebugLog({ platform, event: 'automation_matched', automationId: match.id, automationName: match.name, triggerType });
      
      const responseResult = await getResponseForTrigger(match, triggerType, platform, text);
      const reply = responseResult?.text;
      
      if (!reply) {
        console.log(`⚠️  No response generated for automation "${match.name}"`);
        addToDebugLog({ platform, event: 'no_response_generated', automationId: match.id, triggerType, responseData: match.response_data, variations: match.variations, ai_prompt: match.ai_prompt });
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

  // ===== Webhook Debug Log API Endpoint =====
  // Returns recent webhook events for debugging - protected by session auth
  r.get('/api/webhooks/debug-log', async (req, res) => {
    // Check if user is authenticated (simple session check)
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const limit = parseInt(req.query.limit) || 50;
    const filteredLog = webhookDebugLog.slice(-limit);
    res.json({ debugLog: filteredLog, totalEvents: webhookDebugLog.length });
  });

  // Clear debug log endpoint
  r.post('/api/webhooks/clear-debug-log', async (req, res) => {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    webhookDebugLog.length = 0; // Clear the array
    res.json({ success: true, message: 'Debug log cleared' });
  });

  return r;
}

module.exports = router;
