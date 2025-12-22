/*
---------------------------------------------------------
SPOTIFY USER AUTH (Authorization Code Flow) & LIKED SONGS
---------------------------------------------------------
*/
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const yts = require('yt-search');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// required env variables
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI
// || `http://127.0.0.1:${PORT}/oauth2callback`;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI
//  || `http://127.0.0.1:${PORT}/spotify/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET 
// || 'change_this_secret';

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.warn('WARNING: SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET is missing. Spotify features requiring user auth will not work.');
}
if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    console.warn('WARNING: YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET is missing. Google OAuth will not work.');
}

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true }));

// --- HELPER FUNCTIONS ---

// Utility function for OAuth state
function generateRandomString(length) {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

// Helper: Get Spotify app access token (for public playlists)
async function getSpotifyAppToken() {
    const tokenUrl = 'https://accounts.spotify.com/api/token';
    const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

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
    
    // Check for 'LIKED' keyword
    if (url.toUpperCase() === 'LIKED') return 'LIKED';

    const spotifyUrlMatch = url.match(/playlist[/:]([a-zA-Z0-9]+)/);
    if (spotifyUrlMatch) return spotifyUrlMatch[1];
    const mockMatch = url.match(/\/(\d+)$/);
    if (mockMatch) return mockMatch[1];
    if (/^[a-zA-Z0-9]+$/.test(url)) return url;
    return null;
}

// Fetch all tracks from a Spotify source (handles pagination and uses user or app token)
async function fetchAllSpotifyTracks(playlistId, userTokens) {
    const isLikedSongs = playlistId === 'LIKED';
    let tokenToUse;
    let url;
    
    if (isLikedSongs) {
        if (!userTokens) throw new Error("Spotify sign-in required to access LIKED songs.");
        tokenToUse = userTokens.access_token;
        // FIX: Use real Spotify API for Liked Songs (limit max is 50)
        url = `https://api.spotify.com/v1/me/tracks?limit=50`; 
        console.log("Fetching LIKED songs...");
    } else if (userTokens) {
        tokenToUse = userTokens.access_token;
        // FIX: Use real Spotify API for Playlists
        url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
        console.log(`Fetching playlist ${playlistId} with User Token...`);
    } else {
        tokenToUse = await getSpotifyAppToken();
        // FIX: Use real Spotify API for Playlists
        url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
        console.log(`Fetching public playlist ${playlistId} with App Token...`);
    }

    // ... rest of the function remains the same ...
    const headers = { Authorization: `Bearer ${tokenToUse}` };
    const tracks = [];

    // Spotify API URLs are typically used here, using the mock format provided:
    let nextUrl = url;

    while (nextUrl) {
        const res = await fetch(nextUrl, { headers });
        
        if (res.status === 401 && !isLikedSongs && !userTokens) {
            // Public playlist request failed with App token (shouldn't happen), try again with new token
             tokenToUse = await getSpotifyAppToken();
             headers.Authorization = `Bearer ${tokenToUse}`;
             const retryRes = await fetch(nextUrl, { headers });
             if (!retryRes.ok) {
                const txt = await retryRes.text();
                const err = new Error(`Failed fetching Spotify playlist tracks after retry: ${retryRes.status} ${txt}`);
                err.status = retryRes.status;
                throw err;
             }
        }
        
        if (!res.ok) {
            const txt = await res.text();
            const err = new Error(`Failed fetching Spotify tracks: ${res.status} ${txt}`);
            err.status = res.status;
            throw err;
        }
        
        const data = await res.json();
        const items = isLikedSongs ? data.items.map(item => item) : data.items;
        
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
    }
    return tracks;
}

function buildYouTubeQuery(track) {
    const artist = track.artists && track.artists.length ? track.artists[0] : '';
    let q = `${track.name} ${artist}`;
    q = q.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
    return q;
}

// Using scraping instead of API Key (0 quota cost)
async function searchYouTubeMostViewed(query) {
    console.log(`🔎 Searching: "${query}"`); 

    try {
        // Create a timeout promise that rejects after 5 seconds
        const timeout = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Search timed out')), 5000)
        );

        // Race the search against the timeout
        const r = await Promise.race([
            yts(query),
            timeout
        ]);

        const videos = r.videos;
        
        if (videos && videos.length > 0) {
            return videos[0].videoId;
        }
        return null;
    } catch (err) {
        console.error(`   ❌ Search failed/timed out for "${query}": ${err.message}`);
        return null;
    }
}

async function createYouTubePlaylistAndAddVideos(oauth2Client, title, description, videoIds, existingPlaylistId) {
    if (!oauth2Client.credentials || !oauth2Client.credentials.access_token) {
        throw new Error('OAuth2 client is missing credentials. Please re-authenticate.');
    }

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    let playlistId;
    const isExisting = existingPlaylistId && existingPlaylistId.length > 0;

    if (isExisting) {
        playlistId = existingPlaylistId;
        console.log(`Using existing YouTube Playlist ID: ${playlistId}`);
    } else {
        title = title && title.trim() ? title : 'Converted Spotify Playlist';
        description = description || 'Converted playlist generated automatically';

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
            console.log("Playlist created successfully:", insertRes.data);
            playlistId = insertRes.data.id;
        } catch (error) {
            console.error("Detailed YouTube API Error:", error.response ? error.response.data : error);
            throw new Error(`Youtubelist creation failed: ${error.message}`);
        }
    }

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
            // console.log(`Added video ${vid} to playlist.`); // Suppressing excessive logs
        } catch (err) {
            if (isExisting && err.code === 403) {
                throw new Error('Permission Denied: Cannot add videos to this playlist.');
            }
            console.warn('Failed adding video to playlist', vid, err.message || err);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    return playlistId;
}

function makeOAuth2Client() {
    return new google.auth.OAuth2(
        YOUTUBE_CLIENT_ID,
        YOUTUBE_CLIENT_SECRET,
        YOUTUBE_REDIRECT_URI
    );
}

// --- SPOTIFY AUTH ROUTES ---

// Endpoint to start Spotify OAuth
app.get('/auth/spotify', (req, res) => {
    const state = generateRandomString(16);
    req.session.spotifyState = state;
    // Required scopes to read private playlists and Liked Songs
    const scopes = 'playlist-read-private user-library-read';
    const authUrl = 'https://accounts.spotify.com/authorize?' + // Spotify Auth URL
        new URLSearchParams({
            response_type: 'code',
            client_id: SPOTIFY_CLIENT_ID,
            scope: scopes,
            redirect_uri: SPOTIFY_REDIRECT_URI,
            state: state
        }).toString();
    res.redirect(authUrl);
});

// Callback from Spotify
app.get('/spotify/callback', async (req, res) => {
    const code = req.query.code || null;
    const state = req.query.state || null;
    const storedState = req.session.spotifyState;

    if (state === null || state !== storedState) {
        return res.status(400).send('State mismatch error.');
    }

    try {
        const tokenUrl = 'https://accounts.spotify.com/api/token'; // Spotify Token URL
        const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

        const resToken = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `grant_type=authorization_code&code=${code}&redirect_uri=${SPOTIFY_REDIRECT_URI}`
        });

        if (!resToken.ok) {
            const text = await resToken.text();
            throw new Error(`Spotify token exchange failed: ${resToken.status} ${text}`);
        }
        const data = await resToken.json();
        req.session.spotifyTokens = data;
        res.send('<script>window.close();</script><html><body>Spotify sign-in successful. You can close this window and return to the app.</body></html>');
    } catch (err) {
        console.error('Failed to exchange Spotify code:', err);
        res.status(500).send('Spotify token exchange failed');
    }
});

// Endpoint to check Spotify sign-in status
app.get('/auth/spotify/status', (req, res) => {
    res.json({ signedIn: !!req.session.spotifyTokens });
});

// --- YOUTUBE AUTH ROUTES ---

app.get('/auth/youtube', (req, res) => {
    if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) return res.status(500).send('Server misconfigured: missing YouTube OAuth credentials in .env');
    const oauth2Client = makeOAuth2Client();
    const scopes = ['https://www.googleapis.com/auth/youtube'];
    const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });
    res.redirect(url);
});

app.get('/auth/status', (req, res) => {
    res.json({ signedIn: !!req.session.googleTokens });
});

app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');
    const oauth2Client = makeOAuth2Client();
    try {
        const { tokens } = await oauth2Client.getToken(code);
        req.session.googleTokens = tokens;
        res.send('<html><body>Google sign-in successful. You can close this window and return to the app.</body></html>');
    } catch (err) {
        console.error('Failed to exchange Google code', err);
        res.status(500).send('Google token exchange failed');
    }
});

// --- MAIN CONVERSION ROUTE ---

app.post('/convert', async (req, res) => {
    console.log("\n--- STARTING CONVERSION ---");
    const playlistUrl = req.body.playlistUrl;
    const existingPlaylistId = req.body.existingPlaylistId || null;
    const userTokens = req.session.spotifyTokens; // Grab user token if available

    console.log(`1. Received Playlist Input: ${playlistUrl}`);
    if (existingPlaylistId) console.log(`   Attempting to use existing YouTube ID: ${existingPlaylistId}`);

    if (!playlistUrl) return res.status(400).json({ error: 'Missing playlistUrl' });

    const playlistId = parseSpotifyPlaylistId(playlistUrl);
    console.log(`2. Parsed Spotify Playlist ID: ${playlistId}`);

    if (!playlistId) return res.status(400).json({ error: 'Could not parse Spotify playlist id' });

    // --- TRACK FETCHING ---
    let tracks;
    try {
        tracks = await fetchAllSpotifyTracks(playlistId, userTokens);
        console.log(`4. Tracks Fetched: ${tracks ? tracks.length : 0}`);
    } catch (err) {
        console.error('Error fetching playlist', err);
        // If it was a LIKED request and no token was present, prompt user to log in
        if (playlistId === 'LIKED' && err.message.includes('Spotify sign-in required')) {
             return res.status(401).json({ error: err.message });
        }
        return res.status(500).json({ error: 'Failed to fetch playlist: ' + err.message });
    }

    if (!tracks || !tracks.length) return res.status(400).json({ error: 'Playlist contains no tracks' });

    if (!req.session.googleTokens) {
        return res.status(401).json({ error: 'Google sign-in required to create/modify playlist' });
    }

    const oauth2Client = makeOAuth2Client();
    oauth2Client.setCredentials(req.session.googleTokens);

    // --- SEARCH AND ADD ---
    const videoIds = [];
    console.log("5. Starting YouTube Search loop...");

    // Inside app.post('/convert', ...)
for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const q = buildYouTubeQuery(t);
    
    // Add a log so you can see it moving!
    console.log(`Processing ${i + 1}/${tracks.length}: ${q}`); 

    try {
        const vid = await searchYouTubeMostViewed(q);
        videoIds.push(vid);
    } catch (err) {
        videoIds.push(null);
    }
    
    // INCREASE DELAY FROM 200 TO 1000 or 2000 (1-2 seconds)
    await new Promise(resolve => setTimeout(resolve, 1500)); 
}

    const validVideos = videoIds.filter(v => v !== null);
    console.log(`6. Search Complete. Found ${validVideos.length} valid videos out of ${tracks.length} tracks.`);

    if (validVideos.length === 0) {
        console.error("❌ CRITICAL: No videos were found. Playlist will be empty.");
    }

    const spPlaylistTitle = playlistId === 'LIKED' ? 'Converted Spotify Liked Songs' : `Converted from Spotify: ${playlistId}`;
    const spPlaylistDesc = playlistId === 'LIKED' ? 'Liked songs converted automatically' : `Converted automatically from Spotify playlist ${playlistUrl}`;

    try {
        console.log("7. Creating/Adding to YouTube Playlist...");
        const finalPlaylistId = await createYouTubePlaylistAndAddVideos(oauth2Client, spPlaylistTitle, spPlaylistDesc, videoIds, existingPlaylistId);
        const youtubePlaylistUrl = `https://www.youtube.com/playlist?list=${finalPlaylistId}`;
        console.log(`8. SUCCESS! Playlist URL: ${youtubePlaylistUrl}`);
        return res.json({ youtubePlaylistUrl });
    } catch (err) {
        if (err.message === 'Permission Denied: Cannot add videos to this playlist.') {
            console.warn('Playlist insertion failed due to 403 Permission Denied. Returning error to frontend.');
            return res.status(403).json({ error: err.message });
        }

        console.error('Failed creating/modifying YouTube playlist', err);
        return res.status(500).json({ error: 'Failed to create/modify YouTube playlist: ' + (err.message || err) });
    }
});

// --- BEAUTIFUL FRONTEND ---

app.get('/', (req, res) => {
    res.send(`<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Spotify → YouTube Playlist Converter</title>
    <style>
        :root {
            --primary-color: #ff0000; /* YouTube Red */
            --secondary-color: #1DB954; /* Spotify Green */
            --background-color: #121212; /* Very Dark Grey/Black */
            --card-color: #1e1e1e; /* Dark Grey for cards */
            --text-color: #e0e0e0; /* Light Grey for text */
            --input-bg: #2c2c2c;
            --input-border: #444;
            --border-radius: 8px;
            --shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: var(--background-color);
            color: var(--text-color);
            display: flex;
            justify-content: center;
            min-height: 100vh;
        }
        .container {
            width: 100%;
            max-width: 800px;
        }
        .card {
            background-color: var(--card-color);
            padding: 30px;
            border-radius: var(--border-radius);
            box-shadow: var(--shadow);
            margin-bottom: 20px;
            border: 1px solid #333;
        }
        h1 {
            text-align: center;
            color: #ffffff;
            margin-top: 0;
        }
        p {
            line-height: 1.6;
            margin-bottom: 20px;
            color: #b0b0b0;
        }
        input, button {
            font-size: 16px;
            padding: 12px 15px;
            margin-bottom: 10px;
            border-radius: var(--border-radius);
            border: 1px solid var(--input-border);
            width: 100%;
            box-sizing: border-box;
            transition: border-color 0.3s, background-color 0.3s;
            background-color: var(--input-bg);
            color: #fff;
        }
        input:focus {
            outline: none;
            border-color: var(--primary-color);
            background-color: #333;
        }
        .auth-status-container {
            display: flex;
            gap: 15px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        .auth-box {
            flex: 1 1 200px;
            padding: 15px;
            border-radius: var(--border-radius);
            background-color: #252525;
            border: 1px dashed #444;
        }
        .auth-box h3 {
            margin-top: 0;
            font-size: 1.1em;
            color: #fff;
        }
        .btn-group {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            margin-top: 10px;
        }
        button {
            cursor: pointer;
            color: #fff;
            font-weight: bold;
            border: none;
            flex: 1 1 45%;
        }
        button:hover {
            opacity: 0.9;
        }
        #spotify_login, #youtube_login {
             background-color: var(--secondary-color);
        }
        #youtube_login {
            background-color: var(--primary-color);
        }
        #convert_new {
            background-color: var(--primary-color);
        }
        #convert_add {
            background-color: #444; 
        }
        #convert_add:hover {
            background-color: #666;
        }
        #log {
            white-space: pre-wrap;
            background: #000;
            color: #00ff00; /* Hacker green text for logs */
            padding: 15px;
            border-radius: var(--border-radius);
            max-height: 250px;
            overflow: auto;
            font-family: monospace;
            font-size: 0.9em;
            border: 1px solid #333;
        }
        #status {
            font-weight: bold;
            padding: 10px 0;
        }
        .text-success { color: var(--secondary-color); }
        .text-warning { color: #ffcc00; }
        .text-error { color: #ff4444; }
        a { color: #58a6ff; }
    </style>
</head>
<body>
<div class="container">
    <div class="card">
        <h1>🎧 Convert Spotify to YouTube Playlist 🎬</h1>
        <p>This tool fetches tracks from Spotify (including **Liked Songs** or **private playlists**) and creates a matching playlist on your YouTube account.</p>

        <div class="auth-status-container">
            <div class="auth-box">
                <h3>Spotify Connection</h3>
                <span id="spotify_status">Status: <span class="text-error">Disconnected</span></span>
                <button id="spotify_login" style="margin-top: 10px;">Connect to Spotify</button>
            </div>
            <div class="auth-box">
                <h3>YouTube Connection</h3>
                <span id="youtube_status">Status: <span class="text-error">Disconnected</span></span>
                <button id="youtube_login" style="margin-top: 10px;">Connect to YouTube</button>
            </div>
        </div>
        
        <input id="playlistUrl" placeholder="Spotify Playlist URL or type 'LIKED' for your Liked Songs" size="60" />
        <input id="existingPlaylistId" placeholder="Existing YouTube Playlist ID (Optional: adds videos here)" size="60" />
        
        <div class="btn-group">
            <button id="convert_new">Convert to NEW YouTube Playlist</button>
            <button id="convert_add">Add Videos to Existing ID</button>
        </div>

        <p id="status"></p>
    </div>
    <div class="card">
        <h3>Conversion Log</h3>
        <div id="log">Awaiting conversion...</div>
    </div>
</div>

<script>
    const statusEl = document.getElementById('status');
    const spotifyStatusEl = document.getElementById('spotify_status');
    const youtubeStatusEl = document.getElementById('youtube_status');
    const spotifyLoginBtn = document.getElementById('spotify_login');
    const youtubeLoginBtn = document.getElementById('youtube_login');

    // --- AUTHENTICATION STATUS ---
    async function checkAuthStatus() {
        // Spotify
        let r = await fetch('/auth/spotify/status');
        let j = await r.json();
        if (j.signedIn) {
            spotifyStatusEl.innerHTML = 'Status: <span class="text-success">Connected</span>';
            spotifyLoginBtn.style.display = 'none';
        } else {
            spotifyStatusEl.innerHTML = 'Status: <span class="text-error">Disconnected</span>';
            spotifyLoginBtn.style.display = 'inline-block';
        }

        // YouTube
        r = await fetch('/auth/status');
        j = await r.json();
        if (j.signedIn) {
            youtubeStatusEl.innerHTML = 'Status: <span class="text-success">Connected</span>';
            youtubeLoginBtn.style.display = 'none';
        } else {
            youtubeStatusEl.innerHTML = 'Status: <span class="text-error">Disconnected</span>';
            youtubeLoginBtn.style.display = 'inline-block';
        }
    }
    checkAuthStatus();

    // --- UTILITIES ---
    async function postJson(url, body) {
        const res = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        return res;
    }

    // --- MAIN CONVERSION LOGIC ---
    const handleConversion = async (targetExisting) => {
        const url = document.getElementById('playlistUrl').value.trim();
        let existingId = targetExisting ? document.getElementById('existingPlaylistId').value.trim() : '';

        if (!url) { alert('Please enter a Spotify playlist URL or LIKED.'); return; }
        
        // Ensure YouTube is connected first
        if (youtubeStatusEl.innerText.includes('Disconnected')) {
             statusEl.innerHTML = '<span class="text-error">Please connect to YouTube first!</span>';
             return;
        }

        statusEl.innerHTML = 'Starting conversion... (Check console for detailed logs)';
        
        const body = { playlistUrl: url, existingPlaylistId: existingId };

        const processConversion = async (requestBody) => {
            const res = await postJson('/convert', requestBody);
            const json = await res.json();
            
            if (res.status === 401) {
                // Spotify (Specific Error)
                if (json.error && json.error.includes("Spotify sign-in required")) {
                    statusEl.innerHTML = '<span class="text-error">Spotify sign-in required to access private/liked tracks. Please connect above.</span>';
                    return null;
                }
                
                // YouTube (Shouldn't happen here if pre-checked, but kept for robustness)
                statusEl.innerHTML = 'Signing into Google...';
                const w = window.open('/auth/youtube', 'google_auth', 'width=600,height=700');
                return new Promise((resolve) => {
                    const poll = setInterval(async () => {
                        const r = await fetch('/auth/status');
                        const j = await r.json();
                        if (j.signedIn) {
                            clearInterval(poll);
                            w.close();
                            checkAuthStatus();
                            statusEl.innerHTML = 'Signed in. Resuming conversion...';
                            resolve(await postJson('/convert', requestBody)); 
                        }
                    }, 1500);
                });
            }
            
            if (res.ok) {
                statusEl.innerHTML = 'Done. <a href="' + json.youtubePlaylistUrl + '" target="_blank">Open YouTube playlist</a>';
            } else if (res.status === 403 && json.error === 'Permission Denied: Cannot add videos to this playlist.') {
                statusEl.innerHTML = '⚠️ <span class="text-warning">WARNING: Cannot add videos to that YouTube Playlist ID (Permission Denied). Check ownership or clear the field.</span>';
                document.getElementById('existingPlaylistId').focus();
            } else {
                const errorMessage = json.error || JSON.stringify(json);
                statusEl.innerHTML = '<span class="text-error">Error: ' + errorMessage + '</span>';
            }
            return res; // Always return the response object
        };

        await processConversion(body);
    };

    // --- EVENT LISTENERS ---
    spotifyLoginBtn.addEventListener('click', () => {
        window.open('/auth/spotify', 'spotify_auth', 'width=600,height=700');
        const poll = setInterval(() => {
            fetch('/auth/spotify/status').then(r => r.json()).then(j => {
                if(j.signedIn) {
                    clearInterval(poll);
                    checkAuthStatus();
                }
            })
        }, 1500);
    });
    
    youtubeLoginBtn.addEventListener('click', () => {
         window.open('/auth/youtube', 'google_auth', 'width=600,height=700');
         const poll = setInterval(() => {
            fetch('/auth/status').then(r => r.json()).then(j => {
                if(j.signedIn) {
                    clearInterval(poll);
                    checkAuthStatus();
                }
            })
        }, 1500);
    });

    document.getElementById('convert_add').addEventListener('click', () => handleConversion(true));
    document.getElementById('convert_new').addEventListener('click', () => {
        document.getElementById('existingPlaylistId').value = ''; 
        handleConversion(false);
    });
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`Server running on http://127.0.0.1:${PORT}`));