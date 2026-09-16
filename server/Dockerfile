# Relay service: plain node + ws, no build step.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY relay.mjs .
EXPOSE 8081
CMD ["node", "relay.mjs"]
