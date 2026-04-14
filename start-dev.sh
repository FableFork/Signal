#!/usr/bin/env bash
# Start SIGNAL in development mode
# Usage: ./start-dev.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting SIGNAL backend on :8000 ..."
cd "$ROOT/backend"
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

echo "Starting SIGNAL frontend on :5173 ..."
cd "$ROOT/frontend"
npm run dev -- --port 5173 &
FRONTEND_PID=$!

echo ""
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop both."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo 'Stopped.'" EXIT INT TERM
wait
