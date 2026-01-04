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
    let context = `Golfer's first name: ${firstName}\nFull name: ${playerName}\nCurrent Handicap Index: ${handicap}\nLowest Handicap Index ever: ${lowHI}\nHome Club: ${clubName}\n`;
    
    if (golferData.soft_cap) context += `⚠️ SOFT CAP is active - their handicap is rising fast, they're getting WORSE\n`;
    if (golferData.hard_cap) context += `🚨 HARD CAP hit - complete meltdown, game in free fall\n`;

    // Add score history analysis if available
    if (scores.length > 0) {
        context += `\n=== RECENT SCORE HISTORY (USE THIS FOR PERSONALIZED ROASTING) ===\n`;
        
        const recentScores = scores.slice(0, 8);
        let worstRound = { diff: 0 };
        let worstHoleEver = null;

        recentScores.forEach((score) => {
            const courseName = score.facility_name || score.course_name || 'Unknown Course';
            const adjustedScore = score.adjusted_gross_score;
            const differential = parseFloat(score.differential) || 0;
            const datePlayed = score.played_at || '';
            const formattedDate = datePlayed ? new Date(datePlayed).toLocaleDateString() : 'recent';
            
            let holeInfo = '';
            if (score.worst_hole && score.worst_hole.over >= 3) {
                holeInfo = ` — DISASTER: +${score.worst_hole.over} on hole ${score.worst_hole.hole_number} (par ${score.worst_hole.par}, shot ${score.worst_hole.score})`;
                
                // Track worst hole across all rounds
                if (!worstHoleEver || score.worst_hole.over > worstHoleEver.over) {
                    worstHoleEver = { ...score.worst_hole, course: courseName, date: formattedDate };
                }
            }
            
            context += `• Shot ${adjustedScore} at ${courseName} (diff: ${differential.toFixed(1)}) on ${formattedDate}${holeInfo}\n`;
            
            if (differential > worstRound.diff) {
                worstRound = { score: adjustedScore, course: courseName, diff: differential, date: formattedDate };
            }
        });

        if (worstRound.course) {
            context += `\n🎯 WORST RECENT ROUND: Shot ${worstRound.score} at ${worstRound.course} with a ${worstRound.diff.toFixed(1)} differential - ROAST THIS!\n`;
        }
        
        if (worstHoleEver) {
            context += `💀 WORST HOLE: Made a +${worstHoleEver.over} (${worstHoleEver.score} on a par ${worstHoleEver.par}) on hole ${worstHoleEver.hole_number} at ${worstHoleEver.course} - DESTROY THEM FOR THIS!\n`;
        }
        
        const avgDiff = recentScores.reduce((sum, s) => sum + (parseFloat(s.differential) || 0), 0) / recentScores.length;
        const handicapNum = parseFloat(handicap) || 0;
        if (avgDiff > handicapNum + 2) {
            context += `📉 TREND: Recent avg differential (${avgDiff.toFixed(1)}) is worse than handicap (${handicap}) - SPIRALING!\n`;
        }
    } else {
        context += `\n(No recent score history available - roast based on handicap and club)\n`;
    }

    console.log('Context being sent to Grok:\n', context);

    const prompt = `You are the most savage, foul-mouthed golf roast comedian. Your job is to DESTROY ${firstName}. Use profanity freely (fuck, shit, damn, ass). Be mean, personal, and hilarious.

=== GOLFER DATA ===
${context}

=== INSTRUCTIONS ===
- If there's score history, YOU MUST reference specific rounds, courses, and scores
- Call out their worst round by name: "You shot a [score] at [course]? Jesus Christ..."
- Mock the gap between their low handicap and current state if relevant
- Be SPECIFIC, not generic
- 3-5 sentences MAXIMUM
- End with something brutal about their future in golf`;

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
                    { role: 'system', content: 'You are an absolutely unhinged, vulgar roast comedian who specializes in destroying amateur golfers. Reference specific data when provided. No mercy. No limits.' },
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
