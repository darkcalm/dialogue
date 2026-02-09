#!/bin/bash

# A simple orchestration script to run the realtime and archive services.

echo "--- Stopping any existing services... ---"
# Kill realtime service if running
REALTIME_LOCK_FILE=~/.dialogue-realtime.lock
if [ -f "$REALTIME_LOCK_FILE" ]; then
    PID=$(cat "$REALTIME_LOCK_FILE")
    echo "Killing existing realtime service (PID: $PID)..."
    kill -9 "$PID"
    rm "$REALTIME_LOCK_FILE"
fi

# Kill archive service if running
ARCHIVE_LOCK_FILE=~/.dialogue-archive.lock
if [ -f "$ARCHIVE_LOCK_FILE" ]; then
    PID=$(cat "$ARCHIVE_LOCK_FILE")
    echo "Killing existing archive service (PID: $PID)..."
    kill -9 "$PID"
    rm "$ARCHIVE_LOCK_FILE"
fi

echo "--- Starting services... ---"

# Start the realtime service in the background
echo "Starting realtime service in the background..."
npm run realtime &
REALTIME_PID=$!
echo "Realtime service started with PID: $REALTIME_PID"

# Give it a moment to initialize
sleep 2

# Start the archive service in the foreground
echo "Starting archive (frontfill) service in the foreground..."
npm run archive

# After archive finishes, keep the realtime service running
echo "Archive service finished. Realtime service continues running..."
echo "Realtime service PID: $REALTIME_PID"
echo "To stop the realtime service, run: kill $REALTIME_PID"

# Wait for the realtime service to finish (it should run indefinitely)
echo "--- Waiting for realtime service... (Press Ctrl+C to stop) ---"
wait "$REALTIME_PID"

echo "--- Realtime service stopped. ---"