const cron = require('node-cron');
const { decrypt } = require('./lib/crypto');
const instagram = require('./platforms/instagram');
const facebook = require('./platforms/facebook');
const threads = require('./platforms/threads');

// Picks the most-recently-connected account for a platform per user.
async function getConnection(pool, platform, userId) {
  const res = await pool.query(
    'SELECT * FROM connections WHERE platform=$1 AND is_connected=true AND user_id=$2 ORDER BY updated_at DESC LIMIT 1',
    [platform, userId]
  );
  return res.rows[0] || null;
}

async function publishToPlatform(pool, platform, post) {
  const conn = await getConnection(pool, platform, post.user_id);
  if (!conn) throw new Error(`No connected ${platform} account`);
  const token = decrypt(conn.access_token);

  if (platform === 'instagram') {
    return instagram.publishPost(token, conn.account_id, { caption: post.caption, mediaUrl: post.media_url });
  }
  if (platform === 'facebook') {
    return facebook.publishPost(token, conn.page_id || conn.account_id, { caption: post.caption, mediaUrl: post.media_url });
  }
  if (platform === 'threads') {
    return threads.publishPost(token, conn.account_id, { caption: post.caption });
  }
  throw new Error(`Unknown platform: ${platform}`);
}

async function publishOnePost(pool, post) {
  const platforms = Array.isArray(post.platforms) ? post.platforms : [];
  const publishedIds = { ...(post.published_ids || {}) };
  const errors = { ...(post.publish_errors || {}) };
  let anySuccess = false;
  let anyFailure = false;

  for (const platform of platforms) {
    try {
      const id = await publishToPlatform(pool, platform, post);
      publishedIds[platform] = id;
      anySuccess = true;
    } catch (err) {
      errors[platform] = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      anyFailure = true;
      console.error(`Publish failed for post ${post.id} on ${platform}:`, errors[platform]);
    }
  }

  const status = anyFailure ? (anySuccess ? 'partial' : 'failed') : 'published';
  await pool.query(
    `UPDATE posts SET status=$1, published_ids=$2, publish_errors=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$4`,
    [status, JSON.stringify(publishedIds), JSON.stringify(errors), post.id]
  );
}

async function publishDuePosts(pool) {
  const due = await pool.query(
    `SELECT * FROM posts WHERE status='scheduled' AND scheduled_date <= NOW()`
  );
  for (const post of due.rows) {
    await publishOnePost(pool, post);
  }
}

// Used by the manual "publish now" endpoint — bypasses the scheduled_date/status check.
async function publishDuePostById(pool, id) {
  const result = await pool.query('SELECT * FROM posts WHERE id=$1', [id]);
  const post = result.rows[0];
  if (!post) throw new Error('Post not found');
  await publishOnePost(pool, post);
}

function startScheduler(pool) {
  // Every minute — publishing isn't precise-to-the-second on any of these
  // platforms anyway, so a 1-minute poll interval is plenty.
  cron.schedule('* * * * *', () => {
    publishDuePosts(pool).catch((err) => console.error('Scheduler tick failed:', err.message));
  });
  console.log('⏰ Scheduler started (checks every minute for due posts)');
}

module.exports = { startScheduler, publishDuePosts, publishDuePostById };
