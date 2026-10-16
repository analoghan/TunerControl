# TunerControl server — web app + SQLite-backed tune history API.
# Build:  docker build -t tunercontrol .
# Run:    docker run -d --name tunercontrol -p 8080:8080 -v tunercontrol-data:/data \
#           -e TUNERCONTROL_TOKEN=change-me tunercontrol
FROM node:24-bookworm-slim

WORKDIR /app
COPY . .

ENV HOST=0.0.0.0 \
    PORT=8080 \
    TUNERCONTROL_DB=/data/tunercontrol.db

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
