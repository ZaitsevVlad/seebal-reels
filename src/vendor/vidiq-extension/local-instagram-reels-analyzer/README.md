# Local Instagram Reels Analyzer

Chrome MV3 extension for local Instagram Reels discovery. It injects one button into `instagram.com`, opens a full-screen discovery panel, reads Reels data from the current logged-in Instagram session, and calculates metrics locally.

No vidIQ, analytics, Sentry, Amplitude, or custom backend calls are included.

## Features

- Floating Instagram page button.
- Full-screen discovery panel.
- Load Reels through Instagram same-origin GraphQL pagination, with visible page links/scripts as a fallback.
- Fetch media details through same-origin Instagram web endpoints.
- Local VPH: `plays / max(1, hours since publish)`.
- Local outlier score: `current likes / median likes of creator recent clips`.
- Local filters, sorting, search, built-in presets, and saved custom presets.
- Reel detail modal with stats and source links.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this folder: `local-instagram-reels-analyzer`.
5. Open `https://www.instagram.com/reels/` while logged in.

## Notes

The extension does not send data to a third-party backend. It still calls Instagram endpoints from the Instagram page context because those are the source of Reels views, likes, comments, author and publishing data. Current same-origin endpoints are `/graphql/query`, `/api/v1/media/{id}/info/`, `/api/v1/users/web_profile_info/`, and `/api/v1/clips/user/`.
