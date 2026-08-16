# Architecture

## Layers

```
[Phone: PWA client]
        |  WebSocket, JSON messages
        v
[Tailscale tunnel]  -- encrypted, no port forwarding, no public IP
        |
        v
[Relay daemon, runs on the PC, Node.js]
        |  tmux send-keys / capture-pane
        v
[Agent session: tmux, running Codex CLI / Antigravity CLI / etc.]
```

## Layer responsibilities

### Phone client (PWA)
- Sends prompt text to the daemon over a WebSocket.
- Renders streamed output as it arrives.
- Holds no state about tmux, agents, or the PC. It only knows the daemon's
  WebSocket URL and message schema.
- Must not talk to anything except the daemon.

### Tailscale tunnel
- Not code you write. An installed app on both phone and PC that puts them
  on the same private virtual network.
- The daemon's WebSocket server binds to the PC's Tailscale IP
  (`100.x.x.x` range), not `0.0.0.0` and not the PC's LAN/public IP.
- The phone connects to that Tailscale IP directly, from anywhere with
  internet, without any port forwarding on the home router.

### Relay daemon (Node.js, on the PC)
- The only layer with real logic. Responsibilities:
  1. Run a WebSocket server bound to the Tailscale interface.
  2. Authenticate incoming connections with a shared secret token
     (see PHASE-1-SPEC.md).
  3. On a `prompt` message, run `tmux send-keys` into the target session.
  4. Poll `tmux capture-pane` on an interval, diff against the last known
     pane content, and push only the new text to connected clients as
     `output` messages.
  5. Track very minimal session state in memory (phase 1: a single
     hardcoded session name; phase 5+: a registry).
- Does not parse or understand agent-specific output in phase 1. It is a
  dumb pipe. Understanding output (e.g. detecting "waiting for approval")
  is phase 6 only.

### Agent session (tmux)
- A named tmux session (e.g. `tmux new -s agent-codex-1`) running the
  agent CLI exactly as a human would start it.
- Survives daemon restarts and phone disconnects on its own — tmux is
  already a persistent process, independent of the daemon.
- The daemon interacts with it only via `tmux send-keys` and
  `tmux capture-pane`, never by touching the agent process directly.

## Why this shape (for the coding agent building it — do not deviate)
- Each layer only knows about the layer directly next to it. The phone
  never talks to tmux. The daemon never renders UI. This is deliberate:
  it means any layer can be replaced later (e.g. swap tmux capture-pane
  polling for node-pty streaming) without touching the others.
- tmux is treated as the source of truth for session persistence. Do not
  duplicate that logic (e.g. do not build your own "keep process alive"
  supervisor) — it already exists and is battle-tested.