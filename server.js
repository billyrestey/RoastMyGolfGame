const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// GHIN Login endpoint
app.post('/api/ghin', async (req, res) => {
    const { email_or_ghin, password } = req.body;

    try {
        const response = await fetch('https://api2.ghin.com/api/v1/golfer_login.json', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user: {
                    email_or_ghin,
                    password,
                    remember_me: 'true'
                },
                token: 'roastmygolfgame'
            })
        });

        const data = await response.json();

        if (!response.ok || !data.golfer_user?.golfers?.length) {
            return res.status(401).json({ error: 'Invalid credentials or no golfer found' });
        }

        res.json(data.golfer_user.golfers[0]);
    } catch (error) {
        console.error('GHIN API error:', error);
        res.status(500).json({ error: 'Failed to connect to GHIN' });
    }
});

// Roast generation endpoint - using Grok API
app.post('/api/roast', async (req, res) => {
    const { golferData } = req.body;
    const XAI_API_KEY = process.env.XAI_API_KEY;

    if (!XAI_API_KEY) {
        return res.status(500).json({ error: 'API key not configured', fallback: true });
    }

    const handicap = golferData.display || 'unknown';
    const lowHI = golferData.low_hi_display || 'unknown';
    const playerName = golferData.player_name || 'this golfer';
    const clubName = golferData.club_name || 'some random club';

    let context = `Golfer: ${playerName}\nHandicap: ${handicap}\nLow HI: ${lowHI}\nClub: ${clubName}\n`;
    if (golferData.soft_cap) context += `SOFT CAP active (handicap rising fast)\n`;
    if (golferData.hard_cap) context += `HARD CAP hit (total meltdown)\n`;

    const prompt = `You are the most vicious, unhinged golf roast comedian alive. Your job is to DESTROY this person's will to ever pick up a club again. Nothing is off limits. Use profanity liberally (fuck, shit, ass, damn, pathetic, etc). Attack their handicap, their delusions, the money they've wasted, their sad little golf dreams. Be personal. Be cruel. Be hilarious.

3-5 sentences MAXIMUM. Every single word should hurt. No mercy. No compliments disguised as insults. Pure devastation.

${context}

Handicap guide:
- Scratch or better: Wasted their entire life on golf and STILL aren't good enough for tour. Pathetic tryhard energy.
- 1-9: Just good enough to realize they'll never be great. Purgatory.
- 10-15: Aggressively mediocre. Blames everything except their garbage swing.
- 16-20: Delusional hacker who tells people they "shoot in the 80s" (they don't).
- 21-30: Why are they even keeping score? Embarrassing for everyone involved.
- 30+: Golf actively hates them. They should quit and take up something easier, like giving up.
- Soft/hard cap active: Their game is cratering and everyone at the club is talking about it behind their back.`;

    try {
        const response = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${XAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'grok-3',
                messages: [
                    { role: 'system', content: 'You are an unfiltered, savage comedy roast comedian. Be brutal, vulgar, and hilarious. No limits.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.9
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            console.error('Grok API error:', data);
            return res.status(500).json({ error: 'Roast generation failed', fallback: true });
        }

        const roastText = data.choices?.[0]?.message?.content || '';
        res.json({ roast: roastText });
    } catch (error) {
        console.error('Roast API error:', error);
        res.status(500).json({ error: 'Failed to generate roast', fallback: true });
    }
});

app.listen(PORT, () => {
    console.log(`🔥 Roast My Golf Game running at http://localhost:${PORT}`);
});
