# Build stage: install deps and produce the production bundle in dist/
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# The displayed app version is a build-time fact (ADR-0039); the Docker
# build has no git metadata and no CI env, so the release workflow passes
# the tag explicitly (see release.yml's build-args).
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
RUN bun run build

# Serve stage: static nginx with SPA fallback + cache headers
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80