# Phase 1 Notes & Implementation Summary

## Overview

Phase 1 establishes the core pipe: sending prompts from a mobile browser over a private Tailscale network into a named `tmux` session on a host machine, and streaming terminal pane outputs back in real time.

All core requirements from [`PHASE-1-SPEC.md`](./phase-1-spec.md) were built, manually tested, verified end-to-end on a mobile device, and committed to git.

---

## What Was Built

### 1. Daemon (`/daemon`)
- **[daemon/server.js](file:///c:/Users/Ankit%20pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/daemon/server.js)**: 
  - Listens strictly on the host's Tailscale IPv4 interface (`BIND_IP`).
  - Authenticates WebSocket connections against `AUTH_TOKEN` from `.env`.
  - Executes prompts safely via `tmux send-keys` using `child_process.spawn` (args array, no shell interpolation).
  - Polls `tmux capture-pane` every 500ms, diffs changes, and streams `type: "output"` JSON frames.
  - Serves `/client` PWA static assets over HTTP natively (zero external npm dependencies added).
- **[daemon/package.json](file:///c:/Users/Ankit%20pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/daemon/package.json)**: Only `ws` and `dotenv` as dependencies.
- **[daemon/.env.example](file:///c:/Users/Ankit%20pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/daemon/.env.example)** & **[daemon/.gitignore](file:///c:/Users/Ankit%20pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/daemon/.gitignore)**: Prevents accidental token commits.

### 2. Client (`/client`)
- **[client/index.html](file:///c:/Users/Ankit%20pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/client/index.html)**: Clean, single-page mobile layout with header status badge, output pane, prompt input form, and settings modal.
- **[client/styles.css](file:///c:/Users/Ankit%20pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/client/styles.css)**: Responsive dark-mode terminal theme with mobile tap target optimizations.
- **[client/app.js](file:///c:/Users/Ankit%20pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/client/app.js)**: Connection management, `localStorage` persistence (`arc_daemon_ip`, `arc_daemon_port`, `arc_daemon_token`), WebSocket auth handshake, live autoscrolling terminal output, error banners, and 3-second auto-reconnect logic.
- **[client/manifest.json](file:///c:/Users/Ankit%20pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/client/manifest.json)** & **[client/sw.js](file:///c:/Users/Ankit%20pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/client/sw.js)**: PWA manifest for standalone "Add to Home Screen" installation on mobile devices.

---

## Deviations from `PHASE-1-SPEC.md`

### 1. Integrated HTTP Static Asset Server
- **Spec**: Spec described `/client` as a set of static files but did not specify how the phone would fetch `index.html`.
- **Implementation**: `server.js` was enhanced to attach `WebSocketServer` to a native Node `http.Server`. HTTP GET requests to `http://BIND_IP:PORT/` serve `/client` files (`index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js`), while WebSocket upgrade requests handle `ws://` traffic on the exact same port.
- **Rationale**: Allowed loading the mobile client directly on the phone browser over Tailscale without introducing an extra web server (Nginx/Apache) or external npm frameworks like Express.

### 2. Windows / WSL2 Host Execution
- **Spec**: Assumed a Linux/Unix environment where `tmux` runs natively.
- **Implementation**: On Windows 11, the daemon and `tmux` session run inside **WSL2 (Ubuntu)** with Tailscale installed inside WSL to acquire a direct `100.x.x.x` virtual network interface (`BIND_IP`).

---

## Unexpected Findings: `tmux capture-pane` Output & The Diffing Bug

### The Issue
During initial testing with `wscat`, prompt execution triggered full pane scrollbacks with repeated past commands in the `output` stream instead of sending only newly appended text.

### Root Cause Analysis
1. **Terminal Grid Padding**: Running `tmux capture-pane -t <session> -p` returns the entire terminal screen grid (e.g. 24 vertical lines). Empty lines at the bottom of the grid are padded with trailing newlines/whitespace (`\n\n\n...`).
2. **Failure of Naive `startsWith`**: When text was typed into the prompt line (e.g. at line 8), the content changed *before* the trailing grid newlines. Because the trailing newlines were part of `lastCapture`, `capture.startsWith(lastCapture)` evaluated to `false`.
3. **Scrollback Fallback**: Falling back to `else { diff = capture; }` caused the daemon to resend the entire 24-line screen capture on every poll.

### Solution Implemented in `server.js`
1. **Grid Whitespace Cleaning (`cleanCapture`)**:
   ```javascript
   function cleanCapture(raw) {
     if (!raw) return '';
     return raw.replace(/[\r\n\s]+$/, '');
   }
   ```
2. **Suffix-Prefix Overlap Matching (`computeDiff`)**:
   - Strips trailing grid padding before comparing captures.
   - If `currentClean.startsWith(lastClean)` matches, slices exact suffix.
   - If lines scroll off the top of the terminal (when screen height fills up), finds the longest matching suffix of `lastClean` that forms a prefix of `currentClean`.
   - Only falls back to full redraw when screen is explicitly cleared or redrawn.

---

## Acceptance Verification Results

- [x] **Daemon Startup**: `node server.js` binds to Tailscale IP and logs listening status.
- [x] **Auth Gate**: Rejects invalid tokens with `4401 Unauthorized`; accepts valid tokens and sends `ready`.
- [x] **`tmux` Prompt Execution**: Prompts sent via WebSocket execute in target `tmux` session via `spawn`.
- [x] **Real-time Output Streaming**: Clean, diffed terminal pane output streams to mobile client.
- [x] **Mobile PWA Verification**: Tested end-to-end on Android Chrome over Tailscale connection.
