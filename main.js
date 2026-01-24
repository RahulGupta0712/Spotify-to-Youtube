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
const winston = require('winston');
const { WinstonTransport } = require('@axiomhq/winston');
const app = express();
const PORT = process.env.PORT || 3000;

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    defaultMeta: { service: 'tunechange-app' },
    transports: [
        new winston.transports.Console({ format: winston.format.simple() }),
        new WinstonTransport({
            dataset: process.env.AXIOM_DATASET,
            token: process.env.AXIOM_TOKEN,
            orgId: process.env.AXIOM_ORG_ID,
        }),
    ],
});

const auditLog = (event, details) => {
    logger.info(event, {
        ...details,
        timestamp: new Date().toISOString(),
        useCase: 'Spotify-to-YouTube-Migration'
    });
};

// Allow inline scripts for our popup callbacks
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            "default-src": ["'self'"],
            // Allow your inline scripts for the popup callback logic
            "script-src": ["'self'", "'unsafe-inline'"],
            "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            // Allow images from Spotify and Google/YouTube for user profiles
            "img-src": ["'self'", "https://*.scdn.co", "https://*.googleusercontent.com", "https://*.ytimg.com", "data:"]
        }
    },
    crossOriginOpenerPolicy: { policy: "unsafe-none" }
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set('trust proxy', 1);

const isProduction = process.env.NODE_ENV === 'production';

app.use(cookieSession({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'secure_production_secret'],
    maxAge: 60 * 60 * 1000,
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
            
            <h2>7. Operational Logging:</h2> 
            <p>We use Axiom.co to monitor application performance and quota usage. No personally identifiable music history is stored in these logs.</p>
            
            <h2>8. Contact</h2>
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
            if (sRes.ok) {
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
    } catch (e) { res.send('Error logging in'); }
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
    } catch (e) { res.send('Error logging in'); }
});

// --- REAL-TIME CONVERSION ROUTE ---

app.get('/stream-convert', async (req, res) => {
    req.on('close', () => {
        // This stops the server from continuing the loop if the user closes the tab
        console.log("Client closed connection. Stopping migration.");
        res.end();
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const { playlistUrl, existingId } = req.query;

    try {
        let stats = { success: 0, fail: 0, total: 0, quotaEstimated: 0 };

        const playlistId = parseSpotifyPlaylistId(playlistUrl);
        if (!req.session.googleTokens) return send({ error: 'Login to YouTube first' });

        const spToken = req.session.spotifyTokens?.access_token || await getSpotifyAppToken();
        const oauth = makeOAuth2Client();
        oauth.setCredentials(req.session.googleTokens);
        const youtube = google.youtube({ version: 'v3', auth: oauth });

        // Verify user actually has a channel before attempting operations
        try {
            const channelCheck = await youtube.channels.list({ part: 'id', mine: true });
            if (!channelCheck.data.items || channelCheck.data.items.length === 0) {
                return send({ error: "No YouTube Channel found. Please create a channel on YouTube first." });
            }
        } catch (e) {
            return send({ error: "Failed to verify YouTube channel status." });
        }

        let ytId = existingId?.trim();
        if (ytId && ytId.includes('list=')) {
            const urlParams = new URLSearchParams(ytId.split('?')[1]);
            ytId = urlParams.get('list');
        }


        
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
            stats.quotaEstimated += 50; // Cost of creating the playlist itself
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
        stats.total = tracks.length;
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const vid = await searchYouTube(`${track.name} ${track.artist} official audio`);
            if (vid) {
                try {
                    await youtube.playlistItems.insert({
                        part: 'snippet',
                        requestBody: { snippet: { playlistId: ytId, resourceId: { kind: 'youtube#video', videoId: vid } } }
                    });
                    // Inside the loop after a successful YouTube insert:
                    stats.success++;
                    stats.quotaEstimated += 150; // 100 for search + 50 for insert
                    send({ success: true, name: track.name, count: i + 1 });
                } catch (e) {
                    stats.quotaEstimated += 100;
                    if (e.errors && e.errors[0].reason === 'playlistNotFound') return send({ error: "Permission Error: Logged into wrong Brand Account?" });
                    send({ success: false, name: track.name, reason: 'Insert Failed', count: i + 1 });
                }
            } else {
                send({ success: false, name: track.name, reason: 'Not Found', count: i + 1 });
            }
            await new Promise(r => setTimeout(r, 600));
        }
        auditLog('MIGRATION_COMPLETED', {
            successCount: stats.success,
            totalTracks: stats.total,
            estimatedQuota: stats.quotaEstimated
        });
        req.session.spotifyTokens = null;
        send({ done: true, url: `https://www.youtube.com/playlist?list=${ytId}` });
    } catch (err) { send({ error: err.message }); }
    finally { res.end(); }
});

app.get('/', (req, res) => {
    res.send(`<!doctype html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">

    <title>TuneChange - Best Spotify to YouTube Playlist Converter & Migrator</title>
    
    <meta name="description" content="Convert Spotify playlists to YouTube for free. TuneChange is a fast, secure music migrator using Spotify and YouTube APIs to transfer your favorite tracks effortlessly.">
    <meta name="keywords" content="Spotify to YouTube converter, transfer Spotify playlist to YouTube, music migrator, Spotify API, YouTube API, TuneChange playlist transfer">
    <meta name="author" content="TuneChange">
    <link rel="canonical" href="https://tunechange.xyz/" />

    <meta http-equiv="Content-Security-Policy" content="default-src * 'self' 'unsafe-inline' 'unsafe-eval' data: gap: content:; style-src * 'self' 'unsafe-inline'; media-src *; img-src * 'self' data: content: https://i.scdn.co https://*.scdn.co https://*.googleusercontent.com https://*.ytimg.com https://*.ggpht.com https://*.fbsbx.com; frame-src * https://www.youtube.com https://youtube.com https://*.youtube.com;">

    <meta name="google-site-verification" content="uPuIXy59PtPLIaJ5lMmqSb8Rm6X2TJtjyUkzKJ_NE0o" />
    <style>
        :root { 
            --spotify: #1ed760;
            --yt: #ff0000; 
            --bg: #f2f2f7; 
            --glass-surface: rgba(255, 255, 255, 0.65);
            --glass-border: rgba(255, 255, 255, 0.5);
            --glass-highlight: rgba(255, 255, 255, 0.8);
            --text-main: #1d1d1f;
            --text-muted: rgba(0, 0, 0, 0.5);
        }
        *, *::before, *::after {
            box-sizing: border-box;
        }
        body {
            width: 100%;
            overflow-x: hidden; /* Strict horizontal cutoff */
            margin: 0;
            padding: 0;
        }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
            background: var(--bg); 
            color: var(--text-main); 
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            justify-content: center; 
            min-height: 100vh; 
            min-height: 100dvh; /* Mobile browser fix */
            padding: 20px; 
            position: relative;
        }

        body.noscroll {
            overflow: hidden !important;
            height: 100vh;
        }

        /* Ambient Background Orbs for Glass Effect */
        body::before, body::after {
            content: '';
            position: absolute;
            width: 60vw;  /* Changed from 500px to responsive width */
            height: 60vw; /* Changed from 500px to responsive height */
            max-width: 500px; /* Cap it for desktop */
            max-height: 500px;
            border-radius: 50%;
            z-index: -1;
            filter: blur(80px);
            opacity: 0.5;
            pointer-events: none; /* Ensure they don't block clicks */
        }
        body::before {
            background: var(--spotify);
            top: -100px;
            left: -100px;
        }
        body::after {
            background: var(--yt);
            bottom: -100px;
            right: -100px;
        }

        .card { 
            width: 100%; 
            max-width: 500px; 
            /* Glassmorphism Core */
            background: var(--glass-surface);
            backdrop-filter: blur(30px) saturate(180%);
            -webkit-backdrop-filter: blur(30px) saturate(180%);
            border: 1px solid var(--glass-border);
            box-shadow: 0 30px 60px -12px rgba(0, 0, 0, 0.15);
            border-top: 1px solid rgba(255,255,255,0.2);
            
            padding: 40px 30px; 
            border-radius: 32px; 
            position: relative;
            z-index: 1;
        }

        .user-row { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            background: rgba(255, 255, 255, 0.4);
            padding: 12px 16px; 
            border-radius: 16px; 
            margin-bottom: 12px; 
            border: 1px solid rgba(255, 255, 255, 0.6);
            backdrop-filter: blur(10px);
        }

        .app-description { 
            text-align: center; 
            margin-bottom: 30px; 
            border-bottom: 1px solid var(--glass-border); 
            padding-bottom: 20px; 
        }
        .app-description h1 { margin: 0 0 5px 0; font-size: 32px; font-weight: 700; letter-spacing: -0.5px; }
        .app-description h2 { font-size: 15px; color: var(--text-muted); font-weight: 500; margin-bottom: 20px; letter-spacing: 0.5px;}
        .app-description p { color: var(--text-muted); font-size: 14px; line-height: 1.5; margin: 0; font-weight: 400; }
        .highlight-text { color: #000; font-weight: 700; text-shadow: none; }

        .user-row.spotify { border-left: 4px solid var(--spotify); }
        .user-row.youtube { border-left: 4px solid var(--yt); }
        .user-info { display: flex; align-items: center; gap: 12px; }
        .user-info img { width: 36px; height: 36px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.1); }
        .platform-label { font-size: 10px; text-transform: uppercase; color: var(--text-muted); display: block; margin-top: 2px; letter-spacing: 1px;}
        
        .logout { 
            color: rgba(255, 255, 255, 0.8); 
            text-decoration: none; 
            font-size: 11px; 
            background: rgba(255, 68, 68, 0.2); 
            padding: 6px 12px; 
            border-radius: 20px; 
            transition: 0.2s; 
            font-weight: 600;
        }
        .logout:hover { background: #ff4444; color: white; }
        
        /* Inputs - Glass style */
        input { 
            width: 100%; 
            padding: 16px; 
            margin: 10px 0 20px 0; 
            background: rgba(255, 255, 255, 0.5); 
            border: 1px solid var(--glass-border);
            color: #000; 
            border-radius: 16px; 
            box-sizing: border-box; 
            font-size: 14px;
            transition: all 0.3s ease;
            backdrop-filter: blur(5px);
        }

        label {
            margin-left: 5px; 
            font-weight: 600; 
            font-size: 11px !important; 
            letter-spacing: 0.5px; 
            text-transform: uppercase;
        }
        
        input::placeholder { color: rgba(0, 0, 0, 0.4); }

        /* Focus States with Soft Glows */
        input:focus {
            outline: none;
            background: rgba(255, 255, 255, 0.9);
            border-color: rgba(0, 0, 0, 0.2);
            transform: scale(1.01);
        }

        #playlistUrl:focus {
            border-color: var(--spotify) !important;
            box-shadow: 0 0 25px rgba(30, 215, 96, 0.2);
        }

        #existingId:focus {
            border-color: var(--yt) !important;
            box-shadow: 0 0 25px rgba(255, 0, 0, 0.2);
        }
        
        #playlistUrl { border-left: 4px solid var(--spotify); }
        #existingId { border-left: 4px solid var(--yt); }

        /* Buttons - iOS Style */
        button { 
            width: 100%; 
            padding: 16px; 
            border-radius: 16px; 
            border: none; 
            font-weight: 700; 
            font-size: 14px;
            cursor: pointer; 
            transition: transform 0.2s, box-shadow 0.2s; 
            letter-spacing: 0.5px;
        }
        button:active { transform: scale(0.98); }

        /* Progress Bar */
        .progress-container { 
            width: 100%; 
            background: var(--spotify); 
            border-radius: 20px; 
            height: 8px; 
            margin: 25px 0; 
            display: none; 
            overflow: hidden; 
            border: 1px solid rgba(255,255,255,0.05);
        }
        .progress-fill { height: 100%; background: var(--yt); width: 0%; box-shadow: 0 0 10px var(--spotify); transition: width 0.4s ease; }

        /* Log Box - Dark Glass */
        .log-box { 
            background: rgba(255, 255, 255, 0.5);
            padding: 15px; 
            border-radius: 16px; 
            font-family: 'SF Mono', 'Monaco', 'Courier New', monospace; 
            font-size: 11px; 
            height: 150px; 
            overflow-y: auto; 
            margin-top: 15px; 
            border: 1px solid rgba(0, 0, 0, 0.1); 
            color: #333;
            box-shadow: inset 0 2px 10px rgba(0,0,0,0.5);
        }
        
        /* Custom Scrollbar for Log Box */
        .log-box::-webkit-scrollbar { width: 6px; }
        .log-box::-webkit-scrollbar-track { background: transparent; }
        .log-box::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }

        .green { color: var(--spotify); text-shadow: 0 0 10px rgba(30, 215, 96, 0.4); }

        button#convert { 
            background: rgba(255, 255, 255, 0.9); 
            color: black;
            text-transform: uppercase; 
            letter-spacing: 1px;
            box-shadow: 0 0 20px rgba(255, 255, 255, 0.15);
        }
        button#convert:hover {
            background: white;
            box-shadow: 0 0 30px rgba(255, 255, 255, 0.3);
        }

        .footer-links { margin-top: 30px; font-size: 12px; color: var(--text-muted); text-align: center; z-index: 2; position: relative;}
        .footer-links a { color: rgba(0,0,0,0.5); text-decoration: none; margin: 0 10px; transition: color 0.2s;}
        .footer-links a:hover { color: black; text-decoration: none; }

        /* Overlay - Frosted Glass Sheet */
        .results-overlay { 
            position: fixed; 
            top: 0; left: 0; 
            width: 100%; 
            height: 100%; 
            height: 100dvh; /* Mobile layout fix */
            background: rgba(0, 0, 0, 0.9); /* Darker for better contrast */
            backdrop-filter: blur(40px);
            -webkit-backdrop-filter: blur(40px);
            display: none; 
            flex-direction: column; 
            align-items: center; 
            padding: 20px; 
            z-index: 1000;
            overflow-y: auto; 
            -webkit-overflow-scrolling: touch;
            overscroll-behavior: contain; /* Prevents body scroll */
        }

        /* Container for the lists */
        .buckets-container { 
            display: flex; 
            gap: 20px; 
            width: 100%; 
            max-width: 800px; 
            flex-shrink: 0; /* Prevents crushing */
            margin-bottom: 30px;
        }

        .bucket { 
            flex: 1; 
            background: rgba(255, 255, 255, 0.08); 
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 24px; 
            padding: 20px; 
            display: flex; 
            flex-direction: column; 
            max-height: 60vh; /* Don't let lists take over entire screen */
            min-height: 200px;
            color: rgba(255, 255, 255, 0.8);
        }

        /* Mobile Specific Adjustments */
        @media (max-width: 600px) {
            .buckets-container {
                flex-direction: column;
            }
            .bucket {
                max-height: 300px; /* Smaller height on mobile per list */
            }
            .close-btn {
                width: 100%; /* Full width button on mobile */
            }
        }

#final-link {
    width: 100%;
    max-width: 500px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px; /* Gap between Iframe and 'Open App' link */
    flex-shrink: 0;
    margin-bottom: 20px;
}

.close-btn { 
width: 300px;
    background: var(--spotify); 
    color: black; 
    padding: 16px 40px; 
    border-radius: 50px; /* Pill shape */
    font-weight: 800;
    flex-shrink: 0;
    margin-top: 10px;
    box-shadow: 0 10px 20px rgba(30, 215, 96, 0.3);
}
        .results-overlay h1 {
            color: var(--spotify);
            font-size: 24px;
            margin: 10px 0 15px 0;
            flex-shrink: 0; /* Prevent shrinking */
            text-align: center;
        }

       
        
        .bucket h3 { margin-top: 0; font-size: 16px; letter-spacing: 0.5px; border-bottom: 1px solid var(--glass-border); padding-bottom: 10px; }

        .bucket-list { flex: 1; overflow-y: auto; font-size: 13px; list-style: none; padding: 0;  }
        .bucket-list li { padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .bucket-list::-webkit-scrollbar { width: 4px; }
        .bucket-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.3); border-radius: 4px; }


        @media (max-width: 480px) {
            .card { padding: 25px 20px; border-radius: 24px; }
            .app-description h1 { font-size: 24px; }
            .buckets-container { flex-direction: column; height: auto; }
            .bucket { height: 250px; }
        }

        @media (max-width: 768px) {
            input, select, textarea {
                font-size: 16px !important;
            }
        }

        .input-hint {
            display: block;
            font-size: 11px;
            color: var(--text-muted);
            margin-top: -15px; /* Pulls it closer to the input above */
            margin-bottom: 20px;
            padding-left: 5px;
            line-height: 1.4;
        }

        /* Ensure bold text in hints stands out slightly */
        .input-hint b {
            color: var(--text-main);
        }

        /* On mobile, give hints a bit more breathing room */
        @media (max-width: 480px) {
            .input-hint {
                font-size: 10px;
                margin-top: -12px;
            }
        }
    </style>
</head>
<body>
    <div class="card">
        <header class="app-description">
            <h1>TuneChange</h1>
            <h2>The Free Spotify to YouTube Converter</h2>
            <p>
                Switching music platforms? <span class="highlight-text">TuneChange</span> is a specialized migration tool. 
                Our app uses the <span class="highlight-text">Spotify API</span> to securely read your playlist data 
                and the <span class="highlight-text">YouTube API</span> to create high-quality matching playlists 
                directly in your YouTube library. Simple, fast, and automated.
            </p>
        </header>

        <main>
            <div id="profiles"></div>
            <button id="btn_sp" style="background:var(--spotify); color:white; margin-bottom:10px; display:none;">Login with Spotify</button>
            <button id="btn_yt" style="background:var(--yt); color:white; display:none;">Login with YouTube</button>
            
            <label for="playlistUrl" style="font-size: 12px; color: var(--spotify); margin-top: 15px; display: block;">1. Paste Your Spotify Playlist Link</label>
            <input id="playlistUrl" type="url" placeholder="Paste link here...">
            <span class="input-hint">
                Examples: <b>https://open.spotify.com/playlist/...</b> or type <b>LIKED</b> for your liked songs.
            </span>
            
            <label for="existingId" style="font-size: 12px; color: var(--yt); display: block;">2. Target YouTube Playlist (Optional)</label>
            <input id="existingId" type="text" placeholder="Paste link or ID here...">
            <span class="input-hint">
                Leave blank for a new playlist. <br>
                <b>Link: </b>https://www.youtube.com/playlist?list=...<br>
                <b>ID: </b> PL_x6u_8jG0f7H...
            </span>
            
            <div class="progress-container" id="p_container"><div class="progress-fill" id="p_fill"></div></div>
            <button id="convert" style="background:black; color:white; margin-top:20px;">Convert Playlist Now</button>
            <div class="log-box" id="log" aria-live="polite">Status: Ready for migration...</div>
        </main>
    </div>
    <footer class="footer-links">
        <a href="/privacy">Privacy Policy</a> | 
        <a href="/terms">Terms of Service</a> |
        <a href="mailto:viratrahul0718@gmail.com">Support</a>
    </footer>

    <div class="results-overlay" id="overlay" role="dialog" aria-labelledby="migration-done">
        <h1 id="migration-done" class="green">Success! Migration Finished</h1>
        <div id="final-link"></div>
        <div class="buckets-container">
            <div class="bucket"><h3>Tracks Added (<span id="success-count">0</span>)</h3><ul class="bucket-list" id="success-list"></ul></div>
            <div class="bucket"><h3>Not Found (<span id="failed-count">0</span>)</h3><ul class="bucket-list" id="failed-list"></ul></div>
        </div>
        <button class="close-btn" id="reload-page">Start New Migration</button>
    </div>

<script>
    // Ensure the reload button works reliably
    document.getElementById('reload-page').onclick = function() {
        window.location.href = window.location.origin;
    };
    let isConverting = false;

    window.addEventListener('message', (event) => {
        if (event.data.type === 'SPOTIFY_CONNECTED' || event.data.type === 'YOUTUBE_CONNECTED') {
            updateProfiles();
        }
    });

    async function updateProfiles() {
        if (isConverting) return;
        try {
            const res = await fetch('/auth/profiles?t=' + Date.now());
            const data = await res.json();
            const container = document.getElementById('profiles');
            container.innerHTML = '';
            
            let sLinked = !!data.spotify;
            let yLinked = !!data.youtube;

            if(sLinked) {
                document.getElementById('btn_sp').style.display = 'none';
                container.innerHTML += \`
                    <div class="user-row spotify">
                        <div class="user-info">
                            <img src="\${data.spotify.image || ''}" crossorigin="anonymous" onerror="this.src='https://upload.wikimedia.org/wikipedia/commons/9/99/Sample_User_Icon.png'">
                            <div><span class="platform-label">Spotify Account</span>\${data.spotify.name}</div>
                        </div>
                        <a href="/auth/logout/spotify" class="logout">Disconnect</a>
                    </div>\`;
            } else { document.getElementById('btn_sp').style.display = 'block'; }
            
            if(yLinked) {
                document.getElementById('btn_yt').style.display = 'none';
                container.innerHTML += \`
                    <div class="user-row youtube">
                        <div class="user-info">
                            <img src="\${data.youtube.image || ''}" crossorigin="anonymous" onerror="this.src='https://upload.wikimedia.org/wikipedia/commons/9/99/Sample_User_Icon.png'">
                            <div><span class="platform-label">YouTube Account</span>\${data.youtube.name}</div>
                        </div>
                        <a href="/auth/logout/youtube" class="logout">Disconnect</a>
                    </div>\`;
            } else { document.getElementById('btn_yt').style.display = 'block'; }
        } catch (err) { console.error("Error fetching profiles", err); }
    }
    
    updateProfiles();

    function openAuth(url, title) {
        const w = 500, h = 600;
        const left = (screen.width/2)-(w/2);
        const top = (screen.height/2)-(h/2);
        const popup = window.open(url, title, \`width=\${w},height=\${h},top=\${top},left=\${left}\`);
    
        // Check if popup was blocked
        if(!popup || popup.closed || typeof popup.closed=='undefined') { 
            alert("Please enable popups for this site to log in."); 
        }
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
            if(d.error) {
                source.close(); // Close connection first
                alert(d.error); location.reload(); }
        };
    };

    function showOverlay(url, s, f) {
    document.body.classList.add('noscroll');
        document.getElementById('overlay').style.display = 'flex';
        let playlistId = "";
        try {
            // Handle both full URLs and IDs
            if (url.includes('list=')) {
                playlistId = new URL(url).searchParams.get("list");
            } else {
                playlistId = url;
            }
        } catch(e) { console.log("URL parse error", e); }
    
    const currentOrigin = window.location.origin;
    
    document.getElementById('final-link').innerHTML = \`
        <a href="https://www.youtube.com/playlist?list=\${playlistId}" target="_blank" class="logout" style="background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#fff; font-size:13px; padding:10px 20px; width:auto; display:inline-block;">
            Open in YouTube App ↗
        </a>
    \`;
        document.getElementById('success-count').innerText = s.length;
        document.getElementById('failed-count').innerText = f.length;
        // FIX: Clear previous results before adding new ones
    document.getElementById('success-list').innerHTML = '';
    document.getElementById('failed-list').innerHTML = '';
        s.forEach(t => document.getElementById('success-list').innerHTML += \`<li>\${t}</li>\`);
        f.forEach(t => document.getElementById('failed-list').innerHTML += \`<li>\${t}</li>\`);
    }
</script>
</body>
</html>`);
});
app.listen(PORT, () => console.log(`TuneChange running on port ${PORT}`));