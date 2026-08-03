# syntax=docker/dockerfile:1

# DocDrop container image.
#
# Multi-stage: dependencies and build are thrown away, the final image only carries
# the standalone output (~35 MB of app on top of the Node base).
#
# Alpine works here and saves ~60 MB over Debian slim. The usual objection is
# sharp/libvips needing glibc, but npm installs the musl build automatically and this
# app never calls next/image anyway. Both variants were tested against the full
# upload protocol suite before settling on this one.

# ── Dependencies ─────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci reproduces the lockfile exactly, which is what makes the build repeatable.
RUN npm ci

# ── Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Also runs the postbuild step, which copies the static assets and start.js into the
# standalone output and strips any traced upload data.
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3010 \
    HOSTNAME=0.0.0.0 \
    DOCDROP_DATA_DIR=/data

# Unprivileged user. The image never runs as root: a container escape through the
# application should not land on a root shell.
RUN addgroup --system --gid 1001 docdrop \
 && adduser --system --uid 1001 --ingroup docdrop docdrop \
 && mkdir -p /data && chown docdrop:docdrop /data

COPY --from=builder --chown=root:root /app/.next/standalone ./

# Uploaded files live outside the image layer, or they would be lost on every
# container replacement.
VOLUME ["/data"]

EXPOSE 3010
USER docdrop

# start.js raises the HTTP server's requestTimeout before handing control to Next.
# Node's default (5 min) cuts multi-GB uploads off mid-transfer, so starting
# server.js directly would silently reintroduce that bug.
CMD ["node", "start.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/api/info/000000000000').then(r=>process.exit(r.status===404?0:1)).catch(()=>process.exit(1))"

LABEL org.opencontainers.image.title="DocDrop" \
      org.opencontainers.image.description="Self-hosted file sharing with expiring links: resumable chunked uploads for multi-GB files, previews and streamed ZIP downloads" \
      org.opencontainers.image.source="https://github.com/Ulzuhan/docdrop" \
      org.opencontainers.image.licenses="MIT"
