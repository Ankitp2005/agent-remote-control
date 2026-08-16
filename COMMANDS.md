# COMMANDS.md — Quick Reference
# All commands are documentation only. Nothing here runs automatically.
# Copy-paste the ones you need into your terminal.

---

## 0. ⚡ Start Here — Full Launch Sequence (Windows → WSL → Daemon)

```powershell
# ── Step 1: Open WSL from Windows PowerShell / Terminal ──────────────────────
wsl

# ── Step 2: Inside WSL — navigate to the daemon directory ────────────────────
# Note: username has a space, so wrap the path in quotes
cd "/mnt/c/Users/Ankit pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/daemon"

# If you cloned directly inside WSL home, use this instead:
# cd ~/agent-remote-control/daemon

# ── Step 3: Start the daemon ──────────────────────────────────────────────────
npm start
```

> **Tip:** Run steps 2 & 3 in a single line (inside WSL):
> ```bash
> cd "/mnt/c/Users/Ankit pandey/OneDrive/Desktop/mobilePrompting/agent-remote-control/daemon" && npm start
> ```

---

## 0.1 🤖 Antigravity CLI & Agent Commands

```powershell
# ── Launch Antigravity CLI from Windows PowerShell ────────────────────────────
antigravity-ide .

# ── Launch Antigravity CLI from WSL (Linux terminal) ──────────────────────────
"C:\Users\Ankit pandey\AppData\Local\Programs\Antigravity IDE\bin\antigravity-ide.cmd" .
```

### Running an Agent Session in tmux (for Remote Control)

```bash
# 1. Open WSL
wsl

# 2. Create a new tmux session named agent-1 (or antigravity)
tmux new -s agent-1

# 3. Inside tmux — run your desired CLI agent or command

# 4. Detach from tmux (leaves session running in background):
# Press Ctrl+B, release, then press D

# 5. Re-attach to session anytime:
tmux attach -t agent-1
```

> **Important tmux & CLI Notes:**
> - **`duplicate session` error:** Means the session already exists or you are **already inside tmux** (look for the green bar `[antigravi0:bash*]` at the bottom of the screen).
> - **`command not found` error:** `agent-1` or `antigravity` is the tmux session name, not a command. Type actual installed CLI tools inside the session.

---

## 1. WSL — Launch & Navigate

```bash
# Open WSL (from Windows PowerShell / Terminal)
wsl

# Open WSL in a specific distro
wsl -d Ubuntu

# List installed distros
wsl --list --verbose

# Shutdown all WSL instances
wsl --shutdown

# Check WSL version
wsl --version
```

---

## 2. Tailscale — Network

```bash
# Get this machine's Tailscale IP (put this in BIND_IP in .env)
tailscale ip -4

# Check Tailscale status + peers
tailscale status

# Bring Tailscale up
sudo tailscale up

# Bring Tailscale down
sudo tailscale down
```

---

## 3. tmux — Session Management

```bash
# List all active tmux sessions
tmux ls

# Create a new named session (e.g. agent-1)
tmux new -s agent-1

# Attach to existing session
tmux attach -t agent-1

# Detach from current session (inside tmux)
# Ctrl+B  then  D

# Kill a specific session
tmux kill-session -t agent-1

# Kill ALL sessions
tmux kill-server

# Rename a session
tmux rename-session -t old-name new-name

# Create a new window inside a session
# Ctrl+B  then  C

# Switch between windows
# Ctrl+B  then  N  (next)
# Ctrl+B  then  P  (prev)
```

---

## 4. Daemon — Start / Stop

```bash
# Navigate to daemon folder (inside WSL)
cd ~/agent-remote-control/daemon
# or wherever you cloned it on Linux side

# Install dependencies (first time only)
npm install

# Start the daemon
npm start
# or directly:
node server.js

# Run with a custom .env file path
NODE_ENV=production node server.js

# Generate a secure AUTH_TOKEN (run once, paste into .env)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 5. Git — Common Workflow

```bash
# Check what's changed
git status

# Stage specific folder
git add client
git add daemon

# Stage everything
git add .

# Commit
git commit -m "feat: your message here"

# Push to GitHub
git push

# Pull latest from remote
git pull

# View recent commits
git log --oneline -10

# Undo last commit (keep changes staged)
git reset --soft HEAD~1

# Discard all local changes (DANGER — irreversible)
git checkout -- .
```

---

## 6. .env Setup

```bash
# Copy the example env file (first time setup)
cp daemon/.env.example daemon/.env

# Edit it
nano daemon/.env

# Find your Tailscale IP to fill BIND_IP
tailscale ip -4
```

---

## 7. Node / npm Utilities

```bash
# Check Node version (requires >=18)
node --version

# Check npm version
npm --version

# Update all dependencies to latest compatible versions
npm update

# Check for outdated packages
npm outdated

# Install a new package and save to package.json
npm install <package-name>

# Remove a package
npm uninstall <package-name>
```

---

## 8. Serve Client (PWA) Locally for Testing

```bash
# Quickest local server (Python, no install needed)
python3 -m http.server 3000 --directory client

# Or with npx serve
npx serve client -p 3000

# Then open: http://localhost:3000
```

---

## 9. Networking / Debug

```bash
# Check if daemon port is listening
ss -tlnp | grep 8787

# Test WebSocket connection from command line
# (requires wscat: npm install -g wscat)
wscat -c ws://<TAILSCALE_IP>:8787

# Check open ports on the machine
ss -tlnp

# Ping Tailscale peer
ping 100.x.x.x
```

---

## 10. Process Management

```bash
# Find the daemon process
ps aux | grep server.js

# Kill it by PID
kill <PID>

# Kill it forcefully
kill -9 <PID>

# Run daemon in background (nohup, survives terminal close)
nohup node server.js &> daemon.log &

# View live daemon logs (if running via nohup)
tail -f daemon.log
```


<!-- Switch folders inside agy	:- /cd path\to\folder -->