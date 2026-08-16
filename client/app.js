/**
 * Agent Remote Control - Mobile PWA Client (Phase 5)
 */

'use strict';

// ─── Storage Keys ─────────────────────────────────────────────────────────────
const STORAGE_IP = 'arc_daemon_ip';
const STORAGE_PORT = 'arc_daemon_port';
const STORAGE_TOKEN = 'arc_daemon_token';
const STORAGE_SESSION = 'arc_last_session';
const STORAGE_FOLDER = 'arc_last_folder';

const DEFAULT_FOLDER = '/mnt/c/Users/Ankit pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control';
const SESSION_NAME_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;

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
const newSessionBtn = document.getElementById('new-session-btn');
const killSessionBtn = document.getElementById('kill-session-btn');
const refreshSessionsBtn = document.getElementById('refresh-sessions-btn');

const openSettingsBtn = document.getElementById('open-settings-btn');
const cancelSettingsBtn = document.getElementById('cancel-settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsForm = document.getElementById('settings-form');
const settingIp = document.getElementById('setting-ip');
const settingPort = document.getElementById('setting-port');
const settingToken = document.getElementById('setting-token');

const newSessionModal = document.getElementById('new-session-modal');
const newSessionForm = document.getElementById('new-session-form');
const sessionNameInput = document.getElementById('session-name-input');
const sessionFolderInput = document.getElementById('session-folder-input');
const cancelNewSessionBtn = document.getElementById('cancel-new-session-btn');
const submitNewSessionBtn = document.getElementById('submit-new-session-btn');
const spawnErrorBanner = document.getElementById('spawn-error-banner');
const spawnErrorMessage = document.getElementById('spawn-error-message');

const confirmKillModal = document.getElementById('confirm-kill-modal');
const killSessionTargetName = document.getElementById('kill-session-target-name');
const cancelKillBtn = document.getElementById('cancel-kill-btn');
const confirmKillBtn = document.getElementById('confirm-kill-btn');

// ─── State ───────────────────────────────────────────────────────────────────
let socket = null;
let reconnectTimer = null;
let isAuthenticated = false;
let currentSession = null;
let availableSessions = [];
const waitingSessions = new Set();

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
    lastSession: localStorage.getItem(STORAGE_SESSION) || '',
    lastFolder: localStorage.getItem(STORAGE_FOLDER) || DEFAULT_FOLDER
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

// ─── New Session Modal Management ─────────────────────────────────────────────
function openNewSessionModal() {
  sessionNameInput.value = '';
  const { lastFolder } = getSettings();
  sessionFolderInput.value = lastFolder;
  hideSpawnError();
  submitNewSessionBtn.disabled = false;
  submitNewSessionBtn.textContent = 'Create Session';
  newSessionModal.classList.remove('hidden');
  sessionNameInput.focus();
}

function closeNewSessionModal() {
  newSessionModal.classList.add('hidden');
  hideSpawnError();
}

function showSpawnError(msg) {
  spawnErrorMessage.textContent = msg;
  spawnErrorBanner.classList.remove('hidden');
}

function hideSpawnError() {
  spawnErrorBanner.classList.add('hidden');
}

// ─── Confirm Kill Modal Management ────────────────────────────────────────────
function openKillModal() {
  if (!currentSession) return;
  killSessionTargetName.textContent = currentSession;
  confirmKillModal.classList.remove('hidden');
}

function closeKillModal() {
  confirmKillModal.classList.add('hidden');
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
  renderSessionOptions();
}

function renderSessionOptions() {
  sessionSelect.innerHTML = '';
  sessionSelect.disabled = !isAuthenticated;
  newSessionBtn.disabled = !isAuthenticated;
  refreshSessionsBtn.disabled = !isAuthenticated;

  if (availableSessions.length === 0) {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = 'No sessions running';
    sessionSelect.appendChild(emptyOpt);

    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ New session...';
    sessionSelect.appendChild(newOpt);

    currentSession = null;
    sessionSelect.value = '';
    killSessionBtn.disabled = true;
    setFormEnabled(false);
    return;
  }

  availableSessions.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s;
    const isWaiting = waitingSessions.has(s);
    opt.textContent = isWaiting ? `🔴 ${s}` : s;
    sessionSelect.appendChild(opt);
  });

  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ New session...';
  sessionSelect.appendChild(newOpt);

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
  } else if (targetSession) {
    killSessionBtn.disabled = false;
    setFormEnabled(true);
  }
}

function subscribeToSession(sessionName) {
  if (!sessionName || !socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
    return;
  }

  currentSession = sessionName;
  localStorage.setItem(STORAGE_SESSION, sessionName);
  sessionSelect.value = sessionName;
  killSessionBtn.disabled = false;

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
  newSessionBtn.disabled = true;
  killSessionBtn.disabled = true;
  refreshSessionsBtn.disabled = true;
  isAuthenticated = false;

  try {
    if (socket) {
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
      newSessionBtn.disabled = false;
      sessionSelect.disabled = false;
    } else if (msg.type === 'sessions') {
      updateSessionPicker(msg.sessions);
    } else if (msg.type === 'waiting') {
      if (msg.session) {
        if (msg.waiting) {
          waitingSessions.add(msg.session);
        } else {
          waitingSessions.delete(msg.session);
        }
        renderSessionOptions();
      }
    } else if (msg.type === 'output') {
      // Ignore outputs for other sessions if client switched quickly
      if (!msg.session || msg.session === currentSession) {
        appendOutput(msg.text);
      }
    } else if (msg.type === 'spawn_result') {
      if (msg.success) {
        const folder = sessionFolderInput.value.trim();
        if (folder) {
          localStorage.setItem(STORAGE_FOLDER, folder);
        }
        closeNewSessionModal();
        if (msg.name) {
          currentSession = msg.name;
          localStorage.setItem(STORAGE_SESSION, msg.name);
          subscribeToSession(msg.name);
        }
      } else {
        submitNewSessionBtn.disabled = false;
        submitNewSessionBtn.textContent = 'Create Session';
        showSpawnError(msg.reason || 'Failed to create session');
      }
    } else if (msg.type === 'session_ended') {
      if (!msg.session || msg.session === currentSession) {
        const endedName = msg.session || currentSession;
        appendOutput(`\n\n[Session '${endedName}' ended]\n`);
        currentSession = null;
        localStorage.removeItem(STORAGE_SESSION);
        setFormEnabled(false);
        killSessionBtn.disabled = true;
        setStatus('connected', `Session ended (${endedName})`);
        renderSessionOptions();
      }
    } else if (msg.type === 'error') {
      showError(msg.message || 'Daemon error occurred');
    }
  };

  socket.onerror = (err) => {
    console.error('WebSocket error:', err);
    showError('WebSocket connection error');
    setStatus('disconnected', 'Connection error — retrying in 3s...');
    scheduleReconnect();
  };

  socket.onclose = (event) => {
    isAuthenticated = false;
    currentSession = null;
    waitingSessions.clear();
    setFormEnabled(false);
    sessionSelect.disabled = true;
    newSessionBtn.disabled = true;
    killSessionBtn.disabled = true;
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
  if (selected === '__new__') {
    sessionSelect.value = currentSession || '';
    openNewSessionModal();
    return;
  }
  if (selected && selected !== currentSession) {
    subscribeToSession(selected);
  }
});

refreshSessionsBtn.addEventListener('click', requestSessionsList);
newSessionBtn.addEventListener('click', openNewSessionModal);
cancelNewSessionBtn.addEventListener('click', closeNewSessionModal);

newSessionForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = sessionNameInput.value.trim();
  const folder = sessionFolderInput.value.trim();

  if (!name || !SESSION_NAME_REGEX.test(name)) {
    showSpawnError('Session name must be 1–32 characters containing only letters, numbers, hyphens, or underscores');
    return;
  }

  if (!folder) {
    showSpawnError('Project folder path is required');
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
    showSpawnError('Not connected to daemon. Please connect first.');
    return;
  }

  hideSpawnError();
  submitNewSessionBtn.disabled = true;
  submitNewSessionBtn.textContent = 'Creating...';

  socket.send(JSON.stringify({
    type: 'spawn_session',
    name: name,
    folder: folder
  }));
});

killSessionBtn.addEventListener('click', openKillModal);
cancelKillBtn.addEventListener('click', closeKillModal);

confirmKillBtn.addEventListener('click', () => {
  if (currentSession && socket && socket.readyState === WebSocket.OPEN && isAuthenticated) {
    socket.send(JSON.stringify({
      type: 'kill_session',
      name: currentSession
    }));
  }
  closeKillModal();
});

openSettingsBtn.addEventListener('click', openSettingsModal);
cancelSettingsBtn.addEventListener('click', closeSettingsModal);
dismissErrorBtn.addEventListener('click', hideError);

// ─── Network & Offline Event Listeners ─────────────────────────────────────────
window.addEventListener('offline', () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  isAuthenticated = false;
  currentSession = null;
  waitingSessions.clear();
  setFormEnabled(false);
  sessionSelect.disabled = true;
  newSessionBtn.disabled = true;
  killSessionBtn.disabled = true;
  refreshSessionsBtn.disabled = true;
  setStatus('disconnected', 'No network — waiting...');
  if (socket) {
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
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  setStatus('connecting', 'Network restored — reconnecting...');
  reconnectTimer = setTimeout(() => {
    connect();
  }, 1500);
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
