/**
 * agent-remote-control daemon — Phase 1
 *
 * Bridges a WebSocket client (the phone) to a named tmux session on this PC.
 * Binds only to the machine's Tailscale IP — never 0.0.0.0.
 *
 * Message schema (all JSON, all have a "type" field):
 *   client → daemon:  { type: "auth",   token: "<AUTH_TOKEN>" }
 *   client → daemon:  { type: "prompt", text:  "<prompt text>" }
 *   daemon → client:  { type: "ready",  session: "<SESSION_NAME>" }
 *   daemon → client:  { type: "output", text:  "<new pane text>" }
 *   daemon → client:  { type: "error",  message: "<reason>" }
 */

'use strict';

require('dotenv').config();
const { WebSocketServer } = require('ws');
const http = require('http');
const fs   = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const AUTH_TOKEN   = process.env.AUTH_TOKEN;
const SESSION_NAME = process.env.SESSION_NAME || 'agent-1';
const PORT         = parseInt(process.env.PORT || '8787', 10);
const BIND_IP      = process.env.BIND_IP;

if (!AUTH_TOKEN) {
  console.error('[daemon] FATAL: AUTH_TOKEN is not set in .env');
  process.exit(1);
}
if (!BIND_IP) {
  console.error('[daemon] FATAL: BIND_IP is not set in .env — run `tailscale ip -4` and set it');
  process.exit(1);
}
if (BIND_IP === '0.0.0.0') {
  console.error('[daemon] FATAL: BIND_IP must not be 0.0.0.0 — set it to your Tailscale IP');
  process.exit(1);
}

const POLL_INTERVAL_MS = 500;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

const server = http.createServer((req, res) => {
  let reqPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(CLIENT_DIR, safePath);

  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };

    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

server.listen(PORT, BIND_IP, () => {
  console.log(`[daemon] Listening on http://${BIND_IP}:${PORT} (Client) and ws://${BIND_IP}:${PORT} (WebSocket)`);
  console.log(`[daemon] Session: ${SESSION_NAME}`);
  console.log(`[daemon] Waiting for phone to connect...`);
});

wss.on('connection', (ws, req) => {
  const remote = req.socket.remoteAddress;
  console.log(`[daemon] Connection from ${remote} — awaiting auth`);

  let authenticated = false;
  let pollTimer     = null;
  let lastCapture   = '';

  // ── Helpers ────────────────────────────────────────────────────────────────

  function send(obj) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function cleanup() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ── tmux helpers ───────────────────────────────────────────────────────────

  /**
   * Run a command via spawn (no shell interpolation) and collect stdout/stderr.
   * Returns a Promise<{ stdout, stderr, code }>.
   */
  function runCommand(cmd, args) {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { shell: false });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => resolve({ stdout, stderr, code }));
    });
  }

  /**
   * Capture the current visible pane text of the tmux session.
   * Returns null if the session doesn't exist or tmux errors.
   */
  async function capturePane() {
    const { stdout, code } = await runCommand('tmux', [
      'capture-pane', '-t', SESSION_NAME, '-p'
    ]);
    if (code !== 0) return null;
    return stdout;
  }

  /**
   * Send keys to the tmux session. text must already be validated/trusted.
   * Uses spawn args array — never shell-interpolates the prompt text.
   */
  async function sendKeys(text) {
    const { code, stderr } = await runCommand('tmux', [
      'send-keys', '-t', SESSION_NAME, text, 'Enter'
    ]);
    if (code !== 0) {
      console.error(`[daemon] tmux send-keys failed (${code}): ${stderr.trim()}`);
      send({ type: 'error', message: `Failed to send to tmux session: ${stderr.trim()}` });
    }
  }

  // ── Diffing helpers ────────────────────────────────────────────────────────

  /**
   * Clean up pane output by stripping trailing whitespace/newlines from terminal grid padding.
   */
  function cleanCapture(raw) {
    if (!raw) return '';
    return raw.replace(/[\r\n\s]+$/, '');
  }

  /**
   * Compute the new appended text between lastClean and currentClean.
   * Returns { isAppend: boolean, diff: string }
   */
  function computeDiff(lastClean, currentClean) {
    if (!lastClean) return { isAppend: false, diff: currentClean };
    if (currentClean === lastClean) return { isAppend: true, diff: '' };

    // Case 1: Direct prefix match (simple append without scroll)
    if (currentClean.startsWith(lastClean)) {
      return { isAppend: true, diff: currentClean.slice(lastClean.length) };
    }

    // Case 2: Overlap match (handles scrolling when top lines roll off)
    for (let i = 1; i < lastClean.length; i++) {
      const suffix = lastClean.slice(i);
      if (currentClean.startsWith(suffix)) {
        return { isAppend: true, diff: currentClean.slice(suffix.length) };
      }
    }

    // Case 3: Full redraw / clear screen
    return { isAppend: false, diff: currentClean };
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  function startPolling() {
    pollTimer = setInterval(async () => {
      const rawCapture = await capturePane();

      if (rawCapture === null) {
        // tmux session is gone
        send({ type: 'error', message: `tmux session '${SESSION_NAME}' not found. Is it still running?` });
        cleanup();
        return;
      }

      const clean = cleanCapture(rawCapture);
      if (clean === lastCapture) {
        // Nothing changed — don't send anything
        return;
      }

      const { diff } = computeDiff(lastCapture, clean);
      lastCapture = clean;

      if (diff.length > 0) {
        send({ type: 'output', text: diff });
      }
    }, POLL_INTERVAL_MS);
  }

  // ── Message handling ───────────────────────────────────────────────────────

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send({ type: 'error', message: 'Message must be valid JSON' });
      return;
    }

    if (!msg.type) {
      send({ type: 'error', message: 'Message missing "type" field' });
      return;
    }

    // ── Auth ────────────────────────────────────────────────────────────────
    if (msg.type === 'auth') {
      if (authenticated) {
        send({ type: 'error', message: 'Already authenticated' });
        return;
      }
      if (msg.token !== AUTH_TOKEN) {
        console.warn(`[daemon] Auth failed from ${remote} — wrong token`);
        ws.close(4401, 'Unauthorized');
        return;
      }

      // Auth ok — verify the tmux session exists before declaring ready
      const capture = await capturePane();
      if (capture === null) {
        send({ type: 'error', message: `tmux session '${SESSION_NAME}' not found. Create it with: tmux new -s ${SESSION_NAME}` });
        ws.close(4404, 'Session not found');
        return;
      }

      authenticated = true;
      lastCapture = cleanCapture(capture);
      console.log(`[daemon] Authenticated: ${remote}`);
      send({ type: 'ready', session: SESSION_NAME });
      startPolling();
      return;
    }

    // ── All other messages require auth ─────────────────────────────────────
    if (!authenticated) {
      ws.close(4401, 'Unauthorized');
      return;
    }

    // ── Prompt ──────────────────────────────────────────────────────────────
    if (msg.type === 'prompt') {
      if (typeof msg.text !== 'string' || msg.text.trim().length === 0) {
        send({ type: 'error', message: '"prompt" message must have a non-empty "text" field' });
        return;
      }
      console.log(`[daemon] Sending prompt to ${SESSION_NAME}: ${msg.text.slice(0, 80)}`);
      await sendKeys(msg.text);
      return;
    }

    // Unknown message type — ignore silently (forward-compat)
    console.warn(`[daemon] Unknown message type: ${msg.type}`);
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────

  ws.on('close', (code, reason) => {
    console.log(`[daemon] Client disconnected (${remote}) — code=${code} reason=${reason.toString()}`);
    cleanup();
  });

  ws.on('error', (err) => {
    console.error(`[daemon] WebSocket error (${remote}):`, err.message);
    cleanup();
  });
});

wss.on('error', (err) => {
  console.error('[daemon] Server error:', err.message);
  process.exit(1);
});
