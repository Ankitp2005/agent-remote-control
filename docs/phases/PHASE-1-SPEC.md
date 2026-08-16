# Phase 1 spec: daemon + phone client, single hardcoded session

## Goal
Prove the full pipe works: a prompt typed on the phone reaches a tmux
session running an agent CLI, and the agent's output streams back to the
phone. One session, hardcoded, no session picker yet.

## Prerequisites (manual, not code)
- Tailscale installed and connected on both the PC and the phone. Confirm
  the PC's Tailscale IP with `tailscale ip -4`.
- A tmux session already running an agent CLI:
  `tmux new -s agent-1` then start Codex CLI (or whichever) inside it.
- Node.js installed on the PC.

## File layout
```
/daemon
  package.json
  server.js          # entry point
  .env                # AUTH_TOKEN=<random string>, not committed
/client
  index.html
  app.js
  manifest.json       # PWA manifest
```

## Daemon requirements

### Dependencies
- `ws` (WebSocket server)
- `dotenv` (load AUTH_TOKEN from .env)
- No other dependencies. Do not add express, socket.io, or a database.

### Config
- Reads `AUTH_TOKEN` from `.env`. This is a shared secret the phone client
  must send to connect. Generate it once, put it in `.env`, and paste the
  same value into the phone client's settings (a simple text field stored
  in `localStorage` is fine for this phase — see client section below,
  note this is NOT browser storage inside a Claude artifact, this is a
  real PWA the user runs on their own device/hosting).
- Reads `SESSION_NAME` from `.env`, defaulting to `agent-1`. This is the
  hardcoded tmux session name for phase 1.
- Listens on a port (default `8787`) bound explicitly to the machine's
  Tailscale IP address, read from `tailscale ip -4` output or set manually
  in `.env` as `BIND_IP`. Never bind to `0.0.0.0`.

### WebSocket message schema
All messages are JSON. Every message has a `type` field.

**Client -> daemon, on connect:**
```json
{ "type": "auth", "token": "<AUTH_TOKEN value>" }
```
Daemon closes the connection immediately if the token doesn't match.

**Client -> daemon, sending a prompt:**
```json
{ "type": "prompt", "text": "add a health check endpoint" }
```
Daemon behavior: run `tmux send-keys -t <SESSION_NAME> "<text>" Enter`.
Escape the text safely for shell (use `child_process.spawn` with an args
array, not string interpolation into a shell command, to avoid injection
from the prompt text itself).

**Daemon -> client, streaming output:**
```json
{ "type": "output", "text": "<new pane content since last poll>" }
```
Sent whenever polling detects new content (see polling logic below).

**Daemon -> client, connection acknowledged:**
```json
{ "type": "ready", "session": "agent-1" }
```
Sent once immediately after successful auth.

**Daemon -> client, error:**
```json
{ "type": "error", "message": "<human readable reason>" }
```

### Polling logic
- Every 500ms, run `tmux capture-pane -t <SESSION_NAME> -p` to get the
  current visible pane text.
- Keep the last captured text in memory. Diff: if the new capture is
  longer than the last one and starts with the same content, send only
  the appended suffix as an `output` message. If the content changed in a
  way that isn't a simple append (e.g. screen redraw, clear), send the
  full new capture instead — don't try to be clever about partial diffs
  in phase 1.
- If `tmux capture-pane` errors (session doesn't exist), send an `error`
  message and stop polling until the client reconnects.

## Client requirements

### `index.html`
- One text input for the prompt, one send button, one scrolling `<pre>`
  or `<div>` for output. That's the entire UI for phase 1. No styling
  polish needed yet — function first.
- A settings area (can be a simple prompt() or a small form) to enter the
  daemon's Tailscale IP, port, and AUTH_TOKEN once. Store in
  `localStorage` (this is a real browser running on the user's own phone,
  not a Claude.ai artifact — localStorage is fine and expected here).

### `app.js`
- On load, read connection details from `localStorage`. If missing, show
  the settings form.
- Open a WebSocket to `ws://<ip>:<port>`. On open, send the `auth`
  message immediately.
- On receiving `ready`, enable the prompt input.
- On receiving `output`, append the text to the output pane and
  auto-scroll to bottom.
- On receiving `error`, show it visibly (not just console.log).
- On send button click, send a `prompt` message with the input's text,
  then clear the input.
- Handle WebSocket `close`/`error` events by showing a "disconnected,
  retrying..." state and attempting reconnect every 3 seconds.

### `manifest.json`
- Minimal PWA manifest so the client can be "added to home screen" on the
  phone. Name, short_name, start_url, display: "standalone". No icons
  needed for phase 1 (use a placeholder or skip icon fields).

## Acceptance criteria (verify all of these manually before phase 2)
1. Starting the daemon with `node server.js` connects successfully and
   logs the bound Tailscale IP and port.
2. Opening the client on the phone (added to home screen or just in
   mobile Safari/Chrome) and entering the correct IP/port/token connects
   and shows the `ready` state.
3. Typing a prompt on the phone and sending it causes the tmux session
   (visible if you also have a terminal open on the PC) to receive that
   text and the agent to respond to it.
4. The agent's response text appears on the phone's output pane within
   ~1 second of appearing in the actual tmux pane.
5. Killing the phone's wifi and turning it back on causes the client to
   reconnect on its own within a few seconds, without losing the tmux
   session's state (the agent is still running, still mid-conversation).
6. Connecting with a wrong or missing AUTH_TOKEN is rejected by the
   daemon and does not reach the `ready` state.

## What NOT to build in phase 1
- No session picker or session list (hardcoded single session only).
- No approval/waiting-state detection.
- No push notifications.
- No React/build tooling on the client.
- No database or persistent config beyond the `.env` file and
  `localStorage`.