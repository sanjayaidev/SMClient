# Instagram Hashtag Analyzer - Content Planner

A full-stack content planning application with Instagram Graph API integration, built for deployment on Railway.

## Features

- 📅 Visual calendar for scheduling posts
- 🔗 Instagram Graph API integration for real data
- 💾 PostgreSQL database for persistent storage
- ⚡ Automation rules for content responses
- 📊 Analytics and insights dashboard

## Deployment on Railway

### 1. Push to GitHub
```bash
git add .
git commit -m "Initial commit"
git push origin main
```

### 2. Connect to Railway
1. Go to [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repository

### 3. Add PostgreSQL Database
1. In your Railway project, click "+ New" → "Database" → "PostgreSQL"
2. Railway will automatically provision a database and set `DATABASE_URL`

### 4. Configure Environment Variables
In Railway dashboard, add these variables:
- `INSTAGRAM_ACCESS_TOKEN` - Your Meta Graph API access token
- `INSTAGRAM_BUSINESS_ID` - Your Instagram Business Account ID
- `NODE_ENV` = `production`

### 5. Deploy
Railway will automatically deploy using `npm start`

## Local Development

### Prerequisites
- Node.js 18+
- PostgreSQL (optional for local dev)

### Setup
```bash
npm install
cp .env.example .env
# Edit .env with your credentials
npm run dev
```

Open http://localhost:3000

## API Endpoints

### Posts
- `GET /api/posts` - Get all posts
- `POST /api/posts` - Create new post
- `PUT /api/posts/:id` - Update post
- `DELETE /api/posts/:id` - Delete post

### Automations
- `GET /api/automations` - Get all automations
- `POST /api/automations` - Create automation
- `PATCH /api/automations/:id/toggle` - Toggle active status

### Instagram Graph API
- `GET /api/instagram/media` - Get media from Instagram
- `GET /api/instagram/insights` - Get analytics insights
- `GET /api/instagram/hashtag-search?q={query}` - Search hashtags
- `GET /api/instagram/hashtag/:id/top-media` - Get top media for hashtag

## Database Schema

### posts
- id, title, caption, hook, platforms (JSONB), scheduled_date, status, ig_media_id, created_at, updated_at

### automations
- id, name, type, keywords (JSONB), ai_prompt, variations (JSONB), is_active, created_at

### connections
- id, platform, account_name, access_token, is_connected, created_at

## Instagram Graph API Setup

1. Go to [Meta Developers](https://developers.facebook.com/)
2. Create an app with Instagram Graph API product
3. Get Access Token with permissions: `instagram_basic`, `pages_show_list`, `instagram_manage_insights`
4. Add your Instagram Business Account ID

## Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Backend**: Node.js, Express
- **Database**: PostgreSQL
- **API**: Instagram Graph API v18.0
- **Deployment**: Railway

## License

ISC
