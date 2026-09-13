#!/bin/bash
# Linux entry point for the existing hosted Cortex onboarding wizard.
# Use the extracted source archive. Install system prerequisites yourself;
# this script does not choose a distro package manager or install system tools.
set -u

README="https://github.com/Obelyth/cortex/blob/main/README.md"
ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)" || exit 1
cd -- "$ROOT" || exit 1

stop() {
  local status="$1" message="$2"
  printf '\nSetup stopped: %s\n' "$message" >&2
  exit "$status"
}
prerequisite() {
  printf '\nPrerequisite needed: %s\nInstall or repair it using its official instructions, then reopen your terminal and rerun setup.\nSee README.md in this source archive, or %s\n' "$1" "$README" >&2
  exit 1
}
confirm() {
  local answer
  printf '\n%s [y/N] ' "$1"
  IFS= read -r answer || return 1
  case "$answer" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

printf '\nCORTEX by OBELYTH — Linux setup\nThis prepares the extracted source and starts the hosted onboarding wizard.\n'
[[ "$(uname -s)" == "Linux" ]] || prerequisite "Linux. On macOS, use Cortex Setup.command; for other systems, follow the README."
[[ -f package.json && -f package-lock.json && -f scripts/onboard.mjs ]] || prerequisite "A complete extracted Cortex source archive, including package-lock.json and scripts/onboard.mjs."

# Finish every local prerequisite check before installing dependencies, checking
# provider accounts, or opening a browser. Do not auto-install system tools.
command -v node >/dev/null 2>&1 || prerequisite "Node.js >=22.18.0 and <23, with its matching npm (https://nodejs.org/en/download)."
node_version="$(node --version 2>/dev/null)" || prerequisite "A working Node.js >=22.18.0 and <23."
if [[ ! "$node_version" =~ ^v22\.([0-9]+)\.([0-9]+)$ ]] || (( 10#${BASH_REMATCH[1]:-0} < 18 )); then
  prerequisite "Node.js >=22.18.0 and <23; found $node_version. Select a supported Node 22 release (https://nodejs.org/en/download)."
fi

command -v npm >/dev/null 2>&1 || prerequisite "npm supplied with the supported Node.js installation (https://nodejs.org/en/download)."
npm_version="$(npm version --json 2>/dev/null)" || prerequisite "A working npm for Node.js $node_version."
node -e '
  try {
    const versions = JSON.parse(process.argv[2]);
    if (versions.node !== process.argv[1].slice(1) || !/^\d+\.\d+\.\d+$/.test(versions.npm)) process.exit(1);
  } catch { process.exit(1); }
' "$node_version" "$npm_version" || prerequisite "npm running on the same Node.js $node_version selected by this terminal. Repair your Node/npm PATH before continuing."

command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1 || prerequisite "Git (https://git-scm.com/download/linux)."
command -v gh >/dev/null 2>&1 && gh --version >/dev/null 2>&1 || prerequisite "GitHub CLI, gh (https://cli.github.com/)."
command -v vercel >/dev/null 2>&1 || prerequisite "Vercel CLI >=50.5.1 (https://vercel.com/docs/cli)."
vercel_version="$(vercel --version 2>&1)" || prerequisite "A working Vercel CLI >=50.5.1 (https://vercel.com/docs/cli)."
if [[ "$vercel_version" =~ (^|[[:space:]])([0-9]+)\.([0-9]+)\.([0-9]+)($|[[:space:]]) ]]; then
  major="${BASH_REMATCH[2]}" minor="${BASH_REMATCH[3]}" patch="${BASH_REMATCH[4]}"
  (( 10#$major > 50 || (10#$major == 50 && (10#$minor > 5 || (10#$minor == 5 && 10#$patch >= 1))) )) \
    || prerequisite "Vercel CLI >=50.5.1; found $vercel_version."
else
  prerequisite "A stable Vercel CLI >=50.5.1 with a readable version; found $vercel_version."
fi
vercel api --help >/dev/null 2>&1 || prerequisite "Vercel CLI >=50.5.1 with a working api command (https://vercel.com/docs/cli)."

printf '\nPrerequisites ready. Source directory: %s\n' "$ROOT"
confirm "Install the locked npm dependencies in this directory with npm ci --ignore-scripts?" \
  || stop 1 "Dependency installation declined or input ended."
npm ci --ignore-scripts || stop "$?" "npm ci failed. Resolve the error above before rerunning setup."

confirm "Check GitHub and Vercel sign-in now? These checks contact the providers; any browser login will ask separately." \
  || stop 1 "Sign-in checks declined or input ended. Dependencies already installed remain in this source directory."
if ! gh auth status >/dev/null 2>&1; then
  confirm "Open GitHub's browser login with gh? Review the account and access grant in your browser." \
    || stop 1 "GitHub sign-in declined or input ended."
  gh auth login --hostname github.com --git-protocol https --web \
    || stop "$?" "GitHub sign-in did not finish."
  gh auth status >/dev/null 2>&1 || stop "$?" "GitHub sign-in could not be verified."
fi
if ! vercel whoami >/dev/null 2>&1; then
  confirm "Open Vercel's browser login? Review the account and access grant in your browser." \
    || stop 1 "Vercel sign-in declined or input ended."
  vercel login || stop "$?" "Vercel sign-in did not finish."
  vercel whoami >/dev/null 2>&1 || stop "$?" "Vercel sign-in could not be verified."
fi

printf '\nThe existing wizard can create a private GitHub brain and deploy Cortex to Vercel after its own confirmations.\nIt does not install a desktop app or local server, create a database, or apply database migrations.\n'
confirm "Start the hosted onboarding wizard now?" || stop 1 "Wizard start declined or input ended."
npm run onboard || stop "$?" "The onboarding wizard did not finish. Earlier confirmed actions may already have completed."
