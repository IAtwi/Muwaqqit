#!/usr/bin/env bash
#
# Install or update Prayer Times on the server. One command, safe to re-run.
#
#   ./deploy.sh
#
# Pulls, rebuilds, self-tests, installs the hourly cron entry if it is missing, and on a
# machine that has never synced, runs the first sync right away.
# .env and state.json are gitignored, so neither is ever touched by a pull.
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd -P)"

if [ ! -f .env ]; then
  echo "No .env here yet. Copy .env.example to .env and fill in the four values (see README.md)."
  exit 1
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "Node.js 20 or newer is required (Node 22 recommended, see README.md)."
  exit 1
fi

echo "==> pulling"
git pull --ff-only

echo "==> installing build tools"
npm ci

echo "==> building"
npm run build

echo "==> self test"
if ! npm run --silent selftest > /tmp/prayer-times-selftest.log 2>&1; then
  tail -n 20 /tmp/prayer-times-selftest.log
  echo "Self test FAILED (full output in /tmp/prayer-times-selftest.log). Not continuing."
  exit 1
fi
tail -n 1 /tmp/prayer-times-selftest.log

# No runtime dependencies: TypeScript is only needed to compile, so node_modules can go.
echo "==> pruning node_modules"
rm -rf node_modules

# Hourly is enough: runs are due at local midnight, and the hourly check also catches up a
# run missed while the server was down. A check that finds nothing due exits silently.
echo "==> cron"
CRON_LINE="0 * * * * cd \"$DIR\" && \"$NODE\" dist/main.js 2>&1 | /usr/bin/logger -t prayer-times"
if crontab -l 2>/dev/null | grep -Fq "logger -t prayer-times"; then
  echo "cron entry already installed:"
  crontab -l | grep -F "logger -t prayer-times"
else
  (crontab -l 2>/dev/null || true; echo "$CRON_LINE") | crontab -
  echo "cron entry installed:"
  echo "$CRON_LINE"
fi

if [ ! -f state.json ]; then
  echo
  echo "==> first sync on this machine"
  echo "    (a failure retries once after 5 minutes; Ctrl+C is safe, the hourly cron retries later)"
  "$NODE" dist/main.js --now || true
fi

"$NODE" dist/main.js --status
