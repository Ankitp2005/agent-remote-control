# Phase 5 spec: spawning new agent sessions from the PWA

## Goal
Right now, starting a new agent (a second, third, etc. tmux session running
`agy`) requires physically going to the PC and typing `tmux new -s X` +
launching `agy` by hand. This phase lets you create a brand new session —
name, project folder, and all — directly from your phone, with no manual
terminal step. After this phase, "agent controller" is accurate: you can
view, prompt, *and* start agents remotely, not just the first two.

## Prerequisites
Phases 1–4 complete and verified. This phase assumes:
- The daemon already does dynamic session discovery via `tmux list-sessions`
  (phase 2) — this phase adds *creation*, not discovery.
- `agy` is a runnable command on PATH inside WSL for the user running the
  daemon (true today, since `start-all.sh` already launches it this way).

## Design decision: daemon spawns via `tmux new-session`, not a shell script per agent
The daemon already shells out to tmux for capture/send-keys. Creation is the
same category of operation — no new dependency, no new process model. The
daemon runs:
```
tmux new-session -d -s <name> -c <folder>
tmux send-keys -t <name> 'agy' Enter
```
`-d` is critical — detached, so it doesn't try to attach to a controlling
terminal that doesn't exist server-side. This is exactly what `start-all.sh`
already does for `agent-1`; this phase generalizes it to arbitrary sessions,
triggered remotely instead of at login.

## Design decision: session name and folder are user-supplied, not auto-generated
Auto-generating names (`agent-2`, `agent-3`, ...) is tempting but creates a
mismatch the moment you kill one and start another — numbers stop mapping to
anything meaningful. Let the user type a short name and pick/type a folder
path. Validate, don't invent.

## Daemon changes (`daemon/server.js`)

### New WebSocket message type: `spawn_session`
Client → daemon:
```json
{ "type": "spawn_session", "name": "agent-frontend", "folder": "/home/user/projects/frontend" }
```

Validation, in order, before touching tmux:
1. `name` matches `^[a-zA-Z0-9_-]{1,32}$` — reject anything else (tmux
   session names with spaces or special characters cause real problems
   later in send-keys/capture-pane commands). Return an `error` message
   with a clear reason, don't silently sanitize.
2. `name` does not already exist in `tmux list-sessions` — return an
   `error` if it does ("session already exists"), do not overwrite or
   reuse an existing session silently.
3. `folder` exists and is a directory — check with `fs.existsSync` +
   `fs.statSync` server-side before running any tmux command. Return an
   `error` if not ("folder not found") rather than letting tmux fail
   opaquely inside the pane.

If all three pass:
```javascript
execSync(`tmux new-session -d -s "${name}" -c "${folder}"`);
```
**Known issue from phase 4, applies here too — do not skip this.** Right
after `tmux new-session`, the pane can briefly report itself as not yet
ready (this bit us in `start-all.sh`, where `pane_current_command`
returned `tmux` instead of `bash` for a moment after creation). Sending
`agy` into the pane too early risks it landing before the shell is
actually accepting input. Guard against this the same way `start-all.sh`
does:
```javascript
execSync(`tmux new-session -d -s "${name}" -c "${folder}"`);
await new Promise(r => setTimeout(r, 500)); // let the shell settle, same fix as start-all.sh
execSync(`tmux send-keys -t "${name}" 'agy' Enter`);
```
Use the same shell-escaping approach already used elsewhere in
`server.js` for send-keys — don't introduce a second escaping strategy.

### Response
On success, broadcast an updated `sessions` list to all connected clients
(reuse the existing phase-2 discovery/broadcast path — don't build a
second mechanism) plus a direct confirmation to the requesting client:
```json
{ "type": "spawn_result", "success": true, "name": "agent-frontend" }
```
On any validation failure:
```json
{ "type": "spawn_result", "success": false, "reason": "session already exists" }
```

### Killing a session (needed once you can create them — otherwise sessions only accumulate)
New message type, same validation pattern (name must exist):
```json
{ "type": "kill_session", "name": "agent-frontend" }
```
Daemon runs `tmux kill-session -t "<name>"`, then broadcasts the updated
session list. If a client is currently subscribed to the killed session,
send it an explicit `session_ended` message so the client can fall back
to the picker instead of silently polling a session that no longer exists.

## Client changes (`client/`)

- Add a "+ New session" entry in the existing session picker dropdown
  (from phase 2), not a separate screen.
- Tapping it opens a small form: session name (text input), folder path
  (text input, prefill with the default project folder as a starting
  point since that's the common case). Submit sends `spawn_session`.
- On `spawn_result` with `success: false`, show the `reason` inline near
  the form — don't just fail silently or log to console only.
- On `success: true`, close the form and auto-subscribe to the new
  session, so the user lands directly on its output.
- Add a "kill session" action (e.g. long-press or a small trash icon)
  next to each entry in the picker, with a confirm step — this is
  destructive and should not be a single accidental tap.

## Non-goals for this phase
- No editing an existing session's folder after creation — kill and
  recreate instead.
- No launching agents other than `agy` from the picker — if you need a
  different CLI, that's a manual tmux step for now, same as today.
- No persistent record of past sessions/folders (e.g. a "recent folders"
  list) — type the path each time. Worth a future phase if it gets
  tedious, not this one.
- No auto-start of spawned sessions on the next login — `start-all.sh`
  still only auto-starts `agent-1`, as before.
- No resource limits or caps on number of concurrent sessions — you are
  the only user, you're responsible for not spawning 20 agents on a PC
  that can't run them.

## Acceptance criteria (verify manually)
1. From the phone, create a new session with a valid name and an existing
   folder. Confirm via `tmux list-sessions` on the PC that it actually
   exists, and confirm `agy` is genuinely running inside it (attach and
   look, or check the daemon's output poll shows the `agy` welcome
   screen).
2. Attempt to create a session with a name that already exists. Confirm
   you get a clear `error`/`spawn_result` failure, and confirm the
   original session is untouched (not restarted, not duplicated).
3. Attempt to create a session with a folder path that doesn't exist.
   Confirm a clear failure message, and confirm no tmux session was
   created at all (check `tmux list-sessions` — it should NOT show a
   half-created session).
4. Attempt a name with a space or special character (e.g. `my session`).
   Confirm it's rejected with a validation error, not passed through to
   tmux.
5. Create a session, then kill it from the phone. Confirm via
   `tmux list-sessions` on the PC that it's actually gone.
6. While subscribed to a session on the phone, kill that same session
   (from another client, or by testing with two browser tabs). Confirm
   the subscribed client gets a clear `session_ended` signal and falls
   back to the picker, rather than showing frozen/stale output forever.
7. Create two sessions back to back with different folders, confirm each
   one's output reflects its own folder (e.g. running `pwd` in each shows
   the correct distinct path) — this is the real check that `-c <folder>`
   is actually being respected per-session, not just the first one.
8. Create a session and immediately check (within the first second) that
   `agy` actually launched, not just the bare shell — this is the direct
   test for the settle-time race condition described above. If `agy`
   didn't launch, the 500ms delay isn't enough on your machine and needs
   to be increased, the same way we had to tune it in `start-all.sh`.