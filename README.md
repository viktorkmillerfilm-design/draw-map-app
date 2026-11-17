# Draw Map

A mobile-first map drawing web app (PWA) for iPhone Safari and Chrome, and any modern browser. Drawings are real map features, so they stay in place when you pan or zoom.

Default view: Vienna, Austria.

## Open it on your iPhone

This is a website you can add to your Home Screen. It cannot be installed inside the official Google Maps app.

1. Host the `draw-map-app` folder over **HTTPS** (see below), or open it on the same Wi-Fi from a local computer.
2. **Safari:** open the site, tap the Share button, then **Add to Home Screen**.
3. **Chrome on iPhone:** open the site, tap the menu, then **Add to Home Screen**. If that item is missing, open the same URL in Safari and add it from there. Chrome on iOS uses the same WebKit engine as Safari.

Geolocation, the home-screen app, and offline app-shell caching need HTTPS (or localhost).

## Use it locally

Serve the folder (do not open `index.html` as a `file://` URL if you want search, location, or the service worker):

```bash
cd draw-map-app
python3 -m http.server 8080
```

Then visit `http://localhost:8080` on the same computer, or `http://YOUR-LAN-IP:8080` from your iPhone on the same network.

## Features

- Streets (OpenStreetMap) and Satellite (Esri World Imagery)
- Pan mode (one-finger pan and pinch-zoom) vs draw mode
- Freehand pen, straight path, polygon/area, rectangle, circle, labeled pin
- Eraser, undo, clear all
- Color and stroke width
- Metric distance and area labels
- Locate me
- Place search (Nominatim / OpenStreetMap)
- Auto-save in this browser (`localStorage`)
- Export / import GeoJSON
- Export a PNG screenshot (share or download)
- **Open in Google Maps** jumps to the current map center
- **Draw my route:** sketch a rough path, snap it to the closest walk / bike / car route, then Keep it, export GPX, or open turn-by-turn directions in Google Maps

## Hosting (free)

No account was created from this project. Easy options:

### Netlify Drop (no repo required)

1. Open [https://app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag the `draw-map-app` folder onto the page
3. Copy the `https://….netlify.app` URL to your iPhone

A Netlify account is optional for a short-lived drop; signing in keeps the site up.

### GitHub Pages

1. Create a GitHub repository and upload the contents of `draw-map-app` (not the parent zip only)
2. Settings → Pages → deploy from the `main` branch root (or `/docs`)
3. After a minute, open `https://YOUR-USER.github.io/REPO/`

### Other

- Cloudflare Pages and Vercel also serve static folders over HTTPS for free after you create an account.

## Notes and limits

- Map tiles and place search need a network connection. The service worker caches the app shell only, not tiles (OpenStreetMap tile policy).
- Place search uses Nominatim and is for light, interactive use.
- PNG export redraws tiles from a CORS-friendly source. Street-map screenshots may use CARTO Voyager tiles under your drawings (OpenStreetMap tiles do not allow canvas export). Satellite screenshots use Esri.
- Drawings are stored only in this browser, not in Google Maps.
- **Draw my route** uses public OSRM servers (car: router.project-osrm.org, with a fallback host; walk/bike: routing.openstreetmap.de). Those services can be slow or temporarily unavailable, and they are for light interactive use. Requests time out and retry with backoff; an in-flight snap is cancelled if you start another. Matching keeps sharp turns, uses zoom-tuned radiuses (capped at about 40 m), can split long sketches into chunks, and picks the candidate (match or route-through-waypoints) with the lowest deviation from your sketch. A fit score is shown on the route card. Google Maps directions get the start, end, and up to 8 midpoints of the snapped route, so the path in Google Maps may be a simplified version of what you drew.
- Tiles may be cached on-device in a size-capped service-worker store so the map feels faster on repeat visits. Routing and search still need a network connection; an offline banner appears when you lose one.
