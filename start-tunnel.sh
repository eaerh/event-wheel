#!/bin/bash
# Start Event Wheel with a public tunnel
# Usage: ./start-tunnel.sh

set -e

cd "$(dirname "$0")"

echo "🔨 Building frontend..."
cd frontend && npm run build --silent && cd ..

echo "🚀 Starting backend..."
cd backend
uv run python main.py &
BACKEND_PID=$!
cd ..

# Wait for backend to be ready
echo "⏳ Waiting for backend..."
for i in $(seq 1 10); do
    if curl -s http://localhost:8000/api-info > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

echo "🌐 Starting Cloudflare tunnel..."
# Capture tunnel output to extract URL
TUNNEL_LOG=$(mktemp)
cloudflared tunnel --url http://localhost:8000 2>&1 | tee "$TUNNEL_LOG" &
TUNNEL_PID=$!

# Wait for tunnel URL to appear
TUNNEL_URL=""
for i in $(seq 1 15); do
    TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then
        break
    fi
    sleep 1
done
rm -f "$TUNNEL_LOG"

# Tell the backend the public URL so the frontend can use it for share links
if [ -n "$TUNNEL_URL" ]; then
    export PUBLIC_URL="$TUNNEL_URL"
    # Restart backend with the env var set
    kill $BACKEND_PID 2>/dev/null
    sleep 1
    cd backend
    PUBLIC_URL="$TUNNEL_URL" uv run python main.py &
    BACKEND_PID=$!
    cd ..
    sleep 2
fi

cleanup() {
    echo ""
    echo "🛑 Shutting down..."
    kill $BACKEND_PID 2>/dev/null
    kill $TUNNEL_PID 2>/dev/null
    exit 0
}
trap cleanup INT TERM

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  ✅ Event Wheel is running!                           ║"
echo "║                                                        ║"
echo "║  Local:  http://localhost:8000                         ║"
if [ -n "$TUNNEL_URL" ]; then
echo "║  Public: $TUNNEL_URL  ║"
echo "║                                                        ║"
echo "║  👆 Share this URL with your group!                    ║"
fi
echo "╠════════════════════════════════════════════════════════╣"
echo "║  Press Ctrl+C to stop                                  ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

wait
