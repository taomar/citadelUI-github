# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b

FROM ${NODE_IMAGE} AS application
WORKDIR /app
COPY --chown=10001:10001 README.md ./
COPY --chown=10001:10001 server ./server
COPY --chown=10001:10001 shared ./shared
COPY --chown=10001:10001 web ./web

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Citadel UI" \
      org.opencontainers.image.description="Fully local browser-mediated Citadel configuration editor" \
      org.opencontainers.image.version="1.0.0-local"
ENV NODE_ENV=production \
    CITADEL_UI_HOST=0.0.0.0 \
    CITADEL_UI_PORT=4173 \
    CITADEL_DATA_ROOT=/data
WORKDIR /app
COPY --from=application --chown=10001:10001 /app /app
USER root
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx
USER 10001:10001
EXPOSE 4173
# The server refuses a request whose Host is not the allowed host, and the
# allowed host is the one the *browser* uses — which is the published port, not
# the container port. `fetch` cannot set Host (undici forbids it), so the probe
# would send `127.0.0.1:4173`, be refused with 421, and report a perfectly
# healthy container as unhealthy for any deployment not published on 4173.
# `node:http` can set it, so the probe speaks the same host the product does.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "const http=require('node:http');const port=process.env.CITADEL_UI_PORT||4173;const host=process.env.CITADEL_ALLOWED_HOST||('127.0.0.1:'+port);const req=http.request({host:'127.0.0.1',port,path:'/healthz',headers:{Host:host}},(res)=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.end()"]
CMD ["sh", "-c", "umask 077 && exec node server/index.mjs"]
