const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// GHIN Login endpoint - returns golfer data + token for subsequent requests
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
    const { golferData } = req.body;
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

    console.log('=== ROAST REQUEST ===');
    console.log('Player:', playerName);
    console.log('Handicap:', handicap);
    console.log('Scores available:', scores.length);

    // Build context with basic info
    let context = `${firstName} | Handicap: ${handicap} | Low: ${lowHI} | Club: ${clubName}`;
    
    if (golferData.soft_cap) context += ` | ⚠️ SOFT CAP (getting worse)`;
    if (golferData.hard_cap) context += ` | 🚨 HARD CAP (total collapse)`;

    // Add score highlights if available
    if (scores.length > 0) {
        const recentScores = scores.slice(0, 6);
        let worstRound = { diff: 0 };
        let worstHole = null;

        recentScores.forEach((score) => {
            const courseName = score.facility_name || score.course_name || 'Unknown';
            const differential = parseFloat(score.differential) || 0;
            
            if (differential > worstRound.diff) {
                worstRound = { score: score.adjusted_gross_score, course: courseName, diff: differential };
            }
            
            if (score.worst_hole && score.worst_hole.over >= 3) {
                if (!worstHole || score.worst_hole.over > worstHole.over) {
                    worstHole = { ...score.worst_hole, course: courseName };
                }
            }
        });

        if (worstRound.course) {
            context += `\nWorst round: ${worstRound.score} at ${worstRound.course} (${worstRound.diff.toFixed(1)} diff)`;
        }
        
        if (worstHole) {
            context += `\nBlow-up hole: +${worstHole.over} on hole ${worstHole.hole_number} (${worstHole.score} on par ${worstHole.par}) at ${worstHole.course}`;
        }
        
        const avgDiff = recentScores.reduce((sum, s) => sum + (parseFloat(s.differential) || 0), 0) / recentScores.length;
        if (avgDiff > parseFloat(handicap) + 2) {
            context += `\nTrend: Avg diff ${avgDiff.toFixed(1)} vs handicap ${handicap} = DECLINING`;
        }
    }

    console.log('Context being sent to Grok:\n', context);

    const prompt = `You are a brutal golf roast comedian. Destroy ${firstName} in 2-3 sentences MAX.

${context}

RULES:
- 50% handicap jokes, 50% specific score/hole callouts (if available)
- Short and punchy. No rambling.
- Use light profanity (fuck, shit, damn, ass)
- If there's a blow-up hole, OB tee shots, 3-putts, mock it specifically
- Sprinkle in something positive and funny towards the end
- Then finish with a brutal closer

DO NOT exceed 3 sentences.`;

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
                    { role: 'system', content: 'You are a vulgar, brutal roast comedian. Keep it SHORT. 2-3 sentences max.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 1.0
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
