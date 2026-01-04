# 🔥 Roast My Golf Game

Get brutally roasted based on your GHIN handicap. No mercy.

## Local Setup

```bash
npm install
export XAI_API_KEY=your_grok_api_key
npm start
```

Open http://localhost:3000

## Get Grok API Key

1. Go to [console.x.ai](https://console.x.ai)
2. Create account / sign in
3. Generate API key

## Deploy to Railway

1. Push to GitHub
2. Connect repo at [railway.app](https://railway.app)
3. Add environment variable: `XAI_API_KEY`
4. Deploy

## Deploy to Render

1. Push to GitHub  
2. New Web Service at [render.com](https://render.com)
3. Connect repo, set:
   - Build: `npm install`
   - Start: `npm start`
4. Add env var: `XAI_API_KEY`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `XAI_API_KEY` | Yes | Grok API key from console.x.ai |
| `PORT` | No | Auto-set by hosting platform |

## Tip Jar

Update the Ko-fi link in `public/index.html` with your username.

## Files

```
├── server.js          # Express API (uses Grok)
├── public/index.html  # Frontend
├── package.json
└── .gitignore
```
