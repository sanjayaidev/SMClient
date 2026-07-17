const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Instagram Graph API config
const IG_BASE_URL = 'https://graph.facebook.com/v18.0';
const IG_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_BUSINESS_ID = process.env.INSTAGRAM_BUSINESS_ID;

// Database initialization
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        caption TEXT,
        hook VARCHAR(500),
        platforms JSONB,
        scheduled_date TIMESTAMP,
        status VARCHAR(50) DEFAULT 'draft',
        ig_media_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS automations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        keywords JSONB,
        ai_prompt TEXT,
        variations JSONB,
        is_active BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS connections (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(50) NOT NULL,
        account_name VARCHAR(255),
        access_token TEXT,
        is_connected BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
  }
}

// API Routes

// Get all posts
app.get('/api/posts', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM posts ORDER BY scheduled_date DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create post
app.post('/api/posts', async (req, res) => {
  try {
    const { title, caption, hook, platforms, scheduled_date } = req.body;
    const result = await pool.query(
      'INSERT INTO posts (title, caption, hook, platforms, scheduled_date) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, caption, hook, JSON.stringify(platforms), scheduled_date]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update post
app.put('/api/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, caption, hook, platforms, scheduled_date, status } = req.body;
    const result = await pool.query(
      'UPDATE posts SET title=$1, caption=$2, hook=$3, platforms=$4, scheduled_date=$5, status=$6, updated_at=CURRENT_TIMESTAMP WHERE id=$7 RETURNING *',
      [title, caption, hook, JSON.stringify(platforms), scheduled_date, status, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete post
app.delete('/api/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM posts WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get automations
app.get('/api/automations', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM automations ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create automation
app.post('/api/automations', async (req, res) => {
  try {
    const { name, type, keywords, ai_prompt, variations } = req.body;
    const result = await pool.query(
      'INSERT INTO automations (name, type, keywords, ai_prompt, variations) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, type, JSON.stringify(keywords), ai_prompt, JSON.stringify(variations)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle automation active status
app.patch('/api/automations/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE automations SET is_active = NOT is_active WHERE id=$1 RETURNING *',
      [id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Instagram Graph API - Get Media
app.get('/api/instagram/media', async (req, res) => {
  try {
    if (!IG_ACCESS_TOKEN || !IG_BUSINESS_ID) {
      return res.status(401).json({ error: 'Instagram credentials not configured' });
    }
    
    const response = await axios.get(`${IG_BASE_URL}/${IG_BUSINESS_ID}/media`, {
      params: {
        fields: 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count',
        limit: 25,
        access_token: IG_ACCESS_TOKEN
      }
    });
    
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Instagram Graph API - Get Insights
app.get('/api/instagram/insights', async (req, res) => {
  try {
    if (!IG_ACCESS_TOKEN || !IG_BUSINESS_ID) {
      return res.status(401).json({ error: 'Instagram credentials not configured' });
    }
    
    const response = await axios.get(`${IG_BASE_URL}/${IG_BUSINESS_ID}/insights`, {
      params: {
        metric: 'impressions,reach,profile_views,follower_count',
        period: 'day',
        access_token: IG_ACCESS_TOKEN
      }
    });
    
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Instagram Graph API - Search Hashtags
app.get('/api/instagram/hashtag-search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!IG_ACCESS_TOKEN || !IG_BUSINESS_ID) {
      return res.status(401).json({ error: 'Instagram credentials not configured' });
    }
    
    // Search for hashtag
    const searchResponse = await axios.get(`${IG_BASE_URL}/ig_hashtag_search`, {
      params: {
        user_id: IG_BUSINESS_ID,
        q: q,
        access_token: IG_ACCESS_TOKEN
      }
    });
    
    res.json(searchResponse.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Instagram Graph API - Get Hashtag Top Media
app.get('/api/instagram/hashtag/:id/top-media', async (req, res) => {
  try {
    const { id } = req.params;
    if (!IG_ACCESS_TOKEN) {
      return res.status(401).json({ error: 'Instagram credentials not configured' });
    }
    
    const response = await axios.get(`${IG_BASE_URL}/${id}/top_media`, {
      params: {
        fields: 'id,caption,media_type,media_url,like_count,comments_count',
        access_token: IG_ACCESS_TOKEN
      }
    });
    
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Serve HTML files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'about.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'terms.html'));
});

app.get('/privacy-policy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy-policy.html'));
});

app.get('/data-deletion', (req, res) => {
  res.sendFile(path.join(__dirname, 'data-deletion.html'));
});

// Start server
async function startServer() {
  await initDB();
  
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    if (process.env.DATABASE_URL) {
      console.log('✅ Connected to PostgreSQL');
    } else {
      console.log('⚠️  DATABASE_URL not set - using local mode');
    }
  });
}

startServer();
