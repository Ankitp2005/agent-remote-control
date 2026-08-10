/**
 * Agent Remote Control - Mobile PWA Client (Phase 1)
 */

'use strict';

// ─── Storage Keys ─────────────────────────────────────────────────────────────
const STORAGE_IP = 'arc_daemon_ip';
const STORAGE_PORT = 'arc_daemon_port';
const STORAGE_TOKEN = 'arc_daemon_token';

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
    token: localStorage.getItem(STORAGE_TOKEN) || ''
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
  isAuthenticated = false;

  try {
    if (socket) {
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
      setStatus('connected', `Connected (${msg.session || 'agent'})`);
      setFormEnabled(true);
    } else if (msg.type === 'output') {
      appendOutput(msg.text);
    } else if (msg.type === 'error') {
      showError(msg.message || 'Daemon error occurred');
    }
  };

  socket.onerror = (err) => {
    console.error('WebSocket error:', err);
    showError('WebSocket connection error');
  };

  socket.onclose = (event) => {
    isAuthenticated = false;
    setFormEnabled(false);

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

  // Echo user prompt locally in output pane
  appendOutput(`\n> ${text}\n`);
  
  socket.send(JSON.stringify({ type: 'prompt', text: text }));
  promptInput.value = '';
});

openSettingsBtn.addEventListener('click', openSettingsModal);
cancelSettingsBtn.addEventListener('click', closeSettingsModal);
dismissErrorBtn.addEventListener('click', hideError);

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
