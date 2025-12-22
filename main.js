/*
---------------------------------------------------------
SPOTIFY -> YOUTUBE PLAYLIST CONVERTER (Real-time & Animated)
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

// Security & Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set('trust proxy', 1);

app.use(cookieSession({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'secure_production_secret'],
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
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

    let pages = 0;
    const MAX_PAGES = 2; // Vercel Free Limit (approx 100 songs)

    while (url && pages < MAX_PAGES) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) break;
        const data = await res.json();
        data.items.forEach(item => {
            if (item.track) tracks.push({ name: item.track.name, artist: item.track.artists[0].name });
        });
        url = data.next;
        pages++;
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

// --- AUTH & PROFILE ROUTES ---

app.get('/auth/profiles', async (req, res) => {
    let profiles = { spotify: null, youtube: null };
    if (req.session.spotifyTokens) {
        try {
            const sRes = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${req.session.spotifyTokens.access_token}` } });
            const sData = await sRes.json();
            profiles.spotify = { name: sData.display_name, image: sData.images?.[0]?.url };
        } catch (e) { req.session.spotifyTokens = null; }
    }
    if (req.session.googleTokens) {
        try {
            const oauth = makeOAuth2Client();
            oauth.setCredentials(req.session.googleTokens);
            const youtube = google.youtube({ version: 'v3', auth: oauth });
            const yRes = await youtube.channels.list({ part: 'snippet', mine: true });
            const chan = yRes.data.items[0].snippet;
            profiles.youtube = { name: chan.title, image: chan.thumbnails.default.url };
        } catch (e) { req.session.googleTokens = null; }
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
    res.redirect('https://accounts.spotify.com/authorize?' + new URLSearchParams({
        response_type: 'code', client_id: process.env.SPOTIFY_CLIENT_ID,
        scope: 'playlist-read-private user-library-read', redirect_uri: process.env.SPOTIFY_REDIRECT_URI, state: state
    }).toString());
});

app.get('/spotify/callback', async (req, res) => {
    const { code } = req.query;
    const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const resToken = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}&redirect_uri=${process.env.SPOTIFY_REDIRECT_URI}`
    });
    req.session.spotifyTokens = await resToken.json();
    res.send('<script>window.close();</script>');
});

app.get('/auth/youtube', (req, res) => {
    const oauth = makeOAuth2Client();
    res.redirect(oauth.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/youtube'], prompt: 'consent' }));
});

app.get('/oauth2callback', async (req, res) => {
    const oauth = makeOAuth2Client();
    const { tokens } = await oauth.getToken(req.query.code);
    req.session.googleTokens = tokens;
    res.send('<script>window.close();</script>');
});

// --- REAL-TIME CONVERSION ROUTE ---

app.get('/stream-convert', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const { playlistUrl, existingId } = req.query;

    if (!req.session.googleTokens) return send({ error: 'Login to YouTube first' });

    try {
        const playlistId = parseSpotifyPlaylistId(playlistUrl);
        
        // CHECK FOR LIKED SONGS LOGIN REQUIREMENT
        if (playlistId === 'LIKED' && !req.session.spotifyTokens) {
            return send({ error: 'You must login to Spotify first to fetch the LIKED songs.' });
        }

        const spToken = req.session.spotifyTokens?.access_token || await getSpotifyAppToken();

        let title = "My Spotify Playlist";
        if (playlistId !== 'LIKED') {
            const meta = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, { headers: { Authorization: `Bearer ${spToken}` } });
            const metaData = await meta.json();
            title = metaData.name || title;
        }

        const tracks = await fetchAllSpotifyTracks(playlistId, spToken);
        send({ info: `Found ${tracks.length} tracks in "${title}".`, total: tracks.length });

        const oauth = makeOAuth2Client();
        oauth.setCredentials(req.session.googleTokens);
        const youtube = google.youtube({ version: 'v3', auth: oauth });

        let ytId = existingId;
        if (!ytId) {
            const p = await youtube.playlists.insert({ part: 'snippet,status', requestBody: { snippet: { title }, status: { privacyStatus: 'private' } } });
            ytId = p.data.id;
        }

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const vid = await searchYouTube(`${track.name} ${track.artist} official audio`);
            if (vid) {
                try {
                    await youtube.playlistItems.insert({ part: 'snippet', requestBody: { snippet: { playlistId: ytId, resourceId: { kind: 'youtube#video', videoId: vid } } } });
                    send({ success: true, name: track.name, count: i + 1 });
                } catch (e) { send({ success: false, name: track.name, reason: 'YT Error', count: i + 1 }); }
            } else {
                send({ success: false, name: track.name, reason: 'Not Found', count: i + 1 });
            }
            await new Promise(r => setTimeout(r, 600));
        }

        send({ done: true, url: `https://www.youtube.com/playlist?list=${ytId}` });
    } catch (err) {
        send({ error: err.message });
    } finally {
        res.end();
    }
});

// --- FRONTEND ---
app.get('/', (req, res) => {
    res.send(`<!doctype html>
<html>
<head>
    <title>Convertify</title>
    <style>
        :root { --spotify: #1DB954; --yt: #ff0000; --bg: #121212; --card: #1e1e1e; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: white; display: flex; justify-content: center; padding: 20px; overflow-x: hidden; }
        .card { width: 100%; max-width: 550px; background: var(--card); padding: 30px; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); position: relative; }
        .user-row { display: flex; justify-content: space-between; align-items: center; background: #2a2a2a; padding: 12px; border-radius: 10px; margin-bottom: 12px; }
        .user-info { display: flex; align-items: center; gap: 12px; }
        .user-info img { width: 32px; height: 32px; border-radius: 50%; border: 2px solid #444; }
        .logout { color: #ff4444; text-decoration: none; font-size: 11px; font-weight: bold; text-transform: uppercase; border: 1px solid #ff4444; padding: 5px 10px; border-radius: 5px; transition: 0.3s; }
        .logout:hover { background: #ff4444; color: white; }
        .logout.disabled { opacity: 0.2; pointer-events: none; filter: grayscale(1); }
        
        input { width: 100%; padding: 14px; margin: 10px 0; background: #2c2c2c; border: 1px solid #444; color: white; border-radius: 8px; box-sizing: border-box; outline: none; transition: 0.3s; }
        input:focus { border-color: var(--spotify); }
        button { width: 100%; padding: 14px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; font-size: 15px; transition: 0.3s; }
        button:disabled { background: #444 !important; color: #777 !important; cursor: not-allowed; }
        
        .progress-container { width: 100%; background: #333; border-radius: 20px; height: 12px; margin: 25px 0; display: none; overflow: hidden; position: relative; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #1DB954, #1ed760); width: 0%; transition: width 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        
        .log-box { background: #000; padding: 15px; border-radius: 8px; font-family: 'Fira Code', monospace; font-size: 11px; height: 150px; overflow-y: auto; margin-top: 15px; border: 1px solid #333; line-height: 1.8; }
        .green { color: var(--spotify); } .red { color: #ff4444; } .gray { color: #888; }

        /* BUCKETS ANIMATION */
        .results-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); display: none; flex-direction: column; align-items: center; justify-content: center; z-index: 100; animation: fadeIn 0.5s ease; }
        .buckets-container { display: flex; gap: 20px; width: 90%; max-width: 800px; height: 60vh; margin-top: 20px; }
        .bucket { flex: 1; background: #252525; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; transform: translateY(50px); opacity: 0; transition: 0.6s all ease-out; }
        .bucket.show { transform: translateY(0); opacity: 1; }
        .bucket-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 15px; }
        .bucket-list { flex: 1; overflow-y: auto; font-size: 13px; list-style: none; padding: 0; margin: 0; }
        .bucket-list li { padding: 8px; border-bottom: 1px solid #333; animation: slideIn 0.3s ease forwards; }
        
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: translateX(0); } }
        .close-btn { margin-top: 30px; background: white; color: black; width: auto; padding: 12px 40px; }
    </style>
</head>
<body>
    <div class="card">
        <h2 style="text-align:center; margin-bottom:30px;">Spotify <span class="gray">➔</span> YouTube</h2>
        
        <div id="profiles"></div>
        <button id="btn_sp" style="background:var(--spotify); color:white; margin-bottom:10px; display:none;">Login Spotify</button>
        <button id="btn_yt" style="background:var(--yt); color:white; display:none;">Login YouTube</button>

        <input id="playlistUrl" placeholder="Spotify Playlist URL or 'LIKED'">
        <input id="existingId" placeholder="YouTube Playlist ID (Optional)">
        
        <div class="progress-container" id="p_container">
            <div class="progress-fill" id="p_fill"></div>
        </div>

        <button id="convert" style="background:white; color:black; margin-top:20px;">Start Conversion</button>
        <div class="log-box" id="log">Ready for conversion...</div>
    </div>

    <div class="results-overlay" id="overlay">
        <h1 class="green">Conversion Complete!</h1>
        <div id="final-link"></div>
        <div class="buckets-container">
            <div class="bucket" id="success-bucket">
                <div class="bucket-header">
                    <span class="green">Added</span>
                    <b id="success-count">0</b>
                </div>
                <ul class="bucket-list" id="success-list"></ul>
            </div>
            <div class="bucket" id="failed-bucket" style="transition-delay: 0.2s;">
                <div class="bucket-header">
                    <span class="red">Failed</span>
                    <b id="failed-count">0</b>
                </div>
                <ul class="bucket-list" id="failed-list"></ul>
            </div>
        </div>
        <button class="close-btn" onclick="location.reload()">Done</button>
    </div>

<script>
    let totalTracks = 0;
    let successTracks = [];
    let failedTracks = [];

    async function load() {
        const res = await fetch('/auth/profiles');
        const data = await res.json();
        const container = document.getElementById('profiles');
        container.innerHTML = '';
        if(data.spotify) container.innerHTML += \`<div class="user-row"><div class="user-info"><img src="\${data.spotify.image || ''}"> \${data.spotify.name}</div><a href="/auth/logout/spotify" class="logout nav-link">Disconnect</a></div>\`;
        else document.getElementById('btn_sp').style.display = 'block';
        if(data.youtube) container.innerHTML += \`<div class="user-row"><div class="user-info"><img src="\${data.youtube.image || ''}"> \${data.youtube.name}</div><a href="/auth/logout/youtube" class="logout nav-link">Disconnect</a></div>\`;
        else document.getElementById('btn_yt').style.display = 'block';
    }
    load();

    document.getElementById('btn_sp').onclick = () => window.open('/auth/spotify', '_blank', 'width=500,height=600');
    document.getElementById('btn_yt').onclick = () => window.open('/auth/youtube', '_blank', 'width=500,height=600');

    document.getElementById('convert').onclick = () => {
        const url = document.getElementById('playlistUrl').value;
        const eid = document.getElementById('existingId').value;
        const log = document.getElementById('log');
        const fill = document.getElementById('p_fill');
        const pContainer = document.getElementById('p_container');
        const convertBtn = document.getElementById('convert');
        const navLinks = document.querySelectorAll('.nav-link');

        if(!url) return alert("Enter a Spotify URL");

        // RESET & LOCK
        successTracks = []; failedTracks = [];
        convertBtn.disabled = true;
        pContainer.style.display = 'block';
        navLinks.forEach(link => link.classList.add('disabled'));
        log.innerHTML = '<span class="gray">Connecting to stream...</span><br>';
        
        const source = new EventSource(\`/stream-convert?playlistUrl=\${encodeURIComponent(url)}&existingId=\${eid}\`);

        source.onmessage = (e) => {
            const d = JSON.parse(e.data);
            if(d.info) { totalTracks = d.total; log.innerHTML += \`<span class="gray">ℹ \${d.info}</span><br>\`; }
            
            if(d.success || d.success === false) {
                if(d.success) successTracks.push(d.name);
                else failedTracks.push(\`\${d.name} (\${d.reason})\`);
                
                const icon = d.success ? '<span class="green">✔</span>' : '<span class="red">✘</span>';
                log.innerHTML += \`<div>\${icon} \${d.name}</div>\`;
                fill.style.width = ((d.count / totalTracks) * 100) + '%';
            }

            if(d.done) {
                showBuckets(d.url);
                source.close();
            }
            if(d.error) { alert(d.error); location.reload(); }
            log.scrollTop = log.scrollHeight;
        };
    };

    function showBuckets(url) {
        document.getElementById('overlay').style.display = 'flex';
        document.getElementById('final-link').innerHTML = \`<a href="\${url}" target="_blank" style="color:var(--spotify); font-weight:bold; text-decoration:none;">🔗 Open YouTube Playlist</a>\`;
        
        const sList = document.getElementById('success-list');
        const fList = document.getElementById('failed-list');
        document.getElementById('success-count').innerText = successTracks.length;
        document.getElementById('failed-count').innerText = failedTracks.length;

        successTracks.forEach(t => sList.innerHTML += \`<li>\${t}</li>\`);
        failedTracks.forEach(t => fList.innerHTML += \`<li class="red">\${t}</li>\`);

        setTimeout(() => {
            document.querySelectorAll('.bucket').forEach(b => b.classList.add('show'));
        }, 100);
    }
</script>
</body>
</html>`);
});

module.exports = app;
app.listen(PORT);