const axios = require('axios');

// Uses graph.facebook.com because this app connects IG via a Facebook Page
// (Facebook Login for Business), matching the fb-login-test.js flow — not
// the direct Instagram Login flow.
const VERSION = process.env.GRAPH_VERSION || 'v25.0';
const BASE = `https://graph.facebook.com/${VERSION}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, params, token) {
  const res = await axios.get(url, { params: { ...params, access_token: token } });
  return res.data;
}
async function post(url, bodyParams, token) {
  const query = new URLSearchParams({ ...bodyParams, access_token: token }).toString();
  const res = await axios.post(`${url}?${query}`);
  return res.data;
}

async function publishPost(token, igId, { caption, mediaUrl }) {
  if (!mediaUrl) throw new Error('Instagram requires an image_url — set media_url on the post.');
  const create = await post(`${BASE}/${igId}/media`, { image_url: mediaUrl, caption: caption || '' }, token);
  const creationId = create.id;

  let statusCode = 'IN_PROGRESS';
  for (let i = 0; i < 5 && statusCode === 'IN_PROGRESS'; i++) {
    await sleep(2000);
    const statusRes = await get(`${BASE}/${creationId}`, { fields: 'status_code' }, token);
    statusCode = statusRes.status_code;
  }

  const publish = await post(`${BASE}/${igId}/media_publish`, { creation_id: creationId }, token);
  return publish.id;
}

async function replyToComment(token, mediaOrCommentId, message) {
  const res = await post(`${BASE}/${mediaOrCommentId}/comments`, { message }, token);
  return res.id;
}

async function sendDM(token, igId, recipientId, text) {
  const res = await post(`${BASE}/${igId}/messages`, {
    recipient: JSON.stringify({ id: recipientId }),
    message: JSON.stringify({ text }),
  }, token);
  return res.message_id;
}

// Recent media already published to this IG business account, straight from
// Meta — used so the automation builder can target posts that were published
// outside this app (e.g. from the native Instagram app) and not just posts
// this app scheduled itself.
async function listRecentMedia(token, igId, limit = 25) {
  const res = await get(`${BASE}/${igId}/media`, {
    fields: 'id,caption,timestamp,permalink,media_type,media_url,thumbnail_url',
    limit,
  }, token);
  return res.data || [];
}

// Kept for parity with the test scripts / manual debugging — the webhook
// flow doesn't need this since it gets the sender id directly from the event.
async function getRecipientFromLatestConversation(token, igId, myUsername) {
  const convos = await get(`${BASE}/${igId}/conversations`, { platform: 'instagram' }, token);
  const thread = convos.data && convos.data[0];
  if (!thread) return null;
  const threadRes = await get(`${BASE}/${thread.id}`, { fields: 'participants{id,username}' }, token);
  const participants = threadRes.participants?.data || [];
  // Match by username, not id — see mst.js debugging notes: the participants
  // edge can represent your own account under a different id than /me does.
  return participants.find((p) => p.username !== myUsername) || null;
}

module.exports = { publishPost, replyToComment, sendDM, getRecipientFromLatestConversation, listRecentMedia };
