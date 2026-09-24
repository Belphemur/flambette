# Relay service: zero-dependency Bun WebSocket relay, no build step.
FROM oven/bun:1-alpine
WORKDIR /app
COPY relay.mjs .
EXPOSE 8081
CMD ["bun", "relay.mjs"]