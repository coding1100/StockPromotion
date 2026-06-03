#!/bin/sh
set -e

# Start virtual display
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
export DISPLAY=:99

# Give Xvfb a moment to initialise
sleep 1

# Start VNC server (no password, localhost only inside the container)
x11vnc -display :99 -forever -nopw -shared -bg -quiet

# Start noVNC websocket proxy on port 6080, serving the noVNC web files
websockify --web=/usr/share/novnc 6080 localhost:5900 &

# Run the app
exec sh -c "npx prisma migrate deploy && node dist/main.js"
