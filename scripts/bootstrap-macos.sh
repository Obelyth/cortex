#!/usr/bin/env bash
# CORTEX macOS wizard — from a bare Mac to the onboarding wizard.
#
# Two ways in, same script:
#   - double-click "Cortex Setup.command" in a downloaded copy, or
#   - from nothing, one line in Terminal:
#       /bin/bash -c "$(curl -fsSL --proto '=https' --proto-redir '=https' https://raw.githubusercontent.com/Obelyth/cortex/main/scripts/bootstrap-macos.sh)"
#
# It installs the tools Cortex needs — Homebrew, Node, gh, vercel — asking
# before each one, signs you in to GitHub and Vercel, fetches the code when it
# is not already here, then hands off to `npm run onboard`, which does the real
# setup and prints the wiring commands. Nothing installs, and nothing is
# fetched, without a yes at a prompt. Safe to re-run: every step checks before
# it acts, and a step already done is skipped with a check mark.
set -u

CANONICAL="https://github.com/Obelyth/cortex"

bold() { local s="$1"; printf '\n\033[1m%s\033[0m\n' "$s"; return 0; }
ok()   { local s="$1"; printf '  \033[36m✓\033[0m %s\n' "$s"; return 0; }
act()  { local s="$1"; printf '  \033[33m→\033[0m %s\n' "$s"; return 0; }
# Default yes; anything starting with n/N declines. Written for the bash 3.2
# macOS ships — no ${var,,}, which arrived in bash 4.
confirm() {
  local q="$1" a
  read -r -p "  $q [Y/n] " a
  if [[ "$a" == [Nn]* ]]; then
    return 1
  fi
  return 0
}
fail() { local s="$1"; act "$s"; exit 1; }

printf '\n  CORTEX by OBELYTH — macOS setup\n  One memory, every surface. This gets your Mac ready, then hands off to the wizard.\n'

[[ "$(uname -s)" == "Darwin" ]] || fail "this wizard is for macOS — on other systems, follow the README Quickstart."

# ---------------------------------------------------------------- homebrew ---
bold "1 · Homebrew — the standard macOS package manager"
# Both Apple silicon and Intel install locations, for a brew installed earlier
# in this same run or in a previous shell that never touched this PATH.
for p in /opt/homebrew/bin /usr/local/bin; do [[ -d "$p" ]] && PATH="$p:$PATH"; done
if command -v brew >/dev/null 2>&1; then
  ok "Homebrew installed"
else
  act "Homebrew is missing. It installs the rest of the tools; its installer is the official"
  act "   one from brew.sh and will ask for your Mac login password (that is normal)."
  confirm "Install Homebrew now?" || fail "stopped at your request. Nothing was installed."
  # HTTPS only, redirects included — the fetched script runs with this user's rights.
  /bin/bash -c "$(curl -fsSL --proto '=https' --proto-redir '=https' https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || fail "Homebrew install did not finish — re-run this after fixing what it printed."
  for p in /opt/homebrew/bin /usr/local/bin; do [[ -d "$p" ]] && PATH="$p:$PATH"; done
  command -v brew >/dev/null 2>&1 || fail "brew still not on PATH — open a new Terminal window and re-run."
  ok "Homebrew installed"
fi

# ------------------------------------------------------------------- tools ---
bold "2 · The tools Cortex needs"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -e 'console.log(process.versions.node.split(".")[0])')" || return 1
  [[ "$major" -ge 20 ]] || return 1
  return 0
}
if node_ok; then ok "Node $(node -v) (needs 20+)"
else
  confirm "Install Node (via brew)?" || fail "Cortex needs Node 20+. Stopped."
  brew install node || fail "brew install node failed — re-run after fixing what it printed."
  node_ok || fail "Node is still missing or older than 20 — open a new Terminal and re-run."
  ok "Node $(node -v) installed"
fi
if command -v gh >/dev/null 2>&1; then ok "GitHub CLI (gh) installed"
else
  confirm "Install the GitHub CLI, gh (via brew)?" || fail "Cortex needs gh to create your private brain repo. Stopped."
  brew install gh || fail "brew install gh failed — re-run after fixing what it printed."
  ok "gh installed"
fi
if command -v vercel >/dev/null 2>&1; then ok "Vercel CLI installed"
else
  # Via brew, not npm -g: the formula ships prebuilt, so no package lifecycle
  # script runs during install, and brew keeps it updated with everything else.
  confirm "Install the Vercel CLI (via brew)?" || fail "Cortex deploys on Vercel and needs its CLI. Stopped."
  brew install vercel-cli || fail "brew install vercel-cli failed — re-run after fixing what it printed."
  ok "vercel installed"
fi

# ---------------------------------------------------------------- sign in ---
bold "3 · Sign in — GitHub holds your notes, Vercel runs your server"
if gh auth status >/dev/null 2>&1; then
  ok "GitHub: signed in as $(gh api user --jq .login 2>/dev/null || echo you)"
else
  act "GitHub sign-in opens in your browser; accept the defaults at each prompt."
  gh auth login || fail "GitHub sign-in did not finish — re-run when ready."
  ok "GitHub: signed in"
fi
if vercel whoami >/dev/null 2>&1; then
  ok "Vercel: signed in as $(vercel whoami 2>/dev/null)"
else
  act "Vercel sign-in opens in your browser (a free Hobby account is enough)."
  vercel login || fail "Vercel sign-in did not finish — re-run when ready."
  ok "Vercel: signed in"
fi

# ---------------------------------------------------------------- the code ---
bold "4 · The code"
is_cortex() {
  local dir="$1"
  [[ -f "$dir/package.json" ]] || return 1
  grep -q '"name": "cortex"' "$dir/package.json" || return 1
  return 0
}
if is_cortex "$PWD"; then
  ok "already inside a Cortex copy: $PWD"
else
  DEST_DEFAULT="$HOME/cortex"
  read -r -p "  Where should Cortex live? [$DEST_DEFAULT] " DEST
  DEST="${DEST:-$DEST_DEFAULT}"
  if is_cortex "$DEST"; then
    ok "found an existing copy at $DEST — using it"
  elif [[ -e "$DEST" ]]; then
    fail "$DEST exists and is not a Cortex copy — pick another location and re-run."
  else
    git clone "$CANONICAL" "$DEST" || fail "clone failed — check the network and re-run."
    ok "cloned to $DEST"
  fi
  cd "$DEST" || fail "could not enter $DEST"
fi

# ----------------------------------------------------------------- handoff ---
bold "5 · Hand off to the wizard"
act "installing the exact pinned dependencies (a minute or two)…"
# --ignore-scripts: no dependency lifecycle script runs on this machine, same
# policy as the release workflow — which proves on every tag that the suite and
# build pass without them. The deploy builds on Vercel's side either way.
npm ci --ignore-scripts || fail "npm ci failed — re-run after fixing what it printed."
ok "dependencies installed"
act "starting the onboarding wizard — it creates your private brain, deploys, and verifies."
exec npm run onboard
