#!/usr/bin/env bash

# start-all.sh — Idempotent startup script for daemon & agent session on WSL login
# Per docs/phases/PHASE-4-SPEC.md

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$DAEMON_DIR/logs"

mkdir -p "$LOG_DIR"
START_LOG="$LOG_DIR/start-all.log"
DAEMON_LOG="$LOG_DIR/daemon.log"

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$msg"
    echo "$msg" >> "$START_LOG"
}

# Load environment variables if .env exists
if [ -f "$DAEMON_DIR/.env" ]; then
    export $(grep -v '^#' "$DAEMON_DIR/.env" | xargs)
fi

PORT="${PORT:-8787}"
SESSION_NAME="${SESSION_NAME:-agent-1}"

log "=== Starting start-all.sh sequence ==="

# 1. Wait for Tailscale to be ready (up to 30s)
log "Step 1: Checking Tailscale readiness..."
TAILSCALE_READY=false
TAILSCALE_IP=""

for i in $(seq 1 15); do
    IP=$(tailscale ip -4 2>/dev/null | head -n 1) || true
    if [ -n "$IP" ]; then
        TAILSCALE_READY=true
        TAILSCALE_IP="$IP"
        break
    fi
    sleep 2
done

if [ "$TAILSCALE_READY" = false ]; then
    log "ERROR: Tailscale IPv4 address not available after 30 seconds. Exiting."
    exit 1
fi
log "Tailscale ready with IP: $TAILSCALE_IP"

# 2. Check if daemon is running, start if not
log "Step 2: Checking daemon status on port $PORT..."
if ss -tln 2>/dev/null | grep -q ":${PORT}\ " || pgrep -f "node.*server.js" >/dev/null 2>&1; then
    DAEMON_STATUS="already running"
else
    log "Daemon is not running. Starting daemon..."
    cd "$DAEMON_DIR"
    nohup node server.js >> "$DAEMON_LOG" 2>&1 &
    sleep 1
    DAEMON_STATUS="started"
fi
log "Daemon status: $DAEMON_STATUS"

# 3. Check if tmux session exists, create if not
log "Step 3: Checking tmux session '$SESSION_NAME'..."
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    TMUX_STATUS="already existing"
else
    log "Creating tmux session '$SESSION_NAME'..."
    tmux new-session -d -s "$SESSION_NAME"
    # Wait for the shell inside the pane to fully start.
    # Without this sleep, pane_current_command returns "tmux" (the server
    # process) instead of "bash" because the pane's shell hasn't initialized
    # yet — a race condition on freshly created detached sessions.
    sleep 0.5
    TMUX_STATUS="created"
fi
log "tmux session status: $TMUX_STATUS"

# 4. Check if agy (or agent CLI) is running inside session
log "Step 4: Checking command running in tmux session '$SESSION_NAME'..."
PANE_CMD=$(tmux list-panes -t "$SESSION_NAME" -F "#{pane_current_command}" 2>/dev/null | head -n 1) || PANE_CMD=""

# Conditions that mean agy is NOT yet running and needs to be launched:
#   - "bash"/"sh"/"zsh": pane is at an idle shell prompt
#   - empty: pane_current_command returned nothing
#   - "tmux": race condition — shell hasn't initialized yet (safety net)
if [ "$PANE_CMD" = "bash" ] || [ "$PANE_CMD" = "sh" ] || [ "$PANE_CMD" = "zsh" ] || [ "$PANE_CMD" = "tmux" ] || [ -z "$PANE_CMD" ]; then
    log "Session is at shell prompt ('$PANE_CMD'). Starting 'agy'..."
    tmux send-keys -t "$SESSION_NAME" "agy" Enter
    AGENT_STATUS="started agy"
else
    AGENT_STATUS="already running ($PANE_CMD)"
fi
log "Agent CLI status: $AGENT_STATUS"

# 5. Summary
log "SUMMARY: Daemon [$DAEMON_STATUS] | tmux session '$SESSION_NAME' [$TMUX_STATUS] | Agent [$AGENT_STATUS]"
log "=== Completed start-all.sh sequence ==="
