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

# Kill heartbeat service if running
HEARTBEAT_LOCK_FILE=~/.dialogue-heartbeat.lock
if [ -f "$HEARTBEAT_LOCK_FILE" ]; then
    PID=$(cat "$HEARTBEAT_LOCK_FILE")
    echo "Killing existing heartbeat service (PID: $PID)..."
    kill -9 "$PID"
    rm "$HEARTBEAT_LOCK_FILE"
fi

# Clear reply queue
REPLY_QUEUE_FILE=~/.dialogue-reply-views.json
if [ -f "$REPLY_QUEUE_FILE" ]; then
    echo "Clearing reply queue..."
    rm "$REPLY_QUEUE_FILE"
fi

echo "--- Starting services... ---"

# Start the realtime service in the background, detached from terminal
echo "Starting realtime service in the background..."
nohup npm run realtime > /tmp/dialogue-realtime.log 2>&1 &
REALTIME_PID=$!
disown "$REALTIME_PID"
echo "Realtime service started with PID: $REALTIME_PID (detached)"
echo "Logs: /tmp/dialogue-realtime.log"

# Give it a moment to initialize
sleep 2

# Start the archive service in the background, detached from terminal
echo "Starting archive service in the background..."
nohup npm run archive > /tmp/dialogue-archive.log 2>&1 &
ARCHIVE_PID=$!
disown "$ARCHIVE_PID"
echo "Archive service started with PID: $ARCHIVE_PID (detached)"
echo "Logs: /tmp/dialogue-archive.log"

# Start the heartbeat service in the background, detached from terminal
echo "Starting heartbeat service in the background..."
nohup npm run heartbeat > /tmp/dialogue-heartbeat.log 2>&1 &
HEARTBEAT_PID=$!
disown "$HEARTBEAT_PID"
echo "Heartbeat service started with PID: $HEARTBEAT_PID (detached)"
echo "Logs: /tmp/dialogue-heartbeat.log"

echo "--- Done. Both services running in the background. ---"
echo "Realtime PID: $REALTIME_PID | Archive PID: $ARCHIVE_PID | Heartbeat PID: $HEARTBEAT_PID"
echo "Re-run this script to stop and restart both."
