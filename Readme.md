Spotify → YouTube Playlist Converter

This lightweight Node.js + Express app converts a public Spotify playlist into a YouTube playlist in the signed-in user’s YouTube account. It fetches tracks from Spotify (Client Credentials flow), searches YouTube for the closest/highest-viewed video for each track (uses an optional `YOUTUBE_API_KEY` for faster search), and creates a new playlist via Google OAuth2 so videos are added directly to the user’s channel.

Features
- Accepts a Spotify playlist URL and extracts tracks (handles pagination).
- Searches YouTube for best-match videos (top result by view count).
- Performs Google OAuth2 flow to create a YouTube playlist and add videos.
- Minimal frontend at `/` to paste a playlist URL and trigger conversion.
- Session-based token storage and helpful console logging for debugging.

Requirements
- Node.js (v14+ recommended)
- Spotify app credentials (Client ID & Secret)
- Google OAuth Client (YouTube Data API v3 enabled) — Client ID & Secret
- Optional: `YOUTUBE_API_KEY` to perform API searches without quota-heavy OAuth calls
- Environment variables stored in a .env file (see main.js for expected keys)

Quick Setup
1. Install deps:
   npm install
2. Create .env with:
   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI (e.g., http://localhost:3000/oauth2callback), YOUTUBE_API_KEY (optional), SESSION_SECRET, PORT
3. Run:
   node main.js
4. Open `http://localhost:3000`, paste Spotify playlist URL, sign into Google when prompted, and convert.

Notes & Security
- This app requires valid OAuth credentials and explicit user consent; it never stores Google passwords.
- For public deployments, secure sessions and HTTPS are required; consider storing refresh tokens securely.
- YouTube has limits and content policies — conversions may fail for unavailable or region-restricted videos.

Files of interest
- main.js — server logic and conversion flow
- .env — environment configuration
- Frontend served at `/` for quick use
