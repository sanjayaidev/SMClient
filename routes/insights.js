const express = require('express');
const { requireAuth } = require('../lib/auth');
const { decrypt } = require('../lib/crypto');

// Keep this in sync with routes/connections.js so insights hit the same
// Graph API version the tokens were issued/used against.
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';

// Helper: call the Graph API and normalize errors so callers always know
// whether they got real data or a failure, instead of silently getting 0s.
async function fetchGraphInsights(url) {
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
        const err = new Error(data.error.message || 'Graph API error');
        err.graphError = data.error;
        err.status = response.status;
        throw err;
    }

    return data;
}

module.exports = function insightsRouter(pool) {
    const router = express.Router();

    // Apply authentication to all routes
    router.use(requireAuth);

    // GET /api/insights/account - Account-level insights
    router.get('/account', async (req, res) => {
        try {
            const { platform } = req.query;

            if (!platform || !['instagram', 'facebook', 'threads'].includes(platform)) {
                return res.status(400).json({ error: 'Invalid platform' });
            }

            // Get user's connections for this platform
            const userId = req.user.id || req.user.sub;
            const connectionsResult = await pool.query(
                "SELECT * FROM connections WHERE user_id = $1 AND platform = $2 AND is_connected = true",
                [userId, platform]
            );

            if (connectionsResult.rows.length === 0) {
                return res.status(404).json({ error: 'No connected accounts found for this platform' });
            }

            const connection = connectionsResult.rows[0];
            const pageId = connection.account_id || connection.page_id;
            // BUG FIX: access_token is stored encrypted at rest (see lib/crypto.js).
            // Every other route (posts.js, media.js, comments.js) decrypts it before
            // calling Graph; this route was sending the raw ciphertext as the token,
            // so every Graph API call failed auth and silently fell through to 0s.
            const accessToken = decrypt(connection.access_token);

            let responseData = { data: {} };

            // Fetch insights based on platform
            if (platform === 'instagram') {
                // Instagram Business API insights.
                // NOTE: 'impressions' was retired by Meta for IG accounts created
                // after Jul 2, 2024 (and is being sunset generally) — 'views' is
                // the supported replacement metric.
                const insightFields = 'follower_count,reach,views,accounts_engaged';
                const insightsUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/insights?metric=${insightFields}&period=day&access_token=${accessToken}`;

                const data = await fetchGraphInsights(insightsUrl);

                const metrics = {};
                (data.data || []).forEach(item => {
                    if (item.values && item.values.length > 0) {
                        metrics[item.name] = item.values[item.values.length - 1].value;
                    } else if (typeof item.total_value?.value !== 'undefined') {
                        metrics[item.name] = item.total_value.value;
                    }
                });

                responseData.data = {
                    followers: metrics.follower_count || 0,
                    reach: metrics.reach || 0,
                    impressions: metrics.views || 0,
                    engagement: metrics.accounts_engaged || 0
                };
            } else if (platform === 'facebook') {
                // Facebook Page Insights.
                // NOTE: page_impressions_unique / page_posts_impressions_unique were
                // deprecated in the v20+ era, and Meta deprecated the plain
                // `page_impressions` metric too as of June 15, 2026 (impressions ->
                // views across the Page Insights API). page_views is the current
                // supported metric — verify against Graph API Explorer periodically,
                // as Meta has been iterating on these names throughout 2025-2026.
                const insightFields = 'page_views,page_post_engagements';
                const insightsUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/insights?metric=${insightFields}&period=day&access_token=${accessToken}`;

                const data = await fetchGraphInsights(insightsUrl);

                const metrics = {};
                (data.data || []).forEach(item => {
                    if (item.values && item.values.length > 0) {
                        metrics[item.name] = item.values[item.values.length - 1].value;
                    }
                });

                // fan_count lives on the Page node itself, not the insights edge.
                let fanCount = 0;
                try {
                    const pageInfo = await fetchGraphInsights(
                        `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}?fields=fan_count&access_token=${accessToken}`
                    );
                    if (typeof pageInfo.fan_count === 'number') fanCount = pageInfo.fan_count;
                } catch (e) {
                    console.error('Error fetching page fan_count:', e.message);
                }

                responseData.data = {
                    followers: fanCount,
                    reach: metrics.page_views || 0,
                    impressions: metrics.page_views || 0,
                    engagement: metrics.page_post_engagements || 0
                };
            } else if (platform === 'threads') {
                // Threads API insights - using correct endpoint
                const threadsUserId = pageId; // This should be the threads user ID

                const insightsUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${threadsUserId}/threads_insights?metric=views,likes,replies,reposts,quotes,followers_count&access_token=${accessToken}`;

                const data = await fetchGraphInsights(insightsUrl);

                const metrics = {};
                (data.data || []).forEach(item => {
                    if (item.values && item.values.length > 0) {
                        metrics[item.name] = item.values[item.values.length - 1].value;
                    } else if (typeof item.total_value?.value !== 'undefined') {
                        metrics[item.name] = item.total_value.value;
                    }
                });

                responseData.data = {
                    followers: metrics.followers_count || 0,
                    views: metrics.views || 0,
                    likes: metrics.likes || 0,
                    replies: metrics.replies || 0,
                    reposts: metrics.reposts || 0
                };
            }

            res.json(responseData);
        } catch (error) {
            console.error('Error fetching account insights:', error.graphError || error);
            // Surface the real reason (expired token, missing permission, etc.)
            // instead of masking it as a generic 500 with no detail.
            const status = error.graphError ? 502 : 500;
            res.status(status).json({
                error: 'Failed to fetch insights',
                details: error.graphError?.message || error.message,
                code: error.graphError?.code,
                subcode: error.graphError?.error_subcode
            });
        }
    });

    // GET /api/insights/posts - Post-level insights
    router.get('/posts', async (req, res) => {
        try {
            const { platform } = req.query;

            if (!platform || !['instagram', 'facebook', 'threads'].includes(platform)) {
                return res.status(400).json({ error: 'Invalid platform' });
            }

            const userId = req.user.id || req.user.sub;
            const connectionsResult = await pool.query(
                "SELECT * FROM connections WHERE user_id = $1 AND platform = $2 AND is_connected = true",
                [userId, platform]
            );

            if (connectionsResult.rows.length === 0) {
                return res.status(404).json({ error: 'No connected accounts found for this platform' });
            }

            const connection = connectionsResult.rows[0];
            const pageId = connection.account_id || connection.page_id;
            // BUG FIX: decrypt the stored token (see note in /account above).
            const accessToken = decrypt(connection.access_token);

            let responseData = { data: [] };

            // Fetch posts with insights based on platform
            if (platform === 'instagram') {
                const mediaUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count&limit=25&access_token=${accessToken}`;

                const data = await fetchGraphInsights(mediaUrl);

                responseData.data = (data.data || []).map(post => ({
                    id: post.id,
                    caption: post.caption || '',
                    message: post.caption || '',
                    date: post.timestamp,
                    thumbnail: post.thumbnail_url || post.media_url,
                    likes: post.like_count || 0,
                    comments: post.comments_count || 0,
                    shares: 0,
                    saves: 0,
                    reach: 0
                }));
            } else if (platform === 'facebook') {
                const postsUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/posts?fields=id,message,created_time,full_picture,permalink_url,reactions.summary(true),comments.summary(true),shares&limit=25&access_token=${accessToken}`;

                const data = await fetchGraphInsights(postsUrl);

                responseData.data = (data.data || []).map(post => ({
                    id: post.id,
                    caption: post.message || '',
                    message: post.message || '',
                    date: post.created_time,
                    thumbnail: post.full_picture,
                    link: post.permalink_url,
                    likes: post.reactions?.summary?.total_count || 0,
                    comments: post.comments?.summary?.total_count || 0,
                    shares: post.shares?.count || 0,
                    reach: 0
                }));
            } else if (platform === 'threads') {
                const threadsUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/threads?fields=id,text,timestamp,permalink_url,like_count,reply_count,repost_count,quote_count&limit=25&access_token=${accessToken}`;

                const data = await fetchGraphInsights(threadsUrl);

                responseData.data = (data.data || []).map(post => ({
                    id: post.id,
                    caption: post.text || '',
                    message: post.text || '',
                    date: post.timestamp,
                    link: post.permalink_url,
                    likes: post.like_count || 0,
                    comments: post.reply_count || 0,
                    replies: post.reply_count || 0,
                    reposts: post.repost_count || 0,
                    quotes: post.quote_count || 0
                }));
            }

            res.json(responseData);
        } catch (error) {
            console.error('Error fetching post insights:', error.graphError || error);
            const status = error.graphError ? 502 : 500;
            res.status(status).json({
                error: 'Failed to fetch post insights',
                details: error.graphError?.message || error.message,
                code: error.graphError?.code,
                subcode: error.graphError?.error_subcode
            });
        }
    });

    return router;
};
