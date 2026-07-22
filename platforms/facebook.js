const axios = require('axios');

const VERSION = process.env.GRAPH_VERSION || 'v25.0';
const BASE = `https://graph.facebook.com/${VERSION}`;

async function get(url, params, token) {
  const res = await axios.get(url, { params: { ...params, access_token: token } });
  return res.data;
}
async function post(url, bodyParams, token) {
  const query = new URLSearchParams({ ...bodyParams, access_token: token }).toString();
  const res = await axios.post(`${url}?${query}`);
  return res.data;
}

async function publishPost(token, pageId, { caption, mediaUrl }) {
  if (mediaUrl) {
    const res = await post(`${BASE}/${pageId}/photos`, { url: mediaUrl, caption: caption || '' }, token);
    return res.post_id || res.id;
  }
  const res = await post(`${BASE}/${pageId}/feed`, { message: caption || '' }, token);
  return res.id;
}

// Recent posts already published to this Page, straight from Meta — used so
// the automation builder can target posts made outside this app.
async function listRecentPosts(token, pageId, limit = 25) {
  const res = await get(`${BASE}/${pageId}/posts`, {
    fields: 'id,message,created_time,permalink_url,full_picture',
    limit,
  }, token);
  return res.data || [];
}

async function replyToComment(token, objectId, message) {
  const res = await post(`${BASE}/${objectId}/comments`, { message }, token);
  return res.id;
}

async function sendDM(token, pageId, recipientId, text) {
  const res = await post(`${BASE}/${pageId}/messages`, {
    recipient: JSON.stringify({ id: recipientId }),
    message: JSON.stringify({ text }),
    messaging_type: 'RESPONSE',
  }, token);
  return res.message_id;
}

module.exports = { publishPost, replyToComment, sendDM, listRecentPosts };
