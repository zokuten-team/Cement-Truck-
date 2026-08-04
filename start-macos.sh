#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required: https://nodejs.org/"
  exit 1
fi

npm install

echo "Opening My Trucks at http://localhost:3000"
open "http://localhost:3000" >/dev/null 2>&1 || true
npm start
