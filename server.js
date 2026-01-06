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

// Service account credentials (your GHIN) - used for public lookups
const SERVICE_GHIN = process.env.SERVICE_GHIN;
const SERVICE_PASSWORD = process.env.SERVICE_PASSWORD;
let serviceToken = null;
let serviceTokenExpiry = 0;

// Get or refresh service token
async function getServiceToken() {
    if (serviceToken && Date.now() < serviceTokenExpiry) {
        return serviceToken;
    }
    
    if (!SERVICE_GHIN || !SERVICE_PASSWORD) {
        console.error('Service account credentials not configured');
        return null;
    }
    
    try {
        const response = await fetch('https://api.ghin.com/api/v1/golfer_login.json', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user: {
                    email_or_ghin: SERVICE_GHIN,
                    password: SERVICE_PASSWORD,
                    remember_me: 'true'
                },
                token: 'roastmygolfgame'
            })
        });
        
        const data = await response.json();
        if (data.golfer_user?.golfer_user_token) {
            serviceToken = data.golfer_user.golfer_user_token;
            serviceTokenExpiry = Date.now() + (60 * 60 * 1000); // 1 hour
            console.log('Service token refreshed');
            return serviceToken;
        }
    } catch (err) {
        console.error('Failed to get service token:', err.message);
    }
    return null;
}

// PUBLIC LOOKUP - search by name or GHIN number (no password needed)
app.post('/api/lookup', async (req, res) => {
    const query = sanitizeInput(req.body.query, 50);
    
    if (!query || query.length < 2) {
        return res.status(400).json({ error: 'Search query too short' });
    }
    
    const token = await getServiceToken();
    if (!token) {
        return res.status(500).json({ error: 'Lookup service unavailable' });
    }
    
    console.log('=== LOOKUP REQUEST ===');
    console.log('Query:', query);
    
    try {
        // Check if query is a GHIN number (all digits)
        const isGhinNumber = /^\d+$/.test(query);
        
        let golfer = null;
        let scores = [];
        
        if (isGhinNumber) {
            // Direct GHIN lookup using search endpoint
            const url = `https://api.ghin.com/api/v1/golfers/search.json?per_page=1&page=1&golfer_id=${query}&status=Active`;
            console.log('GHIN lookup URL:', url);
            
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            });
            
            console.log('Response status:', response.status);
            
            if (response.ok) {
                const data = await response.json();
                console.log('Response keys:', Object.keys(data));
                const golfers = data.golfers || [];
                if (golfers.length > 0) {
                    golfer = golfers[0];
                    console.log('Found golfer:', golfer.player_name);
                }
            }
        } else {
            // Name search
            const url = `https://api.ghin.com/api/v1/golfers/search.json?per_page=10&page=1&last_name=${encodeURIComponent(query)}&status=Active`;
            console.log('Name search URL:', url);
            
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            });
            
            console.log('Response status:', response.status);
        
            if (response.ok) {
                const data = await response.json();
                const golfers = data.golfers || [];
                console.log('Golfers found:', golfers.length);
                
                if (golfers.length > 0) {
                    // Return list for user to pick
                    return res.json({ 
                        results: golfers.slice(0, 10).map(g => ({
                            ghin: g.ghin || g.ghin_number,
                            name: g.player_name || `${g.first_name || ''} ${g.last_name || ''}`.trim(),
                            club: g.club_name,
                            handicap: g.handicap_index,
                            city: g.city,
                            state: g.state
                        }))
                    });
                }
            }
            
            return res.status(404).json({ error: 'No golfers found' });
        }
        
        if (!golfer) {
            return res.status(404).json({ error: 'Golfer not found' });
        }
        
        const ghinNumber = golfer.ghin || golfer.ghin_number || query;
        
        // Try to fetch scores using correct endpoint
        try {
            const today = new Date().toISOString().split('T')[0];
            const lastYear = new Date(Date.now() - 365*24*60*60*1000).toISOString().split('T')[0];
            const scoresUrl = `https://api.ghin.com/api/v1/scores/search.json?per_page=20&page=1&golfer_id=${ghinNumber}&from_date_played=${lastYear}&to_date_played=${today}`;
            console.log('Scores URL:', scoresUrl);
            
            const scoresResponse = await fetch(scoresUrl, {
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            });
            
            console.log('Scores response status:', scoresResponse.status);
            
            if (scoresResponse.ok) {
                const scoresData = await scoresResponse.json();
                scores = scoresData.Scores || scoresData.scores || [];
                console.log('Scores found:', scores.length);
            }
        } catch (scoreErr) {
            console.log('Could not fetch scores for public lookup:', scoreErr.message);
        }
        
        // Trim scores
        const trimmedScores = scores.filter(s => s.number_of_holes === 18).slice(0, 20).map(s => ({
            facility_name: s.facility_name || s.course_name,
            adjusted_gross_score: s.adjusted_gross_score,
            differential: s.differential,
            played_at: s.played_at,
            number_of_holes: s.number_of_holes,
            worst_hole: s.hole_details ? findWorstHole(s.hole_details) : null
        }));
        
        res.json({
            ghin_number: golfer.ghin || golfer.ghin_number,
            player_name: golfer.player_name || `${golfer.first_name} ${golfer.last_name}`,
            club_name: golfer.club_name,
            display: golfer.handicap_index,
            low_hi_display: golfer.low_hi,
            soft_cap: golfer.soft_cap,
            hard_cap: golfer.hard_cap,
            recent_scores: trimmedScores,
            lookup_mode: true
        });
        
    } catch (error) {
        console.error('Lookup error:', error);
        res.status(500).json({ error: 'Lookup failed' });
    }
});

// GHIN Login endpoint - returns golfer data + token for subsequent requests (full access)
app.post('/api/ghin', async (req, res) => {
    const email_or_ghin = sanitizeInput(req.body.email_or_ghin, 50);
    const password = req.body.password; // Don't truncate password, but validate type
    
    // Input validation
    if (!email_or_ghin || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'Invalid input' });
    }

    try {
        const response = await fetch('https://api.ghin.com/api/v1/golfer_login.json', {
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
        const ghinNumber = golfer.ghin || golfer.ghin_number;

        console.log('GHIN Login successful for:', golfer.player_name);
        console.log('Token received:', token ? 'Yes' : 'No');
        console.log('GHIN Number:', ghinNumber);

        // Fetch recent scores if we have a token
        let scores = [];
        if (token && ghinNumber) {
            const today = new Date().toISOString().split('T')[0];
            const lastYear = new Date(Date.now() - 365*24*60*60*1000).toISOString().split('T')[0];
            const scoresUrl = `https://api.ghin.com/api/v1/scores/search.json?per_page=50&page=1&golfer_id=${ghinNumber}&from_date_played=${lastYear}&to_date_played=${today}`;

            try {
                console.log('Trying scores URL:', scoresUrl);
                const scoresResponse = await fetch(scoresUrl, {
                    headers: {
                        'Accept': 'application/json',
                        'Authorization': `Bearer ${token}`
                    }
                });
                
                console.log('Scores response status:', scoresResponse.status);
                
                if (scoresResponse.ok) {
                    const scoresData = await scoresResponse.json();
                    console.log('Scores data keys:', Object.keys(scoresData));
                    scores = scoresData.Scores || scoresData.scores || [];
                    console.log('Scores found:', scores.length);
                }
            } catch (scoreErr) {
                console.error('Error fetching scores:', scoreErr.message);
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

    // === LAYERED RANDOMIZATION ===
    
    // Layer 1: Voice/Persona (WHO is delivering the roast)
    const voices = [
        'a disappointed caddie who\'s seen too much and is tired of carrying bags for hackers',
        'a sarcastic golf commentator caught on a hot mic',
        'their golf clubs writing a collective resignation letter',
        'a brutally honest swing coach who just watched their lesson video',
        'a country club bartender who\'s heard all their excuses for 10 years',
        'a golf cart that has witnessed every shanked shot',
        'their playing partners talking behind their back at the 19th hole',
        'a pro shop employee who has to keep a straight face',
        'the course marshal who\'s been watching them all day',
        'a sports psychologist who just gave up on them',
        'a local golf journalist writing their obituary... for their golf career',
        'someone reading their stats at a roast dinner',
    ];
    
    // Layer 2: Angle (WHAT to focus on)
    const angles = [
        'their club membership and paying dues just to embarrass themselves',
        'the gap between their low handicap and current state - they peaked and fell off hard',
        'one specific hole disaster - make it vivid and painful',
        'their worst round - paint a picture of that miserable day',
        'what their handicap number says about them as a human being',
        'their wild inconsistency - the emotional rollercoaster of their game',
        'how long they\'ve probably played vs how bad they still are',
        'the money they\'ve wasted on equipment that can\'t fix their swing',
        'their delusion - they definitely think they\'re better than this',
        'comparing them to a specific embarrassing thing (a 3-putt, a skulled chip, etc)',
        'their practice habits (or lack thereof)',
        'the excuses they probably make after every bad shot',
    ];
    
    // Layer 3: Format (HOW to structure the roast)
    const formats = [
        'One long devastating sentence that just keeps twisting the knife.',
        'Two short punches. Jab, jab. Done.',
        'Start with a genuine compliment, then pull the rug out violently.',
        'A rhetorical question that painfully answers itself.',
        'Deadpan factual delivery. No jokes. Just stating painful truths.',
        'Build them up for two sentences, then destroy them in the last few words.',
        'Compare their golf game to something absurd and unexpected.',
        'Speak directly to them like you\'re giving them bad news at the doctor.',
        'A fake golf commentary call of their typical shot.',
        'Start mid-thought like you\'ve been ranting about them for a while.',
    ];
    
    // Layer 4: Wild cards (random modifiers to prevent patterns)
    const wildcards = [
        'Use exactly one very specific number or stat to make it sting.',
        'Mention a specific club (driver, putter, 7-iron) in your roast.',
        'Reference the weather or course conditions sarcastically.',
        'Include a fake quote from someone who watched them play.',
        'Mention something they probably do on the first tee.',
        'Reference their pre-shot routine or lack thereof.',
        'Compare them to a specific famous bad golf moment.',
        'Mention what their playing partners are probably thinking.',
        '', // Sometimes no wildcard
        '', // Weighted toward no wildcard
        '',
    ];

    // Select random elements
    const voice = voices[Math.floor(Math.random() * voices.length)];
    const angle = angles[Math.floor(Math.random() * angles.length)];
    const format = formats[Math.floor(Math.random() * formats.length)];
    const wildcard = wildcards[Math.floor(Math.random() * wildcards.length)];

    console.log('Voice:', voice);
    console.log('Angle:', angle);
    console.log('Format:', format);
    console.log('Wildcard:', wildcard || '(none)');

    // Build dynamic system message with voice
    const lightSystemMsg = `You are ${voice}. You give witty roasts about amateur golfers. Clever wordplay, gentle ribbing - like teasing a friend. Keep it to 2-3 sentences.`;
    
    const savageSystemMsg = `You are ${voice}. You deliver brutal, unhinged roasts of amateur golfers. Dark humor, creative insults, no mercy. Use profanity (shit, ass, fuck) but don't force it. 2-3 sentences max.`;

    // Build dynamic prompt
    const lightPrompt = `Roast this golfer:

${context}

FOCUS ON: ${angle}
DELIVERY STYLE: ${format}
${wildcard ? `INCLUDE: ${wildcard}` : ''}

Keep it playful and clever. 2-3 sentences.`;

    const savagePrompt = `Destroy this golfer:

${context}

FOCUS ON: ${angle}
DELIVERY STYLE: ${format}
${wildcard ? `INCLUDE: ${wildcard}` : ''}

Be creative and surprising. Vary your rhythm. No formulaic setups. When mentioning bad scores, use golf terms (triple bogey, snowman, etc). 2-3 sentences that hurt.`;

    const prompt = isSavage ? savagePrompt : lightPrompt;
    const systemMsg = isSavage ? savageSystemMsg : lightSystemMsg;

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
                temperature: isSavage ? 1.5 : 1.0
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
