const express = require('express');

module.exports = function insightsRouter(pool) {
    const router = express.Router();

    // GET /api/insights/account - Account-level insights
    router.get('/account', async (req, res) => {
        try {
            const { platform } = req.query;
            
            if (!platform || !['instagram', 'facebook', 'threads'].includes(platform)) {
                return res.status(400).json({ error: 'Invalid platform' });
            }

            // Get user's connections for this platform
            const userId = req.user.id;
            const connectionsResult = await pool.query(
                'SELECT * FROM connections WHERE user_id = $1 AND platform = $2 AND status = \'connected\'',
                [userId, platform]
            );

            if (connectionsResult.rows.length === 0) {
                return res.status(404).json({ error: 'No connected accounts found for this platform' });
            }

            const connection = connectionsResult.rows[0];
            const pageId = connection.page_id || connection.instagram_id || connection.threads_id;
            const accessToken = connection.access_token;

            let insightsData = { stats: {} };

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

                    insightsData.stats = {
                        followers: metrics.followers_count || metrics.follower_count || 0,
                        followerChange: 0, // Would need historical data
                        reach: metrics.reach || 0,
                        reachChange: 0,
                        impressions: metrics.impressions || 0,
                        impressionsChange: 0,
                        engagementRate: metrics.engagement || 0,
                        engagementChange: 0
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

                    insightsData.stats = {
                        followers: metrics.fan_count || 0,
                        followerChange: 0,
                        reach: metrics.page_impressions_unique || 0,
                        reachChange: 0,
                        impressions: metrics.page_posts_impressions_unique || 0,
                        impressionsChange: 0,
                        engagementRate: metrics.page_engaged_users ? (metrics.page_engaged_users / (metrics.page_impressions_unique || 1)) * 100 : 0,
                        engagementChange: 0
                    };
                }
            } else if (platform === 'threads') {
                // Threads API insights
                const insightsUrl = `https://graph.threads.net/v1.0/${pageId}/insights?metric=followers_count,replies,likes,reposts,quotes&access_token=${accessToken}`;
                
                const response = await fetch(insightsUrl);
                const data = await response.json();

                if (data.data) {
                    const metrics = {};
                    data.data.forEach(item => {
                        if (item.total_value) {
                            metrics[item.name] = item.total_value.value;
                        }
                    });

                    insightsData.stats = {
                        followers: metrics.followers_count || 0,
                        followerChange: 0,
                        reach: 0, // Threads doesn't provide reach in basic insights
                        reachChange: 0,
                        impressions: 0,
                        impressionsChange: 0,
                        engagementRate: ((metrics.likes || 0) + (metrics.replies || 0) + (metrics.reposts || 0)) / (metrics.followers_count || 1) * 100,
                        engagementChange: 0
                    };
                }
            }

            res.json(insightsData);
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

            const userId = req.user.id;
            const connectionsResult = await pool.query(
                'SELECT * FROM connections WHERE user_id = $1 AND platform = $2 AND status = \'connected\'',
                [userId, platform]
            );

            if (connectionsResult.rows.length === 0) {
                return res.status(404).json({ error: 'No connected accounts found for this platform' });
            }

            const connection = connectionsResult.rows[0];
            const pageId = connection.page_id || connection.instagram_id || connection.threads_id;
            const accessToken = connection.access_token;

            let postsData = { posts: [] };

            // Fetch posts with insights based on platform
            if (platform === 'instagram') {
                const mediaUrl = `https://graph.facebook.com/v18.0/${pageId}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count&limit=50&access_token=${accessToken}`;
                
                const response = await fetch(mediaUrl);
                const data = await response.json();

                if (data.data) {
                    postsData.posts = data.data.map(post => ({
                        id: post.id,
                        caption: post.caption || '',
                        thumbnail: post.thumbnail_url || post.media_url,
                        created_time: post.timestamp,
                        likes: post.like_count || 0,
                        comments: post.comments_count || 0,
                        shares: 0,
                        reach: 0
                    }));
                }
            } else if (platform === 'facebook') {
                const postsUrl = `https://graph.facebook.com/v18.0/${pageId}/posts?fields=id,message,created_time,full_picture,reactions.summary(true),comments.summary(true),shares&limit=50&access_token=${accessToken}`;
                
                const response = await fetch(postsUrl);
                const data = await response.json();

                if (data.data) {
                    postsData.posts = data.data.map(post => ({
                        id: post.id,
                        caption: post.message || '',
                        thumbnail: post.full_picture,
                        created_time: post.created_time,
                        likes: post.reactions?.summary?.total_count || 0,
                        comments: post.comments?.summary?.total_count || 0,
                        shares: post.shares?.count || 0,
                        reach: 0
                    }));
                }
            } else if (platform === 'threads') {
                const threadsUrl = `https://graph.threads.net/v1.0/${pageId}/threads?fields=id,text,timestamp,media_url,thumbnail_url,like_count,reply_count,repost_count,quote_count&limit=50&access_token=${accessToken}`;
                
                const response = await fetch(threadsUrl);
                const data = await response.json();

                if (data.data) {
                    postsData.posts = data.data.map(post => ({
                        id: post.id,
                        caption: post.text || '',
                        thumbnail: post.thumbnail_url || post.media_url,
                        created_time: post.timestamp,
                        likes: post.like_count || 0,
                        comments: post.reply_count || 0,
                        shares: (post.repost_count || 0) + (post.quote_count || 0),
                        reach: 0
                    }));
                }
            }

            res.json(postsData);
        } catch (error) {
            console.error('Error fetching post insights:', error);
            res.status(500).json({ error: 'Failed to fetch post insights', details: error.message });
        }
    });

    return router;
};
