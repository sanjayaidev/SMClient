const express = require('express');
const crypto = require('crypto');
const { decrypt } = require('../lib/crypto');
const { findMatch, pickResponse } = require('../automations/matcher');
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
    const res = await pool.query('SELECT * FROM automations WHERE is_active=true');
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

    async function handleTrigger({ platform, triggerType, text, replyTargetId, senderId, accountId }) {
      const automations = await getActiveAutomations();
      const match = findMatch(automations, { platform, triggerType, text });
      if (!match) return;
      const reply = await pickResponse(match);
      if (!reply) return;

      const conn = await getConnection(platform, accountId);
      if (!conn) { console.error(`No connected ${platform} account to reply with`); return; }
      const token = decrypt(conn.access_token);

      try {
        if (triggerType === 'comment') {
          await facebook.replyToComment(token, replyTargetId, reply);
        } else if (triggerType === 'dm') {
          await facebook.sendDM(token, conn.account_id || conn.page_id, senderId, reply);
        }
      } catch (err) {
        console.error(`Auto-reply failed (${platform}/${triggerType}):`, err.response?.data || err.message);
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

    async function handleTrigger({ platform, triggerType, text, replyTargetId, senderId, accountId }) {
      const automations = await getActiveAutomations();
      const match = findMatch(automations, { platform, triggerType, text });
      if (!match) return;
      const reply = await pickResponse(match);
      if (!reply) return;

      const conn = await getConnection(platform, accountId);
      if (!conn) { console.error(`No connected ${platform} account to reply with`); return; }
      const token = decrypt(conn.access_token);

      try {
        if (triggerType === 'comment') {
          await instagram.replyToComment(token, replyTargetId, reply);
        } else if (triggerType === 'dm') {
          await instagram.sendDM(token, conn.account_id || conn.page_id, senderId, reply);
        }
      } catch (err) {
        console.error(`Auto-reply failed (${platform}/${triggerType}):`, err.response?.data || err.message);
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

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'replies') continue; // adjust once real payloads are confirmed
        const value = change.value;
        const replyId = value.id;
        const text = value.text;
        if (await alreadyProcessed(`threads_reply:${replyId}`)) continue;

        const automations = await getActiveAutomations();
        const match = findMatch(automations, { platform: 'threads', triggerType: 'comment', text });
        if (!match) continue;
        const reply = await pickResponse(match);
        if (!reply) continue;

        const conn = await getConnection('threads');
        if (!conn) { console.error('No connected Threads account to reply with'); continue; }
        const token = decrypt(conn.access_token);
        try {
          await threads.replyToThread(token, conn.account_id, replyId, reply);
        } catch (err) {
          console.error('Threads auto-reply failed:', err.response?.data || err.message);
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
