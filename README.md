# 🔥 Roast My Golf Game

Get brutally roasted based on your GHIN handicap. No mercy.

## Local Setup

```bash
npm install
export ANTHROPIC_API_KEY=your_key_here
npm start
```

Open http://localhost:3000

## Deploy to Railway

1. Push to GitHub
2. Connect repo at [railway.app](https://railway.app)
3. Add environment variable: `ANTHROPIC_API_KEY`
4. Deploy

## Deploy to Render

1. Push to GitHub  
2. New Web Service at [render.com](https://render.com)
3. Connect repo, set:
   - Build: `npm install`
   - Start: `npm start`
4. Add env var: `ANTHROPIC_API_KEY`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Get from console.anthropic.com |
| `PORT` | No | Auto-set by hosting platform |

## Tip Jar

Update the Ko-fi link in `public/index.html` with your username.

## Files

```
├── server.js          # Express API
├── public/index.html  # Frontend
├── package.json
└── .gitignore
```
