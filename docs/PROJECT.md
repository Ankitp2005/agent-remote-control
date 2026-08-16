# Project: phone-controlled coding agents

## What this is
A personal tool that lets you send prompts to AI coding agent CLI sessions
(Codex CLI, Antigravity CLI, etc.) running on your PC, from your phone,
over your own private network. You see streamed output on your phone and
can send follow-up prompts, without being at your desk.

This is NOT a hosted product, NOT multi-user, and NOT meant to be exposed
to the public internet. It is a single-user remote control for tools you
already run locally.

## Hard constraints (do not violate these)
- **Zero ongoing cost.** No paid hosting, no VPS, no cloud database, no
  paid push notification tier. Everything runs on the user's own PC.
- **No public internet exposure.** All traffic between phone and PC goes
  over a Tailscale private network (WireGuard-based mesh VPN). The daemon
  must bind only to the Tailscale interface, never 0.0.0.0 on a public IP.
- **Agents are not modified.** Codex CLI, Antigravity CLI, etc. run exactly
  as they would if a human started them in a terminal. This system observes
  and forwards to their existing terminal interface — it does not use any
  private API of theirs.
- **tmux is the persistence layer.** Agent processes run inside named tmux
  sessions so they survive phone disconnects, app kills, and network drops.
  Do not build custom session-persistence logic — tmux already does this.

## Build order (do not skip ahead)
This project ships in phases. Each phase must work end-to-end and be
manually verified before the next phase starts. See PHASE-1-SPEC.md for
the first phase in full detail. Do not implement phases 5-6 (multi-session
switching, approval-detection push alerts) until phases 1-4 are working
and manually tested by the user.

1. Tailscale connectivity confirmed (no code — manual setup)
2. One agent running in one named tmux session (no code — manual setup)
3. Daemon proxies that one session over a WebSocket (**PHASE-1-SPEC.md**)
4. Phone web client (PWA) talks to the daemon (**PHASE-1-SPEC.md**)
5. Multi-session registry + switching (future spec, not yet written)
6. Approval detection + push notifications via ntfy.sh (future spec, not
   yet written)

## Stack decisions (locked, do not deviate without asking the user)
- **Daemon**: Node.js. Uses `ws` for WebSockets and shells out to `tmux`
  directly via `child_process`.
- **Transport**: raw WebSocket, JSON messages (schema in PHASE-1-SPEC.md).
  No socket.io, no REST, no GraphQL — this does not need any of that.
- **Session capture**: `tmux capture-pane` polling (see PHASE-1-SPEC.md for
  interval and diffing approach). Not `node-pty`, not `pipe-pane` — keep
  it simple for phase 1.
- **Client**: plain HTML/CSS/JS PWA. No React, no build step, no framework.
  A single `index.html` + a small `app.js` is the target. This keeps the
  whole client inspectable and edit-able without a toolchain.
- **Storage**: none needed yet. Phase 1 hardcodes a single session name.
  Do not add a database or config file until phase 5 needs a registry.

## Explicit non-goals (do not build these unless a later spec asks for them)
- No user accounts or multi-user auth beyond a single shared secret token.
- No web dashboard beyond the mobile-first client described here.
- No support for GUI-only agents with no CLI/API surface.
- No retry/backoff frameworks, no message queues, no database migrations.
- No Docker/containerization — this runs as a plain process on the user's
  own machine.