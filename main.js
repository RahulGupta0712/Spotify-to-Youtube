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
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"], // Needed for the inline JS in your HTML
            styleSrc: ["'self'", "'unsafe-inline'"],  // Needed for the inline CSS
            imgSrc: ["'self'", "data:", "https:"],
            upgradeInsecureRequests: [],
        },
    },
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

    if (!playlistUrl) return res.status(400).json({ error: 'Missing playlistUrl' });
    const playlistId = parseSpotifyPlaylistId(playlistUrl);
    if (!playlistId) return res.status(400).json({ error: 'Invalid Playlist ID' });

    if (!req.session.googleTokens) {
        return res.status(401).json({ error: 'YouTube sign-in required' });
    }

    try {
        // 1. Fetch Spotify Tracks
        const tracks = await fetchAllSpotifyTracks(playlistId, userTokens);
        if (!tracks.length) return res.status(400).json({ error: 'No tracks found' });

        // 2. Search YouTube
        const videoIds = [];
        for (let i = 0; i < tracks.length; i++) {
            const vid = await searchYouTubeMostViewed(buildYouTubeQuery(tracks[i]));
            videoIds.push(vid);
            // VERCEL WARNING: 
            // We use a small timeout to prevent rapid-fire scraping, 
            // but this increases execution time.
            await new Promise(r => setTimeout(r, 500)); 
        }

        const validVideos = videoIds.filter(v => v !== null);

        // 3. Create/Update YouTube Playlist
        const oauth2Client = makeOAuth2Client();
        oauth2Client.setCredentials(req.session.googleTokens);

        const title = playlistId === 'LIKED' ? 'Spotify Liked Songs' : `Spotify Import: ${playlistId}`;
        const desc = `Imported on ${new Date().toISOString()}`;

        const result = await createYouTubePlaylistAndAddVideos(oauth2Client, title, desc, validVideos, existingPlaylistId);
        
        return res.json({ 
            youtubePlaylistUrl: `https://www.youtube.com/playlist?list=${result.playlistId}`,
            added: result.results.added,
            failed: result.results.failed
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
});

// --- FRONTEND ---
app.get('/', (req, res) => {
    // Note the Favicon link: href="/favicon.ico"
    // Also simplified CSS for brevity
    res.send(`<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" href="/favicon.ico" type="image/x-icon"> 
    <title>Spotify to YouTube</title>
    <style>
        body { font-family: sans-serif; background: #121212; color: #fff; padding: 20px; display:flex; justify-content:center; }
        .container { max-width: 600px; width: 100%; background: #1e1e1e; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
        input, button { width: 100%; padding: 12px; margin-bottom: 10px; border-radius: 4px; box-sizing: border-box; }
        input { background: #333; border: 1px solid #444; color: white; }
        button { border: none; font-weight: bold; cursor: pointer; }
        .btn-sp { background: #1DB954; color: white; }
        .btn-yt { background: #ff0000; color: white; }
        .log { background: #000; padding: 10px; font-family: monospace; height: 150px; overflow-y: scroll; font-size: 12px; }
        .status-dot { height: 10px; width: 10px; border-radius: 50%; display: inline-block; margin-right: 5px; }
        .red { background: red; } .green { background: #00ff00; }
    </style>
</head>
<body>
<div class="container">
    <h2 style="text-align:center">🎵 Playlist Converter</h2>
    
    <div style="display:flex; gap:10px; margin-bottom:20px;">
        <div style="flex:1; background:#2a2a2a; padding:10px; border-radius:4px;">
            Spotify: <span id="sp_stat"><span class="status-dot red"></span>Off</span>
            <button id="btn_sp" class="btn-sp" style="margin-top:5px; font-size:12px;">Connect</button>
        </div>
        <div style="flex:1; background:#2a2a2a; padding:10px; border-radius:4px;">
            YouTube: <span id="yt_stat"><span class="status-dot red"></span>Off</span>
            <button id="btn_yt" class="btn-yt" style="margin-top:5px; font-size:12px;">Connect</button>
        </div>
    </div>

    <input id="playlistUrl" placeholder="Spotify Playlist URL or 'LIKED'" />
    <input id="existingPlaylistId" placeholder="Existing YouTube Playlist ID (Optional)" />
    <button id="convert" style="background: #333; color: white;">Start Conversion</button>
    
    <div id="status" style="margin: 10px 0; font-weight: bold;"></div>
    <div class="log" id="log">Logs will appear here...</div>
</div>

<script>
    const logEl = document.getElementById('log');
    const log = (msg) => { logEl.innerText += '\\n' + msg; logEl.scrollTop = logEl.scrollHeight; }

    const updateAuth = async () => {
        const r1 = await fetch('/auth/spotify/status').then(r=>r.json());
        const r2 = await fetch('/auth/status').then(r=>r.json());
        
        document.getElementById('sp_stat').innerHTML = r1.signedIn ? '<span class="status-dot green"></span>On' : '<span class="status-dot red"></span>Off';
        document.getElementById('btn_sp').style.display = r1.signedIn ? 'none' : 'block';
        
        document.getElementById('yt_stat').innerHTML = r2.signedIn ? '<span class="status-dot green"></span>On' : '<span class="status-dot red"></span>Off';
        document.getElementById('btn_yt').style.display = r2.signedIn ? 'none' : 'block';
    }
    updateAuth();

    document.getElementById('btn_sp').onclick = () => { window.open('/auth/spotify'); const i=setInterval(()=> {updateAuth();}, 2000); };
    document.getElementById('btn_yt').onclick = () => { window.open('/auth/youtube'); const i=setInterval(()=> {updateAuth();}, 2000); };

    document.getElementById('convert').onclick = async () => {
        const url = document.getElementById('playlistUrl').value;
        const exId = document.getElementById('existingPlaylistId').value;
        if(!url) return alert('Enter URL');
        
        document.getElementById('status').innerText = 'Working... This may take time...';
        log('Starting conversion process...');

        try {
            const res = await fetch('/convert', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ playlistUrl: url, existingPlaylistId: exId })
            });
            const data = await res.json();
            
            if(!res.ok) throw new Error(data.error || 'Error');
            
            document.getElementById('status').innerHTML = '<a href="'+data.youtubePlaylistUrl+'" target="_blank" style="color:#4CAF50">Success! Click here.</a>';
            log('Added ' + data.added.length + ' videos.');
            if(data.failed.length) log('Failed to add ' + data.failed.length + ' videos.');
        } catch(e) {
            document.getElementById('status').innerText = 'Error: ' + e.message;
            log('Error: ' + e.message);
        }
    };
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app; // Required for Vercel