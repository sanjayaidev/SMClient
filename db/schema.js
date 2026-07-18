async function initDB(pool) {
  // --- users: multi-tenant user store with email/password auth ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // --- posts: add media_url (IG/FB require an image), and per-platform
  // published-id tracking (original schema only had one ig_media_id column) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
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
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_url TEXT`);
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS published_ids JSONB DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS publish_errors JSONB DEFAULT '{}'::jsonb`);

  // --- automations: add platform + trigger type so the webhook handler
  // knows what an automation applies to ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS automations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(50) NOT NULL,
      keywords JSONB,
      ai_prompt TEXT,
      variations JSONB,
      is_active BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // type is repurposed as trigger type: 'comment' or 'dm'. platforms says
  // which connected platforms this automation should run on.
  await pool.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS platforms JSONB DEFAULT '["instagram","facebook","threads"]'::jsonb`);

  // --- connections: real multi-account store, tokens encrypted at rest
  // (see lib/crypto.js) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connections (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(50) NOT NULL,
      account_name VARCHAR(255),
      access_token TEXT,
      is_connected BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS account_id VARCHAR(255)`);
  await pool.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS page_id VARCHAR(255)`); // FB only
  await pool.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP`);
  await pool.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'connections_platform_account_unique'
      ) THEN
        ALTER TABLE connections ADD CONSTRAINT connections_platform_account_unique UNIQUE (user_id, platform, account_id);
      END IF;
    END $$;
  `);

  // --- webhook idempotency: Meta retries webhook deliveries, so track
  // which event ids we've already acted on ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_webhook_events (
      event_id VARCHAR(500) PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('✅ Database tables initialized');
}

module.exports = { initDB };
