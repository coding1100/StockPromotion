#!/bin/sh
set -e

# Start virtual display
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
export DISPLAY=:99

# Give Xvfb a moment to initialise
sleep 1

# VNC is published on 6080 — require a password; in production fail closed.
if [ -n "$VNC_PASSWORD" ]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/.vncpass >/dev/null 2>&1
  x11vnc -display :99 -forever -rfbauth /tmp/.vncpass -shared -bg -quiet
  websockify --web=/usr/share/novnc 6080 localhost:5900 &
elif [ "$NODE_ENV" != "production" ]; then
  x11vnc -display :99 -forever -nopw -shared -bg -quiet
  websockify --web=/usr/share/novnc 6080 localhost:5900 &
else
  echo "VNC/noVNC disabled: set VNC_PASSWORD to enable the live browser view in production"
fi

# Run the app
exec sh -c "npx prisma migrate deploy && node dist/main.js"
