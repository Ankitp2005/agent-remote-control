# Phase 3 spec: approval detection and push notifications

## Goal
When an agent CLI (in any tmux session) prints something like "Proceed?
[y/n]" and is sitting there waiting on you, the daemon detects that and
pushes a free phone notification — so you don't have to keep the app open
and stare at a terminal to know when you're needed.

## Design decision: ntfy.sh for push, not a custom notification server
ntfy.sh is a free, open-source push notification service. No account, no
API key. You POST a message to a topic (a URL path you make up), and
anyone subscribed to that topic (via the ntfy phone app, or just opening
`https://ntfy.sh/<topic>` in a browser) gets it instantly. This is the
only sane free option — do not build a custom push server or use a paid
service for this.

**Security note:** the topic name is your only secret here. Anyone who
knows it can subscribe to your notifications or send fake ones to your
phone. Generate a long random topic name (same way you generated
AUTH_TOKEN), never a guessable one like `my-agent-alerts`.

## Design decision: generic pattern matching, not per-agent parsers
Different CLIs phrase approval prompts differently, and you're running
whatever you're running at any given time (Antigravity today, maybe
Codex later). Rather than writing a parser per tool, the daemon checks
recent pane output against a list of common phrases. This will have false
negatives on unusual prompts and rare false positives — that's an
accepted tradeoff for staying maintainable. The pattern list lives in a
separate JSON file so you can add phrases you notice being missed,
without touching `server.js`.

## Daemon changes (`daemon/server.js`)

### New file: `daemon/patterns.json`
```json
[
  "proceed?",
  "continue?",
  "\\(y/n\\)",
  "\\[y/n\\]",
  "\\[Y/n\\]",
  "press enter to continue",
  "waiting for approval",
  "do you want to",
  "allow this action"
]
```
Loaded once at startup as case-insensitive regexes. Add to this list as
you notice real prompts that weren't caught — this file is meant to be
hand-edited over time, not treated as finished on day one.

### Per-session waiting state
Extend the existing per-session state map with a `waiting: boolean`
field (default `false`). On every poll (existing 500ms `capture-pane`
cycle), after computing the clean capture, check the last ~3 non-empty
lines against the pattern list.

- If a pattern matches AND `waiting` was `false` → set `waiting = true`,
  send a push notification, and broadcast a `waiting` message (see
  below) to all connected clients.
- If no pattern matches AND `waiting` was `true` → set `waiting = false`
  and broadcast the cleared state. Do not send a push notification for
  this transition — only the "needs you" transition is worth a push.
- If the state hasn't changed, do nothing. **Do not re-notify on every
  poll while still waiting** — that would spam your phone every 500ms.

### Sending the notification
```javascript
await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
  method: 'POST',
  headers: { 'Title': `${sessionName} needs you` },
  body: matchedLine.slice(0, 200) // the line that triggered the match
});
```
Wrap in try/catch — if ntfy.sh is unreachable, log it and keep running.
A failed notification must never crash the daemon or stop polling.

### New WebSocket message type (broadcast to ALL connected clients,
not just subscribers of that session)
```json
{ "type": "waiting", "session": "agent-1", "waiting": true }
```
This lets the client show which session needs attention even if the
phone is currently looking at a different session.

### `.env` addition
```
NTFY_TOPIC=<long random string, generate the same way as AUTH_TOKEN>
```

## Client changes (`client/`)

- On receiving a `waiting` message, update the session picker to show a
  visual indicator (e.g. a dot or 🔴) next to that session's name in the
  dropdown, and remove it when `waiting: false` arrives for that session.
- No other UI changes required. You do not need to build in-app
  notification handling — ntfy's own app/browser handles the actual push;
  the client only needs to reflect waiting state while you're already
  looking at the picker.
- Optionally show a one-time hint in Settings: "Subscribe to your ntfy
  topic in the ntfy app to get push alerts" with the topic name — but
  don't build anything more elaborate than a text hint.

## Non-goals for this phase
- No responding to a prompt directly from the notification (e.g. tapping
  "yes" in the notification itself). Notification just tells you to open
  the app.
- No per-agent custom parsers — one shared pattern list for everything.
- No self-hosted ntfy server — use the free public ntfy.sh.
- No notification history/log in the client UI.
- No email/SMS fallback.

## Acceptance criteria (verify manually)
1. Install the ntfy app (or just open `https://ntfy.sh/<your topic>` in
   a browser tab) and confirm you can receive a manual test push before
   testing the daemon at all: `curl -d "test" ntfy.sh/<your topic>`.
2. Trigger a real approval prompt in one of your agent CLIs (ask it to
   do something that requires a yes/no confirmation) and confirm a push
   notification arrives on your phone within a few seconds.
3. While the CLI is still sitting at that same prompt, confirm no
   second notification arrives — only one push per waiting transition.
4. Approve or dismiss the prompt in the CLI, and confirm the client's
   session picker indicator clears once the daemon's next poll sees the
   prompt is gone.
5. Send normal, non-prompt output through an agent (e.g. it just prints
   regular progress text) and confirm no false-positive notification
   fires.
6. Confirm `NTFY_TOPIC` is a long random string, not something
   guessable, and isn't the same value as `AUTH_TOKEN`.