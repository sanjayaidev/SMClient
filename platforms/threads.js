const axios = require('axios');

const VERSION = process.env.THREADS_VERSION || 'v1.0';
const BASE = `https://graph.threads.net/${VERSION}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, bodyParams, token) {
  const query = new URLSearchParams({ ...bodyParams, access_token: token }).toString();
  const res = await axios.post(`${url}?${query}`);
  return res.data;
}

async function publishPost(token, threadsUserId, { caption }) {
  const create = await post(`${BASE}/${threadsUserId}/threads`, { media_type: 'TEXT', text: caption || '' }, token);
  // Meta's own guidance: wait for container processing before publishing.
  await sleep(30000);
  const publish = await post(`${BASE}/${threadsUserId}/threads_publish`, { creation_id: create.id }, token);
  return publish.id;
}

async function replyToThread(token, threadsUserId, replyToId, text) {
  const create = await post(`${BASE}/${threadsUserId}/threads`, {
    media_type: 'TEXT',
    text,
    reply_to_id: replyToId,
  }, token);
  await sleep(30000);
  const publish = await post(`${BASE}/${threadsUserId}/threads_publish`, { creation_id: create.id }, token);
  return publish.id;
}

// Threads has no messaging/DM API as of this writing — intentionally not implemented.
async function sendDM() {
  throw new Error('Threads has no DM/messaging API — this is a platform limitation, not a bug.');
}

module.exports = { publishPost, replyToThread, sendDM };
