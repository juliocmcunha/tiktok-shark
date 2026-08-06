#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  TikTok -> Roblox Bridge"
echo "============================================"
echo

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies..."
  npm install
  echo
fi

echo "Building TypeScript..."
npm run build

echo
echo "Starting server. Press Ctrl+C to stop."
echo '(the "tiktok>" command console works here normally)'
echo
node dist/server.js
