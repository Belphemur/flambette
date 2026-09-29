# Relay service: zero-dependency Bun WebSocket relay, no build step.
FROM oven/bun:1-alpine
WORKDIR /app
# Copy the WHOLE runtime surface, not a hand-picked list. relay.mjs imports
# ./throttle.mjs, and a missing sibling module is a startup crash-loop that
# `docker build` alone never catches — naming files one by one meant adding a
# module silently broke the published image (issue #6). Keep the glob.
COPY *.mjs ./
EXPOSE 8081
CMD ["bun", "relay.mjs"]
