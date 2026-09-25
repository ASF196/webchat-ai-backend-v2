#!/usr/bin/env bash
# start.sh — one command to get the WebChat AI backend running.
# Usage: ./start.sh   (from inside the webchat-ai-backend folder)

set -e
cd "$(dirname "$0")"

echo "── WebChat AI Backend ──"

# 1. Install dependencies if not already installed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run only)…"
  npm install
fi

# 2. Create .env from the example if it doesn't exist yet
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo ""
  echo "⚠️  Created .env from .env.example — you MUST edit it before this works:"
  echo "    1. Open .env in any text editor"
  echo "    2. Set GROQ_API_KEY to your real key (get one free at console.groq.com)"
  echo "    3. Set ADMIN_SECRET to any long random string"
  echo ""
  echo "Then run ./start.sh again."
  exit 0
fi

# 3. Warn if the key still looks like a placeholder
if grep -q "gsk_your_real_key_here" .env; then
  echo ""
  echo "⚠️  GROQ_API_KEY in .env still looks like the placeholder value."
  echo "    Edit .env and add your real Groq key before chatting will work."
  echo "    (The server will still start — admin/embed endpoints work fine —"
  echo "     but /api/chat replies will fail until the key is set.)"
  echo ""
fi

# 4. Start the server
echo "Starting server…"
node server.js
