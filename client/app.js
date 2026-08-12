/**
 * Agent Remote Control - Mobile PWA Client (Phase 2)
 */

'use strict';

// ─── Storage Keys ─────────────────────────────────────────────────────────────
const STORAGE_IP = 'arc_daemon_ip';
const STORAGE_PORT = 'arc_daemon_port';
const STORAGE_TOKEN = 'arc_daemon_token';
const STORAGE_SESSION = 'arc_last_session';

// ─── DOM Elements ─────────────────────────────────────────────────────────────
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const errorBanner = document.getElementById('error-banner');
const errorMessage = document.getElementById('error-message');
const dismissErrorBtn = document.getElementById('dismiss-error-btn');
const outputPane = document.getElementById('output-pane');
const promptForm = document.getElementById('prompt-form');
const promptInput = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');

const sessionSelect = document.getElementById('session-select');
const refreshSessionsBtn = document.getElementById('refresh-sessions-btn');

const openSettingsBtn = document.getElementById('open-settings-btn');
const cancelSettingsBtn = document.getElementById('cancel-settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsForm = document.getElementById('settings-form');
const settingIp = document.getElementById('setting-ip');
const settingPort = document.getElementById('setting-port');
const settingToken = document.getElementById('setting-token');

// ─── State ───────────────────────────────────────────────────────────────────
let socket = null;
let reconnectTimer = null;
let isAuthenticated = false;
let currentSession = null;
let availableSessions = [];

// ─── PWA Service Worker Registration ──────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('PWA service worker registration failed:', err);
    });
  });
}

// ─── Settings Management ─────────────────────────────────────────────────────
function getSettings() {
  return {
    ip: localStorage.getItem(STORAGE_IP) || '',
    port: localStorage.getItem(STORAGE_PORT) || '8787',
    token: localStorage.getItem(STORAGE_TOKEN) || '',
    lastSession: localStorage.getItem(STORAGE_SESSION) || ''
  };
}

function saveSettings(ip, port, token) {
  localStorage.setItem(STORAGE_IP, ip.trim());
  localStorage.setItem(STORAGE_PORT, port.trim() || '8787');
  localStorage.setItem(STORAGE_TOKEN, token.trim());
}

function openSettingsModal() {
  const { ip, port, token } = getSettings();
  settingIp.value = ip;
  settingPort.value = port;
  settingToken.value = token;
  settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
}

// ─── UI Helpers ──────────────────────────────────────────────────────────────
function setStatus(state, message) {
  statusDot.className = 'status-dot';
  if (state === 'connected') {
    statusDot.classList.add('connected');
  } else if (state === 'disconnected') {
    statusDot.classList.add('disconnected');
  } else if (state === 'connecting') {
    statusDot.classList.add('connecting');
  }
  statusText.textContent = message;
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorBanner.classList.remove('hidden');
}

function hideError() {
  errorBanner.classList.add('hidden');
}

function clearOutput() {
  outputPane.textContent = '';
}

function appendOutput(text) {
  if (!text) return;
  const isScrolledToBottom = outputPane.scrollHeight - outputPane.clientHeight <= outputPane.scrollTop + 30;
  
  outputPane.appendChild(document.createTextNode(text));
  
  if (isScrolledToBottom) {
    outputPane.scrollTop = outputPane.scrollHeight;
  }
}

function setFormEnabled(enabled) {
  promptInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
  if (enabled) {
    promptInput.focus();
  }
}

// ─── Session Management ───────────────────────────────────────────────────────
function updateSessionPicker(sessions) {
  availableSessions = Array.isArray(sessions) ? sessions : [];
  sessionSelect.innerHTML = '';

  if (availableSessions.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No tmux sessions found';
    sessionSelect.appendChild(opt);
    sessionSelect.disabled = true;
    setFormEnabled(false);
    currentSession = null;
    return;
  }

  sessionSelect.disabled = !isAuthenticated;

  availableSessions.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sessionSelect.appendChild(opt);
  });

  const { lastSession } = getSettings();
  let targetSession = currentSession;

  if (!targetSession || !availableSessions.includes(targetSession)) {
    if (lastSession && availableSessions.includes(lastSession)) {
      targetSession = lastSession;
    } else {
      targetSession = availableSessions[0];
    }
  }

  sessionSelect.value = targetSession;

  if (targetSession && targetSession !== currentSession) {
    subscribeToSession(targetSession);
  }
}

function subscribeToSession(sessionName) {
  if (!sessionName || !socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
    return;
  }

  currentSession = sessionName;
  localStorage.setItem(STORAGE_SESSION, sessionName);
  sessionSelect.value = sessionName;

  clearOutput();
  setStatus('connected', `Subscribed: ${sessionName}`);

  socket.send(JSON.stringify({
    type: 'subscribe',
    session: sessionName
  }));

  setFormEnabled(true);
}

function requestSessionsList() {
  if (socket && socket.readyState === WebSocket.OPEN && isAuthenticated) {
    socket.send(JSON.stringify({ type: 'list_sessions' }));
  }
}

// ─── Connection Logic ────────────────────────────────────────────────────────
function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const { ip, port, token } = getSettings();

  if (!ip || !token) {
    setStatus('disconnected', 'Missing settings');
    openSettingsModal();
    return;
  }

  const wsUrl = `ws://${ip}:${port}`;
  setStatus('connecting', `Connecting to ${ip}...`);
  setFormEnabled(false);
  sessionSelect.disabled = true;
  refreshSessionsBtn.disabled = true;
  isAuthenticated = false;

  try {
    if (socket) {
      // Null out handlers BEFORE closing so the intentional teardown
      // doesn't trigger onclose → scheduleReconnect → connect() loop.
      // Code 1005 (CLOSE_NO_STATUS) is what fires when we call .close()
      // ourselves without a code — we must not treat that as a real disconnect.
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.close();
    }
    socket = new WebSocket(wsUrl);
  } catch (err) {
    showError(`Invalid WebSocket URL: ${err.message}`);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    setStatus('connecting', 'Authenticating...');
    socket.send(JSON.stringify({ type: 'auth', token: token }));
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.warn('Failed to parse WebSocket JSON:', event.data);
      return;
    }

    if (msg.type === 'ready') {
      isAuthenticated = true;
      hideError();
      setStatus('connected', 'Connected');
      refreshSessionsBtn.disabled = false;
    } else if (msg.type === 'sessions') {
      updateSessionPicker(msg.sessions);
    } else if (msg.type === 'output') {
      // Ignore outputs for other sessions if client switched quickly
      if (!msg.session || msg.session === currentSession) {
        appendOutput(msg.text);
      }
    } else if (msg.type === 'error') {
      showError(msg.message || 'Daemon error occurred');
    }
  };

  socket.onerror = (err) => {
    console.error('WebSocket error:', err);
    showError('WebSocket connection error');
    setStatus('disconnected', 'Connection error — retrying in 3s...');
    // Always schedule a retry here. onclose will also fire after onerror
    // on a failed connection, but scheduling here ensures the retry loop
    // is active even if onclose doesn't fire (e.g. browser quirks).
    scheduleReconnect();
  };

  socket.onclose = (event) => {
    isAuthenticated = false;
    currentSession = null;
    setFormEnabled(false);
    sessionSelect.disabled = true;
    refreshSessionsBtn.disabled = true;

    let reason = 'Disconnected';
    if (event.code === 4401) {
      reason = 'Auth failed (wrong token)';
      showError('Authentication failed: Invalid AUTH_TOKEN. Please check settings.');
    } else if (event.code === 4404) {
      reason = 'Session not found';
      showError('tmux session not found on host machine.');
    } else {
      reason = 'Connection lost';
    }

    setStatus('disconnected', `${reason} — retrying in 3s...`);
    
    // Don't auto-reconnect on permanent auth failure unless user updates settings
    if (event.code !== 4401 && event.code !== 4404) {
      scheduleReconnect();
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect();
  }, 3000);
}

// ─── Event Listeners ─────────────────────────────────────────────────────────
promptForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = promptInput.value.trim();
  if (!text || !socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
    return;
  }
  if (!currentSession) {
    showError('No active session selected. Please select a session first.');
    return;
  }

  socket.send(JSON.stringify({
    type: 'prompt',
    session: currentSession,
    text: text
  }));
  promptInput.value = '';
});

sessionSelect.addEventListener('change', (e) => {
  const selected = e.target.value;
  if (selected && selected !== currentSession) {
    subscribeToSession(selected);
  }
});

refreshSessionsBtn.addEventListener('click', requestSessionsList);
openSettingsBtn.addEventListener('click', openSettingsModal);
cancelSettingsBtn.addEventListener('click', closeSettingsModal);
dismissErrorBtn.addEventListener('click', hideError);

// ─── Network & Offline Event Listeners ─────────────────────────────────────────
window.addEventListener('offline', () => {
  // Cancel any pending reconnect — no point retrying into a dead network.
  // Do NOT call scheduleReconnect() here. We wait for the 'online' event
  // instead, which fires when the browser believes the network is back.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  isAuthenticated = false;
  currentSession = null;
  setFormEnabled(false);
  sessionSelect.disabled = true;
  refreshSessionsBtn.disabled = true;
  setStatus('disconnected', 'No network — waiting...');
  if (socket) {
    // Null handlers BEFORE close so this intentional teardown doesn't
    // trigger the onclose → scheduleReconnect path (we want to wait for
    // the 'online' event, not immediately retry into no network).
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;
    try {
      socket.close();
    } catch (e) {
      // Ignore errors from closing an already-dead socket
    }
    socket = null;
  }
});

window.addEventListener('online', () => {
  // The browser fires 'online' optimistically — the network interface is
  // up but Tailscale routes may not be re-established yet. Use a short
  // delay before the first attempt so we don't immediately fail and have
  // to wait a full 3 s for the scheduled retry.
  // scheduleReconnect() (not connect()) means: if this first attempt after
  // airplane-off also fails, onerror/onclose will call scheduleReconnect()
  // again and the retry loop stays active automatically.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  setStatus('connecting', 'Network restored — reconnecting...');
  reconnectTimer = setTimeout(() => {
    connect();
  }, 1500); // 1.5 s grace period for Tailscale route re-establishment
});

settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  saveSettings(settingIp.value, settingPort.value, settingToken.value);
  closeSettingsModal();
  hideError();
  connect();
});

// ─── Initial Start ────────────────────────────────────────────────────────────
const { ip, token } = getSettings();
if (!ip || !token) {
  openSettingsModal();
} else {
  connect();
}
