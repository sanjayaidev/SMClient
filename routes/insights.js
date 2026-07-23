const express = require('express');
const { requireAuth } = require('../lib/auth');

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
                "SELECT * FROM connections WHERE user_id = $1 AND platform = $2 AND status = 'connected'",
                [userId, platform]
            );

            if (connectionsResult.rows.length === 0) {
                return res.status(404).json({ error: 'No connected accounts found for this platform' });
            }

            const connection = connectionsResult.rows[0];
            const pageId = connection.page_id || connection.instagram_id || connection.threads_id;
            const accessToken = connection.access_token;

            let responseData = { data: {} };

            // Fetch insights based on platform
            if (platform === 'instagram') {
                // Instagram Business API insights
                const insightFields = 'followers_count,follower_count,reach,impressions,engagement';
                const insightsUrl = `https://graph.facebook.com/v18.0/${pageId}/insights?metric=${insightFields}&access_token=${accessToken}`;

                const response = await fetch(insightsUrl);
                const data = await response.json();

                if (data.data) {
                    const metrics = {};
                    data.data.forEach(item => {
                        if (item.values && item.values.length > 0) {
                            metrics[item.name] = item.values[item.values.length - 1].value;
                        }
                    });

                    responseData.data = {
                        followers: metrics.followers_count || metrics.follower_count || 0,
                        reach: metrics.reach || 0,
                        impressions: metrics.impressions || 0,
                        engagement: metrics.engagement || 0
                    };
                }
            } else if (platform === 'facebook') {
                // Facebook Page Insights
                const insightFields = 'fan_count,page_impressions_unique,page_posts_impressions_unique,page_engaged_users';
                const insightsUrl = `https://graph.facebook.com/v18.0/${pageId}/insights?metric=${insightFields}&access_token=${accessToken}`;

                const response = await fetch(insightsUrl);
                const data = await response.json();

                if (data.data) {
                    const metrics = {};
                    data.data.forEach(item => {
                        if (item.values && item.values.length > 0) {
                            metrics[item.name] = item.values[item.values.length - 1].value;
                        }
                    });

                    responseData.data = {
                        followers: metrics.fan_count || 0,
                        reach: metrics.page_impressions_unique || 0,
                        impressions: metrics.page_posts_impressions_unique || 0,
                        engagement: metrics.page_engaged_users || 0
                    };
                }
            } else if (platform === 'threads') {
                // Threads API insights - using correct endpoint
                const threadsUserId = pageId; // This should be the threads user ID
                
                const insightsUrl = `https://graph.facebook.com/v18.0/${threadsUserId}/insights?metric=views,likes,replies,reposts,quotes&access_token=${accessToken}`;

                const response = await fetch(insightsUrl);
                const data = await response.json();

                if (data.data) {
                    const metrics = {};
                    data.data.forEach(item => {
                        if (item.values && item.values.length > 0) {
                            metrics[item.name] = item.values[item.values.length - 1].value;
                        }
                    });

                    responseData.data = {
                        views: metrics.views || 0,
                        likes: metrics.likes || 0,
                        replies: metrics.replies || 0,
                        reposts: metrics.reposts || 0
                    };
                }
            }

            res.json(responseData);
        } catch (error) {
            console.error('Error fetching account insights:', error);
            res.status(500).json({ error: 'Failed to fetch insights', details: error.message });
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
                "SELECT * FROM connections WHERE user_id = $1 AND platform = $2 AND status = 'connected'",
                [userId, platform]
            );

            if (connectionsResult.rows.length === 0) {
                return res.status(404).json({ error: 'No connected accounts found for this platform' });
            }

            const connection = connectionsResult.rows[0];
            const pageId = connection.page_id || connection.instagram_id || connection.threads_id;
            const accessToken = connection.access_token;

            let responseData = { data: [] };

            // Fetch posts with insights based on platform
            if (platform === 'instagram') {
                const mediaUrl = `https://graph.facebook.com/v18.0/${pageId}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,saved_count&limit=25&access_token=${accessToken}`;

                const response = await fetch(mediaUrl);
                const data = await response.json();

                if (data.data) {
                    responseData.data = data.data.map(post => ({
                        id: post.id,
                        message: post.caption || '',
                        date: post.timestamp,
                        thumbnail: post.thumbnail_url || post.media_url,
                        likes: post.like_count || 0,
                        comments: post.comments_count || 0,
                        shares: 0,
                        saves: post.saved_count || 0,
                        reach: 0
                    }));
                }
            } else if (platform === 'facebook') {
                const postsUrl = `https://graph.facebook.com/v18.0/${pageId}/posts?fields=id,message,created_time,full_picture,permalink_url,reactions.summary(true),comments.summary(true),shares&limit=25&access_token=${accessToken}`;

                const response = await fetch(postsUrl);
                const data = await response.json();

                if (data.data) {
                    responseData.data = data.data.map(post => ({
                        id: post.id,
                        message: post.message || '',
                        date: post.created_time,
                        thumbnail: post.full_picture,
                        link: post.permalink_url,
                        likes: post.reactions?.summary?.total_count || 0,
                        comments: post.comments?.summary?.total_count || 0,
                        shares: post.shares?.count || 0,
                        reach: 0
                    }));
                }
            } else if (platform === 'threads') {
                const threadsUrl = `https://graph.facebook.com/v18.0/${pageId}/threads?fields=id,text,timestamp,permalink_url,like_count,reply_count,repost_count,quote_count&limit=25&access_token=${accessToken}`;

                const response = await fetch(threadsUrl);
                const data = await response.json();

                if (data.data) {
                    responseData.data = data.data.map(post => ({
                        id: post.id,
                        message: post.text || '',
                        date: post.timestamp,
                        link: post.permalink_url,
                        likes: post.like_count || 0,
                        comments: post.reply_count || 0,
                        reposts: post.repost_count || 0,
                        quotes: post.quote_count || 0
                    }));
                }
            }

            res.json(responseData);
        } catch (error) {
            console.error('Error fetching post insights:', error);
            res.status(500).json({ error: 'Failed to fetch post insights', details: error.message });
        }
    });

    return router;
};
