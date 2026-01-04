# 🔥 Roast My Golf Game

A brutally honest golf roast generator. Enter your GHIN credentials, get destroyed.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set your Anthropic API key** (for AI-generated roasts):
   ```bash
   export ANTHROPIC_API_KEY=your_key_here
   ```
   
   Get a key at: https://console.anthropic.com/
   
   *Without an API key, the app will use pre-written fallback roasts.*

3. **Run the server:**
   ```bash
   npm start
   ```

4. **Open in browser:**
   ```
   http://localhost:3000
   ```

## How it works

1. Enter your GHIN number/email and password
2. App fetches your handicap data from GHIN
3. Claude generates a personalized roast based on your stats
4. Cry into your putter

## Files

```
roast-golf/
├── server.js        # Express backend (handles GHIN + Anthropic APIs)
├── public/
│   └── index.html   # Frontend (Windows 95 style)
├── package.json
└── README.md
```

## Notes

- Your GHIN credentials are only used to fetch your data and are not stored
- The roasts are meant to be funny, not actually mean (mostly)
- Ad spaces included for future monetization
