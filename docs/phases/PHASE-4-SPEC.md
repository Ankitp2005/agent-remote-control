# Phase 4 spec: automatic startup on PC login

## Goal
Right now, using this from your phone requires manually opening WSL,
starting the daemon, attaching to tmux, and launching `agy` — every time
you reboot. This phase automates all of that to run the moment you log
into Windows, so the phone client is ready without touching a terminal.

This does NOT keep anything running while your PC is off or asleep —
that's a hardware/power tradeoff outside this project's scope, not
something this phase claims to solve.

## Design decision: Task Scheduler + a WSL shell script, not a Windows service
A proper Windows service wrapping WSL is more complex than this needs.
Task Scheduler firing "at log on" and running one shell script inside WSL
is simpler, easier to debug, and easy to disable/modify later if you
change your mind. Do not build a Windows service for this.

## New file: `daemon/scripts/start-all.sh`

This script must be **idempotent** — safe to run multiple times without
creating duplicate daemon processes or duplicate tmux sessions. Task
Scheduler firing twice, or you running it manually while it's already
running, must not break anything.

### Responsibilities, in order:

1. **Wait for Tailscale to be ready**, up to a reasonable timeout (e.g.
   30 seconds), polling `tailscale ip -4` every 2 seconds until it
   returns a valid IP. If it never comes up, log the failure clearly and
   exit — don't let the daemon try to bind to an IP that doesn't exist
   yet.

2. **Check if the daemon is already running** before starting it. Simple
   approach: check if anything is already listening on the daemon's port
   (e.g. via `lsof -i :8787` or attempting a quick connection). If it's
   already up, skip starting it again and log that it was already
   running.

3. **Start the daemon in the background if not already running**, with
   output redirected to a log file (e.g. `daemon/logs/daemon.log`) so you
   can check what happened without needing a live terminal open. Use
   `nohup ... &` or an equivalent backgrounding approach.

4. **Check if the `agent-1` tmux session already exists.** If not,
   create it (`tmux new -d -s agent-1` — the `-d` flag creates it
   detached, without needing an attached terminal).

5. **Check if `agy` is already running inside that session** (e.g. by
   checking the pane's running command via
   `tmux list-panes -t agent-1 -F "#{pane_current_command}"`). If it's
   just sitting at a plain bash prompt, start `agy` inside it via
   `tmux send-keys -t agent-1 "agy" Enter`. If `agy` is already running,
   leave it alone — do not restart it and interrupt whatever it's doing.

6. **Log a final summary line** stating what was started vs. what was
   already running, so a glance at the log tells you the full story.

## Windows Task Scheduler configuration

- **Trigger:** "At log on" (for your specific user account).
- **Action:** Start a program:
  - Program: `wsl.exe`
  - Arguments: `-d <your-distro-name> -e bash -c "~/agent-remote-control/daemon/scripts/start-all.sh"`
  (Replace `<your-distro-name>` with your actual WSL distro name, e.g.
  `Ubuntu` — confirm via `wsl -l -v` in PowerShell if unsure.)
- **Settings tab:** check "Run whether user is logged on or not" only if
  you're comfortable with that; otherwise leave default (run only when
  logged on, which matches this phase's actual goal).
- Add a short delay (1-2 minutes) if you notice Tailscale isn't reliably
  up by the time this fires — Task Scheduler has a "delay task for"
  option under triggers for exactly this.

## Non-goals for this phase
- No automatic restart if the daemon or `agy` crashes after startup —
  this phase only handles the login-time launch, not ongoing process
  supervision. A crash-recovery/health-check system would be a separate,
  later phase if you decide you need it.
- No running while the PC is asleep, hibernating, or shut down.
- No Windows service wrapper.
- No multi-session auto-start — this phase only ensures `agent-1` (your
  primary session) comes up automatically. Additional sessions are still
  started manually, same as today.

## Acceptance criteria (verify manually)
1. Reboot your PC, log in normally, and — without opening any terminal
   yourself — wait about a minute, then check `daemon/logs/daemon.log`
   shows it started successfully and bound to the correct Tailscale IP.
2. Without touching a terminal, open the phone client and confirm it
   connects and shows "Subscribed: agent-1" on its own.
3. Attach to `tmux attach -t agent-1` afterward (just to check, this is
   allowed) and confirm `agy` is genuinely running, not just bash.
4. Run `start-all.sh` manually a second time while everything is already
   running, and confirm the log shows "already running" messages instead
   of starting duplicate processes or sessions.
5. Restart just the daemon process manually (kill it, don't reboot) and
   run the script again — confirm it correctly detects the daemon is
   down and restarts only that piece, without touching the already-fine
   tmux/agy session.