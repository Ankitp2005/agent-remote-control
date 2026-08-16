# Phase 2 spec: session discovery and switching

## Goal
Right now the daemon only knows about one hardcoded tmux session
(`agent-1`). This phase lets the phone see every tmux session actually
running on the PC and switch which one it's watching/prompting, without
needing a config file, a database, or any manual registry to maintain.

Sessions are still created manually on the PC (`tmux new -s agent-codex-2`
etc.) — nothing here lets the phone create a new agent session. That's an
explicit non-goal, see below.

## Design decision: no persistent registry
Rather than maintaining a JSON file or database of known sessions, the
daemon asks tmux directly, on demand, via:
```
tmux list-sessions -F "#{session_name}"
```
This is always accurate (tmux is the source of truth), needs zero
storage, and can't go stale. Do not build a sessions.json or any other
persisted list — if the spec later needs one, it'll say so explicitly.

## Design decision: switching, not simultaneous multi-view
Each connected phone client watches exactly one session at a time and can
switch which one. This phase does NOT build a dashboard showing multiple
sessions' output at once — that's more UI complexity than the goal
justifies right now. Switching covers the actual use case: "check on
Codex," then "switch to check on Antigravity."

## Daemon changes (`daemon/server.js`)

### Per-session state
Replace the single global `lastCapture` variable with a `Map` keyed by
session name, e.g. `sessionState.get('agent-1') = { lastCapture: "..." }`.
Reuse `cleanCapture` and `computeDiff` exactly as already implemented —
just call them per-session instead of on one global variable.

### Polling scope
Only poll sessions that at least one connected client is currently
subscribed to. Do not poll every tmux session that exists on the machine
— if nobody's watching `agent-3`, don't waste cycles capturing its pane.
Track subscriptions as `Map<sessionName, Set<clientConnection>>`.

When the last client unsubscribes from a session (switches away or
disconnects), stop polling that session and drop its entry from
`sessionState` and the subscription map.

### New/changed WebSocket message types

**Client → daemon, list available sessions:**
```json
{ "type": "list_sessions" }
```

**Daemon → client, session list:**
```json
{ "type": "sessions", "sessions": ["agent-1", "agent-codex-2"] }
```
Send this automatically once right after `ready`, and again any time the
client sends `list_sessions` (e.g. user pulls to refresh the picker).

**Client → daemon, subscribe to a session:**
```json
{ "type": "subscribe", "session": "agent-codex-2" }
```
Daemon behavior: unsubscribe this client from whatever session it was
previously watching (if any), add it to the new session's subscriber set,
start polling that session if not already being polled, and immediately
send one `output` frame with the session's current full pane content
(clean, not a diff — the client just switched, it has nothing to diff
against).

**Client → daemon, sending a prompt (session is now required):**
```json
{ "type": "prompt", "session": "agent-codex-2", "text": "..." }
```
If `session` doesn't match a real tmux session, respond with an `error`
message (see below) instead of silently failing.

**Daemon → client, output (now tagged with session):**
```json
{ "type": "output", "session": "agent-codex-2", "text": "..." }
```
Client should ignore output frames for a session it's no longer
subscribed to (can happen briefly during a fast switch).

**Daemon → client, error (session not found case added):**
```json
{ "type": "error", "message": "Session 'agent-9' not found" }
```

## Client changes (`client/`)

- On receiving the `sessions` message, render a simple picker (a
  `<select>` dropdown is enough — no need for anything fancier this
  phase) listing session names.
- On the user picking a session, send `subscribe`, clear the output pane,
  and wait for the next `output` frame to repopulate it. Don't leave old
  session's output on screen after switching — that's confusing, not
  helpful.
- Store the last-subscribed session name in `localStorage` alongside the
  existing `arc_daemon_ip` / `arc_daemon_port` / `arc_daemon_token` keys
  (e.g. `arc_last_session`), and auto-subscribe to it on reconnect if it
  still exists in the new `sessions` list. If it doesn't exist anymore
  (session was killed on the PC), fall back to showing the picker instead
  of erroring.
- The prompt input is disabled until a session is subscribed to — no
  sending prompts with no session selected.

## Non-goals for this phase
- No simultaneous multi-session dashboard view.
- No creating, killing, or renaming tmux sessions from the phone.
- No persisted session registry/config file.
- No approval-detection or push notifications (still phase 3, formerly
  called phase 6 in the original six-step plan).
- No per-session auth/permissions — one shared token still covers all
  sessions, same as phase 1.

## Acceptance criteria (verify manually before phase 3)
1. Connecting sends `ready`, then automatically receives a `sessions`
   list matching what `tmux ls` shows on the PC at that moment.
2. Starting a brand new tmux session on the PC (`tmux new -s test-3`) and
   then sending `list_sessions` from the client shows it in the updated
   list — no daemon restart required.
3. Subscribing to a session shows that session's current pane content
   immediately, even if it has been running for a while with no new
   activity since the client connected.
4. Sending a prompt with no session subscribed (or an invalid session
   name) returns an `error` message, not a silent failure or a crash.
5. Switching from session A to session B clears the old output from the
   phone screen and only shows B's content going forward — no mixing of
   A and B output.
6. Killing session A on the PC (`tmux kill-session -t A`) while a client
   is subscribed to it results in an `error` message to that client, not
   a hang or a crash of the daemon.
7. Reconnecting after a wifi drop re-subscribes to the same session
   automatically if it still exists, without the user re-picking it.