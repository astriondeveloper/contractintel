# Contract Intelligence + Integration Engine
#
# Spec section 16:
#   Runtime        Container. Configuration from environment variables.
#   Cloud coupling None. Do not use Cloudflare D1. Do not use worker bindings.
#   Secrets        Environment variables. Never in the repository.
#
# This image runs anywhere a container runs. Moving to Azure Container Apps is a
# deployment task: point DATABASE_URL at Azure Database for PostgreSQL Flexible
# Server and set PGSSLMODE=require. No code changes. Spec section 2.3.

FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM base AS runtime

# tini reaps zombies and forwards signals, so a scheduled load can be stopped cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src

# The scheduled drop directory. Spec decision D8 permits scheduled file drops and
# forbids manual ad hoc uploads, so this is a mount point, not an upload endpoint.
#
# The seed directory is a mount point too, and deliberately empty in the image. The three
# authored seed files are DACIS-derived and Gate A came back no on 14 August 2026, so they
# are not in the repository and are not baked into the image. Mount them at run time and
# point CIE_SEED_DIR at the mount. Building them in would put them in every image layer
# and in every registry the image is pushed to, which is the thing Gate A forbids.
RUN mkdir -p /app/data/drops /app/data/seed

# Run as a non-root user.
RUN chown -R node:node /app
USER node

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]

# Serve the interface by default. It is the only long-running process in the build and
# the thing Azure Container Apps is asked to run, so the image should do it without an
# override; the migrate and load services in docker-compose.yml pass their own command.
#
# The interface is read only and starts against an unmigrated database without failing,
# so a container that comes up before its migration job has finished reports the
# problem on screen rather than crash-looping.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "web"]
