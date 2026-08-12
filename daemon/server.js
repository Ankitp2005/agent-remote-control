/**
 * agent-remote-control daemon — Phase 2
 *
 * Bridges a WebSocket client (the phone) to tmux sessions on this PC.
 * Supports dynamic session discovery, switching, and per-session output streaming.
 * Binds only to the machine's Tailscale IP — never 0.0.0.0.
 *
 * Message schema (all JSON, all have a "type" field):
 *   client → daemon:  { type: "auth",          token: "<AUTH_TOKEN>" }
 *   client → daemon:  { type: "list_sessions" }
 *   client → daemon:  { type: "subscribe",     session: "<SESSION_NAME>" }
 *   client → daemon:  { type: "prompt",        session: "<SESSION_NAME>", text: "<prompt text>" }
 *   daemon → client:  { type: "ready" }
 *   daemon → client:  { type: "sessions",      sessions: ["agent-1", ...] }
 *   daemon → client:  { type: "output",        session: "<SESSION_NAME>", text: "<new pane text>" }
 *   daemon → client:  { type: "error",         message: "<reason>" }
 */

'use strict';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
console.log('[daemon] DNS result order set to ipv4first');

// ─── Process-level error handlers (surface crashes instead of silent exit) ────
process.on('uncaughtException', (err) => {
  console.error('[daemon] UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[daemon] UNHANDLED REJECTION:', reason);
});

require('dotenv').config();
const { WebSocketServer } = require('ws');
const { spawn }           = require('child_process');
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const AUTH_TOKEN = process.env.AUTH_TOKEN;
const PORT       = parseInt(process.env.PORT || '8787', 10);
const BIND_IP    = process.env.BIND_IP;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

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

// ─── Approval Pattern Detection Setup (Phase 3) ──────────────────────────────
const patternsPath = path.join(__dirname, 'patterns.json');
let patternsRegex = [];
try {
  if (fs.existsSync(patternsPath)) {
    const rawPatterns = JSON.parse(fs.readFileSync(patternsPath, 'utf8'));
    patternsRegex = rawPatterns.map((p) => new RegExp(p, 'i'));
    console.log(`[daemon] Loaded ${patternsRegex.length} approval patterns from patterns.json`);
  } else {
    console.warn('[daemon] patterns.json not found — approval detection disabled');
  }
} catch (err) {
  console.error('[daemon] Failed to load patterns.json:', err.message);
}

// ─── State ───────────────────────────────────────────────────────────────────

// Keyed by session name -> { lastCapture: string, waiting: boolean }
const sessionState = new Map();

// Keyed by session name -> Set<ws>
const subscriptions = new Map();

// ─── HTTP Server (Client Static Assets) ──────────────────────────────────────

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

// ─── WebSocket Heartbeat (ping/pong every 30s) ────────────────────────────────
// Daemon sends protocol-level ws.ping() every 30s. Browsers automatically respond
// with protocol-level PONG frames. If a client misses a full 30s cycle, it is terminated.
const HEARTBEAT_INTERVAL_MS = 30000;

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`[daemon] Heartbeat timeout — terminating dead connection`);
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, BIND_IP, () => {
  console.log(`[daemon] Listening on http://${BIND_IP}:${PORT} (Client) and ws://${BIND_IP}:${PORT} (WebSocket)`);
  console.log(`[daemon] Session discovery enabled — dynamic tmux session management`);
  if (NTFY_TOPIC && NTFY_TOPIC.trim()) {
    console.log(`[daemon] Approval push notifications enabled (ntfy topic: ${NTFY_TOPIC.trim()})`);
  } else {
    console.log(`[daemon] Approval push notifications disabled (NTFY_TOPIC not set in .env)`);
  }
  console.log(`[daemon] Waiting for client connection...`);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/**
  * Broadcast JSON message to all authenticated connected clients.
  */
function broadcast(obj) {
  const json = JSON.stringify(obj);
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN && ws.authenticated) {
      ws.send(json);
    }
  });
}

/**
  * Send a push notification to ntfy.sh if NTFY_TOPIC is configured.
  */
async function sendNtfyNotification(sessionName, matchedLine) {
  if (!NTFY_TOPIC || !NTFY_TOPIC.trim()) return;
  const topic = NTFY_TOPIC.trim();
  const bodyText = (matchedLine || '').slice(0, 200);

  return new Promise((resolve) => {
    try {
      console.log(`[daemon] Sending ntfy notification for session '${sessionName}': "${bodyText.slice(0, 60)}"`);
      const postData = Buffer.from(bodyText, 'utf8');

      const req = https.request({
        hostname: 'ntfy.sh',
        port: 443,
        path: `/${topic}`,
        method: 'POST',
        family: 4,
        headers: {
          'Title': `${sessionName} needs you`,
          'Content-Type': 'text/plain',
          'Content-Length': postData.length
        }
      }, (res) => {
        res.resume(); // consume response body
        resolve();
      });

      req.on('error', (err) => {
        console.error(`[daemon] Failed to send ntfy notification for session '${sessionName}':`, err.message, '| Cause:', err.cause || err);
        resolve();
      });

      req.write(postData);
      req.end();
    } catch (err) {
      console.error(`[daemon] Failed to send ntfy notification for session '${sessionName}':`, err.message, '| Cause:', err.cause || err);
      resolve();
    }
  });
}

/**
  * Check terminal output against approval patterns and handle waiting state transitions.
  */
function checkApprovalWaiting(sessionName, clean) {
  if (patternsRegex.length === 0) return;

  const state = sessionState.get(sessionName) || { lastCapture: '', waiting: false };
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lastLines = lines.slice(-3);

  let matchedLine = null;
  for (const line of lastLines) {
    if (patternsRegex.some((regex) => regex.test(line))) {
      matchedLine = line;
      break;
    }
  }

  const isMatching = matchedLine !== null;
  const wasWaiting = !!state.waiting;

  if (isMatching && !wasWaiting) {
    state.waiting = true;
    sessionState.set(sessionName, state);
    console.log(`[daemon] Session '${sessionName}' entered WAITING state: "${matchedLine.slice(0, 80)}"`);
    sendNtfyNotification(sessionName, matchedLine);
    broadcast({ type: 'waiting', session: sessionName, waiting: true });
  } else if (!isMatching && wasWaiting) {
    state.waiting = false;
    sessionState.set(sessionName, state);
    console.log(`[daemon] Session '${sessionName}' cleared WAITING state`);
    broadcast({ type: 'waiting', session: sessionName, waiting: false });
  }
}

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
    proc.on('error', (err) => resolve({ stdout: '', stderr: err.message, code: -1 }));
  });
}

/**
 * List all running tmux session names.
 * Returns Promise<Array<string>>.
 */
async function listSessions() {
  const { stdout, code } = await runCommand('tmux', [
    'list-sessions', '-F', '#{session_name}'
  ]);
  if (code !== 0 || !stdout.trim()) return [];
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Capture the current visible pane text of a tmux session.
 * Returns null if the session doesn't exist or tmux errors.
 */
async function capturePane(sessionName) {
  if (!sessionName) return null;
  const { stdout, code } = await runCommand('tmux', [
    'capture-pane', '-t', sessionName, '-p'
  ]);
  if (code !== 0) return null;
  return stdout;
}

/**
 * Send keys to a tmux session. text must already be validated/trusted.
 * Uses spawn args array — never shell-interpolates the prompt text.
 */
async function sendKeys(sessionName, text) {
  return await runCommand('tmux', [
    'send-keys', '-t', sessionName, text, 'Enter'
  ]);
}

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

// ─── Subscription Helpers ────────────────────────────────────────────────────

async function sendSessionsList(ws) {
  const sessions = await listSessions();
  send(ws, { type: 'sessions', sessions });
}

function unsubscribeClient(ws) {
  const oldSession = ws.subscribedSession;
  if (!oldSession) return;

  ws.subscribedSession = null;
  const clientSet = subscriptions.get(oldSession);
  if (clientSet) {
    clientSet.delete(ws);
    if (clientSet.size === 0) {
      subscriptions.delete(oldSession);
      sessionState.delete(oldSession);
    }
  }
}

async function subscribeClient(ws, sessionName) {
  unsubscribeClient(ws);

  const rawCapture = await capturePane(sessionName);
  if (rawCapture === null) {
    send(ws, { type: 'error', message: `Session '${sessionName}' not found` });
    return;
  }

  if (!subscriptions.has(sessionName)) {
    subscriptions.set(sessionName, new Set());
  }
  subscriptions.get(sessionName).add(ws);
  ws.subscribedSession = sessionName;

  const clean = cleanCapture(rawCapture);
  const existingState = sessionState.get(sessionName);
  sessionState.set(sessionName, {
    lastCapture: clean,
    waiting: existingState ? !!existingState.waiting : false
  });

  // Send immediate initial output frame with current full pane content
  send(ws, { type: 'output', session: sessionName, text: clean });
}

// ─── Global Session Polling Loop ──────────────────────────────────────────────

setInterval(async () => {
  try {
    if (subscriptions.size === 0) return;

    for (const [sessionName, clientSet] of subscriptions.entries()) {
      if (clientSet.size === 0) {
        const state = sessionState.get(sessionName);
        if (state && state.waiting) {
          broadcast({ type: 'waiting', session: sessionName, waiting: false });
        }
        subscriptions.delete(sessionName);
        sessionState.delete(sessionName);
        continue;
      }

      const rawCapture = await capturePane(sessionName);

      if (rawCapture === null) {
        // Session disappeared or was killed on the PC
        const state = sessionState.get(sessionName);
        if (state && state.waiting) {
          broadcast({ type: 'waiting', session: sessionName, waiting: false });
        }
        const errorMsg = { type: 'error', message: `Session '${sessionName}' not found` };
        for (const client of clientSet) {
          client.subscribedSession = null;
          send(client, errorMsg);
        }
        subscriptions.delete(sessionName);
        sessionState.delete(sessionName);
        continue;
      }

      const clean = cleanCapture(rawCapture);

      // Check approval patterns and emit waiting transitions
      checkApprovalWaiting(sessionName, clean);

      const state = sessionState.get(sessionName) || { lastCapture: '', waiting: false };

      if (clean === state.lastCapture) {
        continue;
      }

      const { diff } = computeDiff(state.lastCapture, clean);
      state.lastCapture = clean;
      sessionState.set(sessionName, state);

      if (diff.length > 0) {
        const outputMsg = { type: 'output', session: sessionName, text: diff };
        for (const client of clientSet) {
          send(client, outputMsg);
        }
      }
    }
  } catch (err) {
    console.error('[daemon] Error in polling loop:', err);
  }
}, POLL_INTERVAL_MS);

// ─── Connection Lifecycle ─────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const remote = req.socket.remoteAddress;
  console.log(`[daemon] Connection from ${remote} — awaiting auth`);

  // Mark connection alive; reset on each pong received from client
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let authenticated = false;

  ws.on('message', async (raw) => {
    ws.isAlive = true;
    try {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', message: 'Message must be valid JSON' });
        return;
      }

      if (!msg.type) {
        send(ws, { type: 'error', message: 'Message missing "type" field' });
        return;
      }

      // ── Auth ──────────────────────────────────────────────────────────────────
      if (msg.type === 'auth') {
        if (authenticated) {
          send(ws, { type: 'error', message: 'Already authenticated' });
          return;
        }
        if (msg.token !== AUTH_TOKEN) {
          console.warn(`[daemon] Auth failed from ${remote} — wrong token`);
          ws.close(4401, 'Unauthorized');
          return;
        }

        authenticated = true;
        ws.authenticated = true;
        console.log(`[daemon] Authenticated: ${remote}`);
        send(ws, { type: 'ready' });
        await sendSessionsList(ws);
        return;
      }

      // ── All other messages require auth ───────────────────────────────────────
      if (!authenticated) {
        ws.close(4401, 'Unauthorized');
        return;
      }

      // ── List sessions ─────────────────────────────────────────────────────────
      if (msg.type === 'list_sessions') {
        await sendSessionsList(ws);
        return;
      }

      // ── Ping ──────────────────────────────────────────────────────────────────
      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }

      // ── Subscribe ─────────────────────────────────────────────────────────────
      if (msg.type === 'subscribe') {
        if (typeof msg.session !== 'string' || !msg.session.trim()) {
          send(ws, { type: 'error', message: '"subscribe" message must have a non-empty "session" field' });
          return;
        }
        await subscribeClient(ws, msg.session.trim());
        return;
      }

      // ── Prompt ────────────────────────────────────────────────────────────────
      if (msg.type === 'prompt') {
        if (typeof msg.session !== 'string' || !msg.session.trim()) {
          send(ws, { type: 'error', message: '"prompt" message must have a non-empty "session" field' });
          return;
        }
        if (typeof msg.text !== 'string' || msg.text.trim().length === 0) {
          send(ws, { type: 'error', message: '"prompt" message must have a non-empty "text" field' });
          return;
        }

        const targetSession = msg.session.trim();
        const rawCapture = await capturePane(targetSession);
        if (rawCapture === null) {
          send(ws, { type: 'error', message: `Session '${targetSession}' not found` });
          return;
        }

        console.log(`[daemon] Sending prompt to ${targetSession}: ${msg.text.slice(0, 80)}`);
        const { code, stderr } = await sendKeys(targetSession, msg.text);
        if (code !== 0) {
          console.error(`[daemon] tmux send-keys failed (${code}): ${stderr.trim()}`);
          send(ws, { type: 'error', message: `Failed to send to tmux session: ${stderr.trim()}` });
        }
        return;
      }

      // Unknown message type — ignore silently (forward-compat)
      console.warn(`[daemon] Unknown message type: ${msg.type}`);
    } catch (err) {
      console.error(`[daemon] Error processing message from ${remote}:`, err);
      send(ws, { type: 'error', message: 'Internal daemon error processing message' });
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[daemon] Client disconnected (${remote}) — code=${code} reason=${reason.toString()}`);
    unsubscribeClient(ws);
  });

  ws.on('error', (err) => {
    console.error(`[daemon] WebSocket error (${remote}):`, err.message);
    unsubscribeClient(ws);
  });
});

wss.on('error', (err) => {
  console.error('[daemon] Server error:', err.message);
  process.exit(1);
});
