const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { initDB } = require('./db/schema');
const { requireAuth, login } = require('./lib/auth');
const { startScheduler } = require('./scheduler');
const webhooksRouter = require('./routes/webhooks');
const connectionsRouter = require('./routes/connections');
const postsRouter = require('./routes/posts');
const automationsRouter = require('./routes/automations');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

app.use(cors());

// Webhook routes need the RAW body for signature verification, so they're
// mounted before express.json() and parse their own body internally.
app.use('/', webhooksRouter(pool));

app.use(express.json());
app.use(express.static(__dirname));

// --- Auth ---
app.post('/api/auth/login', login);

// --- Protected API routes ---
app.use('/api/connections', requireAuth, connectionsRouter(pool));
app.use('/api/posts', requireAuth, postsRouter(pool));
app.use('/api/automations', requireAuth, automationsRouter(pool));

// --- Static pages (unchanged) ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/privacy-policy', (req, res) => res.sendFile(path.join(__dirname, 'privacy-policy.html')));
app.get('/data-deletion', (req, res) => res.sendFile(path.join(__dirname, 'data-deletion.html')));

async function startServer() {
  await initDB(pool);
  startScheduler(pool);

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(process.env.DATABASE_URL ? '✅ Connected to PostgreSQL' : '⚠️  DATABASE_URL not set');
  });
}

startServer();
