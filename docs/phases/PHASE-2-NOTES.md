# Phase 2 Notes & Implementation Summary: Dynamic Session Discovery & Switching

## Overview

Phase 2 enhances the system from single-session hardcoding (`agent-1`) to **dynamic session discovery and switching**. The phone client can now discover all active `tmux` sessions running on the PC on demand, switch between them seamlessly, auto-subscribe on reconnect, and receive targeted terminal outputs without needing a database or static session registry.

---

## Technical Implementation

### 1. Daemon (`daemon/server.js`)
- **Zero-Storage Session Discovery**: Queries `tmux list-sessions -F "#{session_name}"` dynamically whenever `list_sessions` or `auth` is received.
- **Subscription Tracking**: Maintains a `Map<sessionName, Set<wsClient>>` of active subscribers.
- **On-Demand Polling**: Only polls tmux sessions that have active subscribers. When all clients unsubscribe from a session, polling for that session automatically stops.
- **Immediate Initial Frame**: Subscribing to a session immediately sends a full `output` frame containing the session's current terminal pane text (`cleanCapture`).
- **Protocol Schema Additions**:
  - `list_sessions` / `sessions` (`sessions: ["agent-1", "agent-codex-2"]`)
  - `subscribe` (`session: "agent-codex-2"`)
  - Session-tagged `prompt` and `output` messages (`{ type: "prompt", session: "...", text: "..." }`)

### 2. Client (`client/`)
- **Session Selector Bar**: Added a dropdown picker (`<select id="session-select">`) and a refresh button (`🔄`) to the top bar in [client/index.html](file:///c:/Users/Ankit%20pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/client/index.html).
- **Session Switching & Clearing**: Switching sessions clears the terminal output pane immediately, sends a `subscribe` frame, and populates the new session's content without mixing session histories.
- **Persistence (`localStorage`)**: Saves the last active session in `localStorage` under `arc_last_session`. On reconnect, automatically re-subscribes to that session if it still exists.
- **Input Guard**: Prompt input and send button remain disabled until a valid session is subscribed to.

---

## Acceptance Verification Results

| # | Spec Requirement | Status | Verification Method |
|---|---|---|---|
| **1** | Connect sends `ready` then `sessions` matching `tmux ls` | ✅ **PASSED** | Automated & client test received `["agent-1", "agent-codex-2"]` |
| **2** | Dynamic discovery of new tmux sessions (`tmux new -s test-3`) | ✅ **PASSED** | Created `agent-test-2` in WSL; `list_sessions` immediately returned it |
| **3** | Immediate initial output frame on subscribe | ✅ **PASSED** | `subscribe` sent `output` frame containing current pane content instantly |
| **4** | Invalid session returns structured `error` | ✅ **PASSED** | Subscribing or sending prompt to missing session returns `{ type: "error", message: "Session 'x' not found" }` |
| **5** | Session switching clears output pane & prevents output mixing | ✅ **PASSED** | Client clears pane on switch and filters output by `msg.session === currentSession` |
| **6** | Session kill notifies subscriber with `error` | ✅ **PASSED** | Disappeared tmux session triggers `error` frame to subscribers and cleans up state |
| **7** | Reconnect auto-subscribes to last session | ✅ **PASSED** | `arc_last_session` automatically re-subscribes upon WS reconnection |
| **8** | Status badge changes to `disconnected` within ~1-2 s of a real network drop (not waiting for the 30 s heartbeat timeout) | ⚠️ **NOT TESTED** | Code implemented: `window offline` event clears socket and sets status immediately; `window online` triggers reconnect. However, this was **never verified against a real network drop** (e.g. toggling Wi-Fi off on the phone). Only the heartbeat-based disconnect path (criterion 7) was confirmed. Needs manual verification before Phase 3. |
