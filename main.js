/*
---------------------------------------------------------
TUNECHANGE: SPOTIFY -> YOUTUBE CONVERTER
---------------------------------------------------------
*/
const express = require('express');
const cookieSession = require('cookie-session');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const yts = require('yt-search');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Allow inline scripts for our popup callbacks
app.use(helmet({ 
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: { policy: "unsafe-none" } 
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set('trust proxy', 1);

const isProduction = process.env.NODE_ENV === 'production';

app.use(cookieSession({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'secure_production_secret'],
    maxAge: 24 * 60 * 60 * 1000,
    secure: isProduction, 
    httpOnly: true,
    sameSite: 'lax'
}));

app.use(express.static(path.join(__dirname, 'public')));

// --- HELPER FUNCTIONS ---

function generateRandomString(length) {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
}

async function getSpotifyAppToken() {
    const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
    });
    const data = await res.json();
    return data.access_token;
}

function parseSpotifyPlaylistId(urlOrId) {
    if (!urlOrId) return null;
    const url = urlOrId.trim();
    if (url.toUpperCase() === 'LIKED') return 'LIKED';
    const match = url.match(/playlist[/:]([a-zA-Z0-9]+)/);
    return match ? match[1] : (url.length > 10 ? url : null);
}

async function fetchAllSpotifyTracks(playlistId, token) {
    let tracks = [];
    let url = playlistId === 'LIKED'
        ? 'https://api.spotify.com/v1/me/tracks?limit=50'
        : `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50`;

    // Simple pagination handling
    while (url) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return tracks.length > 0 ? tracks : null; 

        const data = await res.json();
        data.items.forEach(item => {
            if (item.track) tracks.push({ name: item.track.name, artist: item.track.artists[0].name });
        });
        url = data.next; 
    }
    return tracks;
}

async function searchYouTube(query) {
    try {
        const r = await yts(query);
        return (r && r.videos.length > 0) ? r.videos[0].videoId : null;
    } catch { return null; }
}

function makeOAuth2Client() {
    return new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET, process.env.YOUTUBE_REDIRECT_URI);
}

// --- LEGAL ROUTES (Required for Publishing) ---

const commonStyles = `
    <style>
        body { font-family: sans-serif; background: #121212; color: #ddd; max-width: 800px; margin: 0 auto; padding: 40px 20px; line-height: 1.6; }
        h1 { color: white; border-bottom: 2px solid #333; padding-bottom: 10px; }
        h2 { color: white; margin-top: 30px; }
        a { color: #1DB954; }
        .back { display: inline-block; margin-bottom: 20px; color: #aaa; text-decoration: none; }
        .back:hover { color: white; }
    </style>
`;

app.get('/privacy', (req, res) => {
    res.send(`<!doctype html>
        <html>
        <head><title>Privacy Policy - TuneChange</title>
        ${commonStyles}</head>
        <body>
            <a href="/" class="back">← Back to App</a>
            <h1>Privacy Policy</h1>
            <p><strong>Last Updated:</strong> January 3, 2026</p>

            <h2>1. Introduction</h2>
            <p>TuneChange respects your privacy. This policy explains how we handle your data in compliance with YouTube API Services Developer Policies.</p>

            <h2>2. Data We Access and Collect</h2>
            <ul>
                <li><strong>Spotify Data:</strong> We access your public profile and playlist metadata to identify tracks for migration.</li>
                <li><strong>YouTube API Data:</strong> Our application accesses, collects, and uses YouTube API Data to verify your channel identity and manage your playlists. This includes creating new playlists and adding matching music videos on your behalf.</li>
                <li><strong>Cookies & Local Storage:</strong> We store information directly or indirectly on your device, including the use of <strong>cookies or similar technologies</strong>, to maintain your session and application functionality.</li>
            </ul>

            <h2>3. How We Use and Share Data</h2>
            <p>Data is used exclusively to facilitate the transfer of music. <span class="highlight">We do not share your information or YouTube API Data with any external third parties.</span></p>

            <h2>4. Data Retention</h2>
            <p>We do not store your personal music history or YouTube API Data on any persistent server. All data is processed in temporary memory during your active session and is cleared once the migration is complete.</p>

            <h2>5. Third-Party Services</h2>
            <p>TuneChange uses <strong>YouTube API Services</strong>. By using this app, you agree to the <a href="https://www.youtube.com/t/terms" target="_blank">YouTube Terms of Service</a> and the <a href="http://www.google.com/policies/privacy" target="_blank">Google Privacy Policy</a>.</p>

            <h2>6. Revoking Access</h2>
            <p>You can revoke access at any time via the <a href="https://security.google.com/settings/security/permissions" target="_blank">Google Security Settings</a> page.</p>

            <h2>7. Contact</h2>
            <p>Questions? Contact us at: viratrahul0718@gmail.com</p>
        </body>
        </html>
    `);
});

app.get('/terms', (req, res) => {
    res.send(`<!doctype html>
        <html>
        <head><title>Terms of Service - TuneChange</title>
        <meta name="google-site-verification" content="uPuIXy59PtPLIaJ5lMmqSb8Rm6X2TJtjyUkzKJ_NE0o" />
        ${commonStyles}</head>
        <body>
            <a href="/" class="back">← Back to App</a>
            <h1>Terms of Service</h1>
            <p><strong>Last Updated:</strong> January 3, 2026</p>

            <h2>1. Acceptance of Terms</h2>
            <p>By accessing and using TuneChange, you accept and agree to be bound by the terms and provision of this agreement.</p>

            <h2>2. YouTube API Services</h2>
            <p>This client uses YouTube API Services. By using this client, you agree to be bound by the <a href="https://www.youtube.com/t/terms" target="_blank">YouTube Terms of Service</a>.</p>

            <h2>3. Disclaimer</h2>
            <p>TuneChange is provided "as is" without any warranties. We are not responsible for any data loss, incorrect song matching, or changes to your YouTube account/playlists.</p>

            <h2>4. User Responsibilities</h2>
            <p>You agree not to use this service for any illegal or unauthorized purpose.</p>
            
            <h2>5. Changes to Terms</h2>
            <p>We reserve the right to modify these terms at any time.</p>
        </body>
        </html>
    `);
});

// --- AUTH & PROFILE ROUTES ---

app.get('/auth/profiles', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    let profiles = { spotify: null, youtube: null };
    
    if (req.session.spotifyTokens) {
        try {
            const sRes = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${req.session.spotifyTokens.access_token}` } });
            if(sRes.ok) {
                const sData = await sRes.json();
                profiles.spotify = { name: sData.display_name, image: sData.images?.[0]?.url };
            } else { req.session.spotifyTokens = null; }
        } catch (e) { req.session.spotifyTokens = null; }
    }

    if (req.session.googleTokens) {
        try {
            const oauth = makeOAuth2Client();
            oauth.setCredentials(req.session.googleTokens);
            const youtube = google.youtube({ version: 'v3', auth: oauth });
            const yRes = await youtube.channels.list({ part: 'snippet', mine: true });
            
            if (yRes.data.items && yRes.data.items.length > 0) {
                const chan = yRes.data.items[0].snippet;
                profiles.youtube = { name: chan.title, image: chan.thumbnails.default.url };
            } else {
                // User is logged in, but HAS NO CHANNEL. 
                // We keep them logged in but show a generic name.
                profiles.youtube = { name: "Google Account (No Channel)", image: "https://www.gstatic.com/youtube/img/branding/favicon/favicon_144x144.png" };
                console.log("User logged in, but no YouTube Channel found.");
            }
        } catch (e) { 
            // CRITICAL: Log the specific error to your terminal
            console.error("YouTube API Error during profile fetch:", e); 
            console.error("Error details:", e.response ? e.response.data : e.message);
            
            // Only kill session if it's an Auth error
            if (e.code === 401 || e.code === 403) {
                req.session.googleTokens = null;
            }
        }
    }
    res.json(profiles);
});

app.get('/auth/logout/:platform', (req, res) => {
    if (req.params.platform === 'spotify') req.session.spotifyTokens = null;
    if (req.params.platform === 'youtube') req.session.googleTokens = null;
    res.redirect('/');
});

app.get('/auth/spotify', (req, res) => {
    const state = generateRandomString(16);
    req.session.spotifyState = state;
    const scope = 'playlist-read-private user-library-read';
    res.redirect('https://accounts.spotify.com/authorize?' + new URLSearchParams({
        response_type: 'code', client_id: process.env.SPOTIFY_CLIENT_ID,
        scope: scope, redirect_uri: process.env.SPOTIFY_REDIRECT_URI, state: state
    }).toString());
});

app.get('/spotify/callback', async (req, res) => {
    const { code } = req.query;
    const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    try {
        const resToken = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=authorization_code&code=${code}&redirect_uri=${process.env.SPOTIFY_REDIRECT_URI}`
        });
        const tokens = await resToken.json();
        req.session.spotifyTokens = tokens;
        
        res.send(`<script>if(window.opener){window.opener.postMessage({type:'SPOTIFY_CONNECTED'},'*');}window.close();</script>`);
    } catch(e) { res.send('Error logging in'); }
});

app.get('/auth/youtube', (req, res) => {
    const oauth = makeOAuth2Client();
    const url = oauth.generateAuthUrl({ 
        access_type: 'offline', 
        scope: ['https://www.googleapis.com/auth/youtube'], 
        prompt: 'select_account consent' 
    });
    res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
    const oauth = makeOAuth2Client();
    try {
        const { tokens } = await oauth.getToken(req.query.code);
        req.session.googleTokens = tokens;
        
        res.send(`<script>if(window.opener){window.opener.postMessage({type:'YOUTUBE_CONNECTED'},'*');}window.close();</script>`);
    } catch(e) { res.send('Error logging in'); }
});

// --- REAL-TIME CONVERSION ROUTE ---

app.get('/stream-convert', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const { playlistUrl, existingId } = req.query;

    try {
        const playlistId = parseSpotifyPlaylistId(playlistUrl);
        if (!req.session.googleTokens) return send({ error: 'Login to YouTube first' });

        const spToken = req.session.spotifyTokens?.access_token || await getSpotifyAppToken();
        const oauth = makeOAuth2Client();
        oauth.setCredentials(req.session.googleTokens);
        const youtube = google.youtube({ version: 'v3', auth: oauth });

        let ytId = existingId?.trim();
        
        // FIX: Remove 'mine: true' check. 
        // Just verify ID existence to support Brand Accounts/Shared Playlists properly.
        if (ytId) {
            try {
                const check = await youtube.playlists.list({ 
                    part: 'snippet', 
                    id: ytId 
                });
                
                if (!check.data.items || check.data.items.length === 0) {
                    return send({ error: "YouTube Playlist ID not found." });
                }
                // If it exists, we proceed. We assume we have write permissions.
                // If we don't, the item insert loop below will catch the error.
            } catch (e) { 
                return send({ error: "YouTube API Error: " + e.message }); 
            }
        }

        let tracks = await fetchAllSpotifyTracks(playlistId, spToken);
        if (!tracks) return send({ error: 'Spotify access failed. Check URL or privacy.' });
        
        // Create new playlist if no ID provided
        if (!ytId) {
            let title = "TuneChange Playlist";
            // Attempt to fetch Spotify playlist name
            if (playlistId === 'LIKED') title = "Liked Songs";
            else {
                try {
                    const m = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, { headers: { Authorization: `Bearer ${spToken}` } });
                    const d = await m.json();
                    if (d.name) title = d.name;
                } catch (e) { console.log("Name fetch failed, using default"); }
            }

            const p = await youtube.playlists.insert({ 
                part: 'snippet,status', 
                requestBody: { snippet: { title: title }, status: { privacyStatus: 'private' } } 
            });
            ytId = p.data.id;
        }

        send({ info: `Found ${tracks.length} tracks. Starting transfer...`, total: tracks.length });

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const vid = await searchYouTube(`${track.name} ${track.artist} official audio`);
            if (vid) {
                try {
                    await youtube.playlistItems.insert({ 
                        part: 'snippet', 
                        requestBody: { snippet: { playlistId: ytId, resourceId: { kind: 'youtube#video', videoId: vid } } } 
                    });
                    send({ success: true, name: track.name, count: i + 1 });
                } catch (e) {
                    if (e.errors && e.errors[0].reason === 'playlistNotFound') return send({ error: "Permission Error: Logged into wrong Brand Account?" });
                    send({ success: false, name: track.name, reason: 'Insert Failed', count: i + 1 });
                }
            } else {
                send({ success: false, name: track.name, reason: 'Not Found', count: i + 1 });
            }
            await new Promise(r => setTimeout(r, 600));
        }
        send({ done: true, url: `https://www.youtube.com/playlist?list=${ytId}` });
    } catch (err) { send({ error: err.message }); }
    finally { res.end(); }
});

app.get('/', (req, res) => {
    res.send(`<!doctype html>
<html>
<head>
    <title>TuneChange</title>
    <meta name="google-site-verification" content="uPuIXy59PtPLIaJ5lMmqSb8Rm6X2TJtjyUkzKJ_NE0o" />
    <style>
        :root { --spotify: #1DB954; --yt: #ff0000; --bg: #121212; --card: #1e1e1e; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { width: 100%; max-width: 550px; background: var(--card); padding: 30px; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); }
        .user-row { display: flex; justify-content: space-between; align-items: center; background: #2a2a2a; padding: 12px; border-radius: 10px; margin-bottom: 12px; border-left: 4px solid #444; }
        .user-row.spotify { border-color: var(--spotify); }
        .user-row.youtube { border-color: var(--yt); }
        .user-info { display: flex; align-items: center; gap: 12px; }
        .user-info img { width: 32px; height: 32px; border-radius: 50%; }
        .platform-label { font-size: 10px; text-transform: uppercase; color: #888; display: block; }
        .logout { color: #ff4444; text-decoration: none; font-size: 11px; border: 1px solid #ff4444; padding: 5px 10px; border-radius: 5px; transition: 0.2s; }
        .logout:hover { background: #ff4444; color: white; }
        
        input { width: 100%; padding: 14px; margin: 10px 0; background: #2c2c2c; border: 1px solid #444; color: white; border-radius: 8px; box-sizing: border-box; }
        
        /* THEMED INPUTS */
        #playlistUrl { border: 1px solid var(--spotify); border-left: 5px solid var(--spotify); }
        #existingId { border: 1px solid var(--yt); border-left: 5px solid var(--yt); }

        button { width: 100%; padding: 14px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .progress-container { width: 100%; background: #333; border-radius: 20px; height: 12px; margin: 25px 0; display: none; overflow: hidden; }
        .progress-fill { height: 100%; background: var(--spotify); width: 0%; transition: width 0.4s ease; }
        .log-box { background: #000; padding: 15px; border-radius: 8px; font-family: monospace; font-size: 11px; height: 150px; overflow-y: auto; margin-top: 15px; border: 1px solid #333; }
        .green { color: var(--spotify); }
        
        .footer-links { margin-top: 20px; font-size: 12px; color: #666; text-align: center; }
        .footer-links a { color: #888; text-decoration: none; margin: 0 10px; }
        .footer-links a:hover { color: white; text-decoration: underline; }

        .results-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); display: none; flex-direction: column; align-items: center; justify-content: center; z-index: 100; }
        .buckets-container { display: flex; gap: 20px; width: 90%; max-width: 800px; height: 60vh; margin-top: 20px; }
        .bucket { flex: 1; background: #252525; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; }
        .bucket-list { flex: 1; overflow-y: auto; font-size: 13px; list-style: none; padding: 0; }
        .bucket-list li { padding: 6px 0; border-bottom: 1px solid #333; }
        .close-btn { margin-top: 30px; background: white; color: black; width: auto; padding: 12px 40px; }
    </style>
</head>
<body>
    <div class="card">
        <h2 style="text-align:center;">TuneChange</h2>
        <div id="profiles"></div>
        <button id="btn_sp" style="background:var(--spotify); color:white; margin-bottom:10px; display:none;">Login Spotify</button>
        <button id="btn_yt" style="background:var(--yt); color:white; display:none;">Login YouTube</button>
        
        <label style="font-size: 12px; color: var(--spotify);">Spotify Source:</label>
        <input id="playlistUrl" placeholder="Playlist URL e.g. https://open.spotify.com/playlist/... or LIKED for liked songs">
        
        <label style="font-size: 12px; color: var(--yt);">YouTube Destination:</label>
        <input id="existingId" placeholder="Playlist ID e.g. PLbc6K08_6T7S1m... (Optional)">
        
        <div class="progress-container" id="p_container"><div class="progress-fill" id="p_fill"></div></div>
        <button id="convert" style="background:white; color:black; margin-top:20px;">Start Conversion</button>
        <div class="log-box" id="log">Ready...</div>
    </div>
    <div class="footer-links">
        <a href="/privacy" target="_blank">Privacy Policy</a> | 
        <a href="/terms" target="_blank">Terms of Service</a>
    </div>

    <div class="results-overlay" id="overlay">
        <h1 class="green">Done!</h1>
        <div id="final-link"></div>
        <div class="buckets-container">
            <div class="bucket"><h3>Added (<span id="success-count">0</span>)</h3><ul class="bucket-list" id="success-list"></ul></div>
            <div class="bucket"><h3>Failed (<span id="failed-count">0</span>)</h3><ul class="bucket-list" id="failed-list"></ul></div>
        </div>
        <button class="close-btn" onclick="location.reload()">New Conversion</button>
    </div>

<script>
    let isConverting = false;

    window.addEventListener('message', (event) => {
        if (event.data.type === 'SPOTIFY_CONNECTED' || event.data.type === 'YOUTUBE_CONNECTED') {
            updateProfiles();
        }
    });

    async function updateProfiles() {
        if (isConverting) return;
        const res = await fetch('/auth/profiles?t=' + Date.now());
        const data = await res.json();
        const container = document.getElementById('profiles');
        container.innerHTML = '';
        
        let sLinked = !!data.spotify;
        let yLinked = !!data.youtube;

        if(sLinked) {
            document.getElementById('btn_sp').style.display = 'none';
            container.innerHTML += \`<div class="user-row spotify"><div class="user-info"><img src="\${data.spotify.image || ''}"><div><span class="platform-label">Spotify Account</span>\${data.spotify.name}</div></div><a href="/auth/logout/spotify" class="logout nav-link">Disconnect</a></div>\`;
        } else { document.getElementById('btn_sp').style.display = 'block'; }
        
        if(yLinked) {
            document.getElementById('btn_yt').style.display = 'none';
            container.innerHTML += \`<div class="user-row youtube"><div class="user-info"><img src="\${data.youtube.image || ''}"><div><span class="platform-label">YouTube Account</span>\${data.youtube.name}</div></div><a href="/auth/logout/youtube" class="logout nav-link">Disconnect</a></div>\`;
        } else { document.getElementById('btn_yt').style.display = 'block'; }
    }
    
    updateProfiles();

    function openAuth(url, title) {
        const w = 500, h = 600;
        const left = (screen.width/2)-(w/2);
        const top = (screen.height/2)-(h/2);
        window.open(url, title, \`width=\${w},height=\${h},top=\${top},left=\${left}\`);
    }

    document.getElementById('btn_sp').onclick = () => openAuth('/auth/spotify', 'SpotifyLogin');
    document.getElementById('btn_yt').onclick = () => openAuth('/auth/youtube', 'YoutubeLogin');

    document.getElementById('convert').onclick = () => {
        const url = document.getElementById('playlistUrl').value;
        if(!url) return alert("Enter a Spotify URL");
        isConverting = true;
        document.getElementById('convert').disabled = true;
        document.getElementById('p_container').style.display = 'block';
        
        const source = new EventSource(\`/stream-convert?playlistUrl=\${encodeURIComponent(url)}&existingId=\${document.getElementById('existingId').value}\`);
        let s = [], f = [], total = 0;

        source.onmessage = (e) => {
            const d = JSON.parse(e.data);
            if(d.info) { total = d.total; document.getElementById('log').innerHTML += \`ℹ \${d.info}<br>\`; }
            if(d.success !== undefined) {
                d.success ? s.push(d.name) : f.push(d.name);
                document.getElementById('p_fill').style.width = ((d.count / total) * 100) + '%';
                document.getElementById('log').innerHTML += \`<div>\${d.success ? '✔' : '✘'} \${d.name}</div>\`;
                document.getElementById('log').scrollTop = document.getElementById('log').scrollHeight;
            }
            if(d.done) { source.close(); showOverlay(d.url, s, f); }
            if(d.error) { alert(d.error); location.reload(); }
        };
    };

    function showOverlay(url, s, f) {
        document.getElementById('overlay').style.display = 'flex';
        document.getElementById('final-link').innerHTML = \`<a href="\${url}" target="_blank" style="color:var(--spotify); font-weight:bold;">🔗 Open YouTube Playlist</a>\`;
        document.getElementById('success-count').innerText = s.length;
        document.getElementById('failed-count').innerText = f.length;
        s.forEach(t => document.getElementById('success-list').innerHTML += \`<li>\${t}</li>\`);
        f.forEach(t => document.getElementById('failed-list').innerHTML += \`<li>\${t}</li>\`);
    }
</script>
</body>
</html>`);
});
app.listen(PORT, () => console.log(`TuneChange running on port ${PORT}`));