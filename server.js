const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// === SECURITY & RATE LIMITING ===

// Simple in-memory rate limiter
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute per IP

function rateLimit(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown';
    const now = Date.now();
    
    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return next();
    }
    
    const record = rateLimitMap.get(ip);
    
    if (now > record.resetTime) {
        record.count = 1;
        record.resetTime = now + RATE_LIMIT_WINDOW;
        return next();
    }
    
    if (record.count >= RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    }
    
    record.count++;
    next();
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitMap.entries()) {
        if (now > record.resetTime) {
            rateLimitMap.delete(ip);
        }
    }
}, 5 * 60 * 1000);

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use(cors());
app.use(express.json({ limit: '1mb' })); // Reduced from 10mb
app.use(express.static('public'));

// Apply rate limiting to API routes only
app.use('/api', rateLimit);

// Input validation helper
function sanitizeInput(str, maxLength = 100) {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, maxLength);
}

// GHIN Login endpoint - returns golfer data + token for subsequent requests
app.post('/api/ghin', async (req, res) => {
    const email_or_ghin = sanitizeInput(req.body.email_or_ghin, 50);
    const password = req.body.password; // Don't truncate password, but validate type
    
    // Input validation
    if (!email_or_ghin || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'Invalid input' });
    }

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

        const golfer = data.golfer_user.golfers[0];
        const token = data.golfer_user.golfer_user_token;
        const ghinNumber = golfer.ghin_number;

        console.log('GHIN Login successful for:', golfer.player_name);
        console.log('Token received:', token ? 'Yes' : 'No');
        console.log('GHIN Number:', ghinNumber);

        // Fetch recent scores if we have a token
        let scores = [];
        if (token && ghinNumber) {
            // Try the scores endpoint
            const scoresUrls = [
                `https://api2.ghin.com/api/v1/golfers/${ghinNumber}/scores.json`,
                `https://api2.ghin.com/api/v1/scores.json?golfer_id=${ghinNumber}`,
            ];

            for (const url of scoresUrls) {
                try {
                    console.log('Trying scores URL:', url);
                    const scoresResponse = await fetch(url, {
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        }
                    });
                    
                    console.log('Scores response status:', scoresResponse.status);
                    
                    if (scoresResponse.ok) {
                        const scoresData = await scoresResponse.json();
                        console.log('Scores data keys:', Object.keys(scoresData));
                        scores = scoresData.scores || scoresData.score_list || [];
                        console.log('Scores found:', scores.length);
                        if (scores.length > 0) {
                            console.log('Sample score:', JSON.stringify(scores[0], null, 2));
                            break;
                        }
                    }
                } catch (scoreErr) {
                    console.error('Error fetching scores from', url, ':', scoreErr.message);
                }
            }
        }

        // Also check if scores are embedded in the golfer object
        if (scores.length === 0 && golfer.recent_scores) {
            scores = golfer.recent_scores;
            console.log('Found scores in golfer object:', scores.length);
        }

        // Trim scores to only essential fields (hole_details makes payload huge)
        const trimmedScores = scores.slice(0, 20).map(s => ({
            facility_name: s.facility_name || s.course_name,
            course_name: s.course_name || s.facility_name,
            adjusted_gross_score: s.adjusted_gross_score,
            differential: s.differential,
            played_at: s.played_at,
            tee_name: s.tee_name,
            course_rating: s.course_rating,
            slope_rating: s.slope_rating,
            number_of_holes: s.number_of_holes,
            // Find worst holes for roasting
            worst_hole: s.hole_details ? findWorstHole(s.hole_details) : null
        }));

        console.log('Sending trimmed scores:', trimmedScores.length);

        res.json({ ...golfer, recent_scores: trimmedScores });
    } catch (error) {
        console.error('GHIN API error:', error);
        res.status(500).json({ error: 'Failed to connect to GHIN' });
    }
});

// Helper to find the worst hole in a round
function findWorstHole(holeDetails) {
    if (!holeDetails || !holeDetails.length) return null;
    
    let worst = null;
    let worstOver = 0;
    
    holeDetails.forEach(hole => {
        const overPar = (hole.raw_score || hole.adjusted_gross_score) - hole.par;
        if (overPar > worstOver) {
            worstOver = overPar;
            worst = {
                hole_number: hole.hole_number,
                score: hole.raw_score || hole.adjusted_gross_score,
                par: hole.par,
                over: overPar
            };
        }
    });
    
    return worst;
}

// Roast generation endpoint - using Grok API
app.post('/api/roast', async (req, res) => {
    const { golferData, intensity = 'light' } = req.body;
    const XAI_API_KEY = process.env.XAI_API_KEY;

    if (!XAI_API_KEY) {
        return res.status(500).json({ error: 'API key not configured', fallback: true });
    }

    const handicap = golferData.display || 'unknown';
    const lowHI = golferData.low_hi_display || 'unknown';
    const playerName = golferData.player_name || 'this golfer';
    const clubName = golferData.club_name || 'some random club';
    const scores = golferData.recent_scores || [];
    const firstName = playerName.split(' ')[0];
    const isSavage = intensity === 'savage';

    console.log('=== ROAST REQUEST ===');
    console.log('Player:', playerName);
    console.log('Handicap:', handicap);
    console.log('Intensity:', intensity);
    console.log('Scores available:', scores.length);

    // Build context with basic info
    let context = `${firstName} | Handicap: ${handicap} | Low: ${lowHI} | Club: ${clubName}`;
    
    if (golferData.soft_cap) context += ` | ⚠️ SOFT CAP (getting worse)`;
    if (golferData.hard_cap) context += ` | 🚨 HARD CAP (total collapse)`;

    // Add score highlights if available
    if (scores.length > 0) {
        const recentScores = scores.filter(s => s.number_of_holes === 18).slice(0, 10);
        let worstRound = { score: 0 };
        let bestRound = { score: 999 };
        let worstHole = null;

        recentScores.forEach((score) => {
            const courseName = score.facility_name || score.course_name || 'Unknown';
            const rawScore = parseInt(score.adjusted_gross_score) || 0;
            const differential = parseFloat(score.differential) || 0;
            
            if (rawScore > worstRound.score) {
                worstRound = { score: rawScore, course: courseName, diff: differential };
            }
            
            if (rawScore > 0 && rawScore < bestRound.score) {
                bestRound = { score: rawScore, course: courseName, diff: differential };
            }
            
            if (score.worst_hole && score.worst_hole.over >= 3) {
                if (!worstHole || score.worst_hole.over > worstHole.over) {
                    worstHole = { ...score.worst_hole, course: courseName };
                }
            }
        });

        if (worstRound.score > 0) {
            context += `\nWorst recent round: Shot ${worstRound.score} at ${worstRound.course}`;
        }
        
        if (bestRound.score < 999) {
            context += `\nBest recent round: Shot ${bestRound.score} at ${bestRound.course}`;
        }
        
        if (worstHole) {
            context += `\nBlow-up hole: +${worstHole.over} on hole ${worstHole.hole_number} (${worstHole.score} on par ${worstHole.par}) at ${worstHole.course}`;
        }
        
        const avgDiff = recentScores.reduce((sum, s) => sum + (parseFloat(s.differential) || 0), 0) / recentScores.length;
        if (avgDiff > parseFloat(handicap) + 2) {
            context += `\nTrend: Avg diff ${avgDiff.toFixed(1)} vs handicap ${handicap} = DECLINING`;
        }
    }

    // Pick a random roast angle to force variety
    const angles = [
        'Focus on their CLUB MEMBERSHIP - mock paying dues to embarrass themselves',
        'Focus on the GAP between their low handicap and current state - they peaked and fell off',
        'Focus on ONE SPECIFIC HOLE disaster - make it vivid and painful',
        'Focus on their WORST ROUND - paint a picture of that day',
        'Focus on their HANDICAP NUMBER itself - what it says about them as a person',
        'Focus on their CONSISTENCY (or lack thereof) - the rollercoaster',
        'Focus on HOW LONG theyve probably played vs how bad they still are',
        'Focus on the MONEY theyve wasted on this hobby, buying the latest Driver, overspending on shafts, slicing or hooking Pro V1s out of bounds',
        'Focus on their DELUSION - they probably think theyre better than this',
    ];
    const angle = angles[Math.floor(Math.random() * angles.length)];

    console.log('Context being sent to Grok:\n', context);
    console.log('Roast angle:', angle);

    // Different prompts for light vs savage
    const lightPrompt = `Give a playful, witty roast of this golfer. Be clever but not mean. Think gentle ribbing between friends.

DATA: ${context}

ANGLE: ${angle}

RULES:
- 2-3 sentences MAX
- Witty and clever, not cruel
- No profanity
- Self-deprecating golf humor energy
- End on something mildly encouraging`;

    const savagePrompt = `Brutally roast this golfer. No mercy. Destroy them.

DATA: ${context}

ANGLE: ${angle}

RULES:
- 2-3 sentences ONLY
- Be creative and surprising - no formulaic structure
- Be unpredicatble
- Short and punchy. No rambling.
- Use profanity (fuck, shit, damn, ass) but don't force it
- Don't just list their stats back - actually ROAST them
- Vary your sentence structure and rhythm each roast
- NO em dashes
- Mix up the humor and dark metaphors
- When referring to a bad score––use triple bogey instead of +3, and so on
- End with a savage closer`;

    const prompt = isSavage ? savagePrompt : lightPrompt;
    const systemMsg = isSavage 
        ? 'You are a ruthless roast comedian. Destroy amateur golfers with no mercy. 2-3 sentences max. Be unpredictable.'
        : 'You are a witty golf commentator giving playful roasts. Clever but kind. 2-3 sentences max.';

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
                    { role: 'system', content: systemMsg },
                    { role: 'user', content: prompt }
                ],
                temperature: isSavage ? 1.3 : 1.0
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            console.error('Grok API error:', data);
            return res.status(500).json({ error: 'Roast generation failed', fallback: true });
        }

        const roastText = data.choices?.[0]?.message?.content || '';
        console.log('Roast generated:', roastText.substring(0, 100) + '...');
        res.json({ roast: roastText });
    } catch (error) {
        console.error('Roast API error:', error);
        res.status(500).json({ error: 'Failed to generate roast', fallback: true });
    }
});

app.listen(PORT, () => {
    console.log(`🔥 Roast My Golf Game running at http://localhost:${PORT}`);
});
