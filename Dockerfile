# ───────────────────────────────────────────────────────────────
# Nexus Erebus Agent – container image
# ───────────────────────────────────────────────────────────────
FROM node:22-slim

# Optional: install git & build‑essentials (only if you still rely on ensure‑deps.js)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git build-essential make && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Install node deps *before* running ensure‑deps to cache layers
RUN npm ci --omit=dev

# Build the bundled helper repos (agent-twitter-client, Redis) once
RUN node ensure-deps.js

# Don’t run Redis inside the container – it’s provided by docker‑compose.
# Strip the Redis server binary to save a few MB
RUN rm -rf ./redis

# Make node faster/safer in docker
ENV NODE_ENV=production \
    TZ=UTC

# Copy your .env at runtime via docker‑compose secrets or bind‑mount
CMD ["npm", "start"]
