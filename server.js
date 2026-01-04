const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3000;

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

// Roast generation endpoint
app.post('/api/roast', async (req, res) => {
    const { golferData } = req.body;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'API key not configured', fallback: true });
    }

    const handicap = golferData.display || 'unknown';
    const lowHI = golferData.low_hi_display || 'unknown';
    const playerName = golferData.player_name || 'this golfer';
    const clubName = golferData.club_name || 'some random club';

    let context = `Golfer: ${playerName}\nHandicap: ${handicap}\nLow HI: ${lowHI}\nClub: ${clubName}\n`;
    if (golferData.soft_cap) context += `SOFT CAP active (handicap rising fast)\n`;
    if (golferData.hard_cap) context += `HARD CAP hit (total meltdown)\n`;

    const prompt = `You're a ruthless, foul-mouthed golf roast comedian. Absolutely destroy this golfer. Be BRUTAL. Use profanity freely (shit, ass, damn, hell, bastard, etc). Hit below the belt. Mock their life choices, their delusions, their wasted money and time.

3-5 sentences MAX. Every sentence should sting. No warmup, no filler—just devastation.

${context}

Roast by handicap:
- Scratch or better: Tryhard who blew their life on golf and STILL isn't on tour
- 1-9: Good enough to know how bad they actually are
- 10-15: Mediocre as hell, probably blames equipment
- 16-20: Delusional weekend hacker
- 21-30: Embarrassing—why even keep score?
- 30+: Absolutely hopeless, golf owes them an apology
- Soft/hard cap: Their game is in free fall and everyone notices`;

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1000,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            console.error('Anthropic API error:', data);
            return res.status(500).json({ error: 'Roast generation failed', fallback: true });
        }

        const roastText = data.content.map(item => item.text || '').join('\n');
        res.json({ roast: roastText });
    } catch (error) {
        console.error('Roast API error:', error);
        res.status(500).json({ error: 'Failed to generate roast', fallback: true });
    }
});

app.listen(PORT, () => {
    console.log(`🔥 Roast My Golf Game running at http://localhost:${PORT}`);
});
