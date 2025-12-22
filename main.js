/*
---------------------------------------------------------
SPOTIFY -> YOUTUBE PLAYLIST CONVERTER (Production Ready)
---------------------------------------------------------
*/
const express = require('express');
const cookieSession = require('cookie-session'); // Better for serverless/Vercel
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const yts = require('yt-search');
const helmet = require('helmet'); // Security headers
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Env Variables Check
if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    console.warn('WARNING: Spotify Credentials missing.');
}
if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
    console.warn('WARNING: YouTube Credentials missing.');
}

const SESSION_SECRET = process.env.SESSION_SECRET || 'secure_production_secret_key_here';

// --- SECURITY & MIDDLEWARE ---

// Helmet helps secure Express apps by setting various HTTP headers
app.use(helmet({
    contentSecurityPolicy: false
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set('trust proxy', 1); // Required for Vercel/Heroku

// Use cookie-session instead of express-session for Serverless/Vercel compatibility
app.use(cookieSession({
    name: 'session',
    keys: [SESSION_SECRET],
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === 'production', // Secure cookies in production
    httpOnly: true,
    sameSite: 'lax'
}));

// Serves files from 'public' directory at the root level
app.use(express.static(path.join(__dirname, 'public')));

// --- HELPER FUNCTIONS ---

function generateRandomString(length) {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

async function getSpotifyAppToken() {
    const tokenUrl = 'https://accounts.spotify.com/api/token';
    const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');

    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Spotify token fetch failed: ${res.status} ${text}`);
    }
    const data = await res.json();
    return data.access_token;
}

function parseSpotifyPlaylistId(urlOrId) {
    if (!urlOrId) return null;
    const url = urlOrId.trim();
    if (url.toUpperCase() === 'LIKED') return 'LIKED';
    const spotifyUrlMatch = url.match(/playlist[/:]([a-zA-Z0-9]+)/);
    if (spotifyUrlMatch) return spotifyUrlMatch[1];
    const mockMatch = url.match(/\/(\d+)$/);
    if (mockMatch) return mockMatch[1];
    if (/^[a-zA-Z0-9]+$/.test(url)) return url;
    return null;
}

async function fetchAllSpotifyTracks(playlistId, userTokens) {
    const isLikedSongs = playlistId === 'LIKED';
    let tokenToUse;
    let url;
    
    // Determine Token and URL
    if (isLikedSongs) {
        if (!userTokens) throw new Error("Spotify sign-in required to access LIKED songs.");
        tokenToUse = userTokens.access_token;
        url = `https://api.spotify.com/v1/me/tracks?limit=50`; 
    } else if (userTokens) {
        tokenToUse = userTokens.access_token;
        url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50`;
    } else {
        tokenToUse = await getSpotifyAppToken();
        url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50`;
    }

    const headers = { Authorization: `Bearer ${tokenToUse}` };
    let tracks = [];
    let nextUrl = url;
    
    // SAFETY LIMIT: Vercel functions time out after 10s (Hobby) or 60s (Pro).
    // Processing more than 50 songs usually causes a timeout on Vercel.
    let pages = 0;
    const MAX_PAGES = 2; // Limit to 50 songs on Vercel to prevent crashing.

    while (nextUrl && pages < MAX_PAGES) {
        const res = await fetch(nextUrl, { headers });
        
        // Handle Token Expiry Retry logic here if needed...
        
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Failed fetching Spotify tracks: ${res.status} ${txt}`);
        }
        
        const data = await res.json();
        const items = data.items;
        
        for (const item of items) {
            if (!item.track) continue;
            tracks.push({
                name: item.track.name,
                artists: item.track.artists.map(a => a.name),
                duration_ms: item.track.duration_ms,
                uri: item.track.uri
            });
        }
        nextUrl = data.next;
        pages++;
    }
    return tracks;
}

function buildYouTubeQuery(track) {
    const artist = track.artists && track.artists.length ? track.artists[0] : '';
    let q = `${track.name} ${artist} official audio`; // Added "official audio" for better results
    q = q.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
    return q;
}

// Uses yt-search. Note: Heavy scraping often gets blocked by Vercel's shared IPs.
async function searchYouTubeMostViewed(query) {
    try {
        const timeout = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Search timed out')), 5000)
        );
        const r = await Promise.race([ yts(query), timeout ]);
        
        if (r && r.videos && r.videos.length > 0) {
            return r.videos[0].videoId;
        }
        return null;
    } catch (err) {
        console.error(`Search error for "${query}": ${err.message}`);
        return null;
    }
}

async function createYouTubePlaylistAndAddVideos(oauth2Client, title, description, videoIds, existingPlaylistId) {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    let playlistId = existingPlaylistId;

    if (!playlistId) {
        try {
            const insertRes = await youtube.playlists.insert({
                part: ['snippet', 'status'],
                requestBody: {
                    snippet: {
                        title: title.substring(0, 100),
                        description: description.substring(0, 5000),
                        defaultLanguage: 'en'
                    },
                    status: { privacyStatus: 'private' }
                }
            });
            playlistId = insertRes.data.id;
        } catch (error) {
            throw new Error(`Playlist creation failed: ${error.message}`);
        }
    }

    const results = { added: [], failed: [] };

    for (const vid of videoIds) {
        if (!vid) continue;
        try {
            await youtube.playlistItems.insert({
                part: ['snippet'],
                requestBody: {
                    snippet: {
                        playlistId,
                        resourceId: { kind: 'youtube#video', videoId: vid }
                    }
                }
            });
            results.added.push(vid);
        } catch (err) {
            // Check for duplicate (409) or permission (403)
            results.failed.push({ videoId: vid, reason: err.message });
        }
        // Short delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500)); 
    }

    return { playlistId, results };
}

function makeOAuth2Client() {
    return new google.auth.OAuth2(
        process.env.YOUTUBE_CLIENT_ID,
        process.env.YOUTUBE_CLIENT_SECRET,
        process.env.YOUTUBE_REDIRECT_URI
    );
}

// --- AUTH ROUTES ---

app.get('/auth/profiles', async (req, res) => {
    let profiles = { spotify: null, youtube: null };

    if (req.session.spotifyTokens) {
        const sRes = await fetch('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${req.session.spotifyTokens.access_token}` }
        });
        if (sRes.ok) {
            const sData = await sRes.json();
            profiles.spotify = { name: sData.display_name, image: sData.images[0]?.url };
        }
    }

    if (req.session.googleTokens) {
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials(req.session.googleTokens);
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        try {
            const yRes = await youtube.channels.list({ part: 'snippet', mine: true });
            const chan = yRes.data.items[0].snippet;
            profiles.youtube = { name: chan.title, image: chan.thumbnails.default.url };
        } catch (e) {}
    }
    res.json(profiles);
});

app.get('/auth/spotify', (req, res) => {
    const state = generateRandomString(16);
    req.session.spotifyState = state;
    const scopes = 'playlist-read-private user-library-read';
    const authUrl = 'https://accounts.spotify.com/authorize?' + 
        new URLSearchParams({
            response_type: 'code',
            client_id: process.env.SPOTIFY_CLIENT_ID,
            scope: scopes,
            redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
            state: state
        }).toString();
    res.redirect(authUrl);
});

app.get('/spotify/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!state || state !== req.session.spotifyState) {
        return res.status(400).send('State mismatch error.');
    }

    try {
        const tokenUrl = 'https://accounts.spotify.com/api/token';
        const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
        const resToken = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `grant_type=authorization_code&code=${code}&redirect_uri=${process.env.SPOTIFY_REDIRECT_URI}`
        });

        if (!resToken.ok) throw new Error('Spotify Token Exchange Failed');
        const data = await resToken.json();
        
        req.session.spotifyTokens = data;
        res.send('<script>window.close();</script>');
    } catch (err) {
        console.error(err);
        res.status(500).send('Spotify Auth Failed');
    }
});

app.get('/auth/spotify/status', (req, res) => {
    res.json({ signedIn: !!req.session.spotifyTokens });
});

app.get('/auth/youtube', (req, res) => {
    const oauth2Client = makeOAuth2Client();
    const scopes = ['https://www.googleapis.com/auth/youtube'];
    const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });
    res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    const oauth2Client = makeOAuth2Client();
    try {
        const { tokens } = await oauth2Client.getToken(code);
        req.session.googleTokens = tokens;
        res.send('<script>window.close();</script>');
    } catch (err) {
        res.status(500).send('Google Auth Failed');
    }
});

app.get('/auth/status', (req, res) => {
    res.json({ signedIn: !!req.session.googleTokens });
});

// --- CONVERSION ROUTE ---

app.post('/convert', async (req, res) => {
    const { playlistUrl, existingPlaylistId } = req.body;
    const userTokens = req.session.spotifyTokens;
    const googleTokens = req.session.googleTokens;

    if (!googleTokens) return res.status(401).json({ error: 'YouTube Login Required' });

    try {
        const playlistId = parseSpotifyPlaylistId(playlistUrl);
        let tokenToUse = userTokens ? userTokens.access_token : await getSpotifyAppToken();
        
        // 1. Get Spotify Playlist Name
        let spotifyTitle = "Converted Playlist";
        if (playlistId !== 'LIKED') {
            const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${tokenToUse}` }
            });
            const metaData = await metaRes.json();
            spotifyTitle = metaData.name || spotifyTitle;
        } else {
            spotifyTitle = "My Spotify Liked Songs";
        }

        // 2. Fetch Tracks
        const tracks = await fetchAllSpotifyTracks(playlistId, userTokens);
        
        // 3. Search & Add
        const oauth2Client = new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET, process.env.YOUTUBE_REDIRECT_URI);
        oauth2Client.setCredentials(googleTokens);
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

        let ytPlaylistId = existingPlaylistId;
        if (!ytPlaylistId) {
            const createP = await youtube.playlists.insert({
                part: ['snippet', 'status'],
                requestBody: {
                    snippet: { title: spotifyTitle },
                    status: { privacyStatus: 'private' }
                }
            });
            ytPlaylistId = createP.data.id;
        }

        const report = { success: [], failed: [] };

        for (const track of tracks) {
            const query = `${track.name} ${track.artists[0]}`;
            const videoId = await searchYouTubeMostViewed(query);
            
            if (videoId) {
                try {
                    await youtube.playlistItems.insert({
                        part: ['snippet'],
                        requestBody: {
                            snippet: { playlistId: ytPlaylistId, resourceId: { kind: 'youtube#video', videoId } }
                        }
                    });
                    report.success.push(`${track.name} - ${track.artists[0]}`);
                } catch (e) {
                    report.failed.push(`${track.name} (YouTube Error)`);
                }
            } else {
                report.failed.push(`${track.name} (Not found on YT)`);
            }
            await new Promise(r => setTimeout(r, 600)); // Delay to prevent rate limits
        }

        res.json({ 
            youtubePlaylistUrl: `https://www.youtube.com/playlist?list=${ytPlaylistId}`,
            report 
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- FRONTEND ---
app.get('/', (req, res) => {
    res.send(`<!doctype html>
<html>
<head>
    <link rel="icon" href="/favicon.ico" type="image/x-icon">
    <title>Convertify</title>
    <style>
        body { font-family: 'Inter', sans-serif; background: #121212; color: white; display: flex; justify-content: center; padding: 40px; }
        .card { width: 100%; max-width: 600px; background: #1e1e1e; padding: 30px; border-radius: 12px; }
        .user-badge { display: flex; align-items: center; background: #2a2a2a; padding: 8px; border-radius: 20px; margin-bottom: 10px; font-size: 13px; }
        .user-badge img { width: 24px; height: 24px; border-radius: 50%; margin-right: 10px; }
        input { width: 100%; padding: 12px; margin: 10px 0; background: #2c2c2c; border: 1px solid #444; color: white; border-radius: 6px; }
        button { width: 100%; padding: 12px; border-radius: 6px; border: none; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .btn-convert { background: #1DB954; color: white; margin-top: 10px; }
        .log-box { background: #000; padding: 15px; border-radius: 8px; font-family: monospace; font-size: 12px; height: 200px; overflow-y: auto; margin-top: 20px; border: 1px solid #333; }
        .green { color: #1DB954; } .red { color: #ff4444; }
    </style>
</head>
<body>
    <div class="card">
        <h2>Spotify ➔ YouTube</h2>
        
        <div id="profiles">
            <div id="sp_profile" class="user-badge" style="display:none"></div>
            <div id="yt_profile" class="user-badge" style="display:none"></div>
        </div>

        <button id="btn_sp" style="background:#1DB954; color:white; margin-bottom:10px;">Login Spotify</button>
        <button id="btn_yt" style="background:#ff0000; color:white;">Login YouTube</button>

        <hr style="border:0; border-top:1px solid #333; margin:20px 0;">

        <input id="playlistUrl" placeholder="Spotify Playlist URL or 'LIKED'">
        <input id="existingId" placeholder="Existing YouTube Playlist ID (Optional)">
        <button id="convert" class="btn-convert">Start Conversion</button>

        <div id="status" style="margin-top:15px; text-align:center;"></div>
        <div class="log-box" id="log">Logs: Ready.</div>
    </div>

<script>
    async function refreshProfiles() {
        const res = await fetch('/auth/profiles');
        const data = await res.json();
        if(data.spotify) {
            document.getElementById('btn_sp').style.display = 'none';
            document.getElementById('sp_profile').style.display = 'flex';
            document.getElementById('sp_profile').innerHTML = \`<img src="\${data.spotify.image || ''}"> Connected: \${data.spotify.name}\`;
        }
        if(data.youtube) {
            document.getElementById('btn_yt').style.display = 'none';
            document.getElementById('yt_profile').style.display = 'flex';
            document.getElementById('yt_profile').innerHTML = \`<img src="\${data.youtube.image || ''}"> Connected: \${data.youtube.name}\`;
        }
    }
    refreshProfiles();

    document.getElementById('btn_sp').onclick = () => { window.open('/auth/spotify'); setInterval(refreshProfiles, 3000); };
    document.getElementById('btn_yt').onclick = () => { window.open('/auth/youtube'); setInterval(refreshProfiles, 3000); };

    document.getElementById('convert').onclick = async () => {
        const log = document.getElementById('log');
        const status = document.getElementById('status');
        log.innerHTML = 'Starting...';
        status.innerText = 'Processing tracks...';

        const res = await fetch('/convert', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ 
                playlistUrl: document.getElementById('playlistUrl').value,
                existingPlaylistId: document.getElementById('existingId').value
            })
        });
        const data = await res.json();

        if(res.ok) {
            status.innerHTML = \`<a href="\${data.youtubePlaylistUrl}" target="_blank" style="color:#1DB954">Conversion Complete! View Playlist</a>\`;
            let html = '<b>SUCCESSFULLY ADDED:</b><br>';
            data.report.success.forEach(s => html += \`<span class="green">✔ \${s}</span><br>\`);
            html += '<br><b>FAILED:</b><br>';
            data.report.failed.forEach(f => html += \`<span class="red">✘ \${f}</span><br>\`);
            log.innerHTML = html;
        } else {
            status.innerHTML = \`<span class="red">Error: \${data.error}</span>\`;
        }
    };
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app; // Required for Vercel