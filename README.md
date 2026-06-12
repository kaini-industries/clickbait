# Clickbait

Sight-in & turret assistant for MOA-based rifle and pistol optics. Tap your shots on an interactive splatter target, and Clickbait tells you exactly how many clicks to dial — and in which direction — to zero your optic.

Built as a mobile-first PWA-style web app designed to be used at the range.

## Features

### Zero Tab
- **Interactive splatter target** — tap where your shots landed on a Shoot-N-C-style target, or type offsets manually
- **One-shot mode (default)** — walk your zero in shot-by-shot, with a ghost trail showing convergence; switch to group mode for statistical centroid zeroing
- **Instant click calculations** — converts point-of-impact offset to turret clicks using the selected optic's MOA-per-click value
- **Residual error display** — shows how much offset remains after rounding to the nearest whole click
- **Predicted POI** — visualizes where your next group should land after dialing the recommended adjustment
- **Group size measurement** — calculates extreme spread (max distance between any two shots)
- **Travel limit warning** — alerts you if the needed adjustment exceeds half the turret's total range
- **Turret rotation guidance** — tells you which direction to turn the screw (clockwise/counter-clockwise) for scopes with known rotation conventions
- **Imperial and metric units** — yards/inches or meters/centimeters with appropriate distance and target span presets

### Center Turrets Tab
- **Guided centering procedure** — step-by-step walkthrough to find the mechanical center of each turret
- **Click counter** — large tap-friendly +1/+10/-1 buttons for counting clicks from stop to stop
- **Automatic halfway calculation** — divides your total count by 2 and tells you how far to come back

### Adjustment Log
- **Timestamped history** — every adjustment you stamp is logged with optic name, distance, elevation/windage clicks, and group size
- **Persistent across sessions** — all data stored in localStorage

### Optic Profiles
- **Built-in presets** — Holosun HS507C-X2 (1 MOA/click) and Primary Arms SLx 3x32 Gen III (0.25 MOA/click)
- **Custom optics** — add your own with configurable MOA-per-click and total travel range
- **Non-destructive editing** — editing a built-in preset automatically clones it so defaults can always be restored

## The Math

The core calculation converts a linear offset (inches or centimeters) to turret clicks:

```
perClick = clickMOA × perMOA(distance)
clicks   = round(offset / perClick)
```

Where `perMOA(distance)` returns the linear size of 1 MOA at the shooting distance:
- **Imperial:** 1.047 × distance_yd / 100 (inches)
- **Metric:** 2.908 × distance_m / 100 (centimeters)

Direction follows the standard "chase the bullet hole" rule — if the shot is low, dial up; if the shot is left, dial right.

## Tech Stack

- [Next.js](https://nextjs.org) 16 (App Router)
- [React](https://react.dev) 19
- No external UI libraries — all styles are inline
- Google Fonts: Saira Condensed (headings) and IBM Plex Mono (data)
- localStorage for persistence (no backend)

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Build for Production

```bash
npm run build
npm start
```

## Deploy

Deploys to any platform that supports Next.js — Vercel, Netlify, Docker, or a static export via `next build`.

## License

Private — not currently licensed for redistribution.
