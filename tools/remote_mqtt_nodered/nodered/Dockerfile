ARG NODERED_BASE_IMAGE=nodered/node-red:latest
FROM ${NODERED_BASE_IMAGE}

USER root
ARG NPM_REGISTRY=
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
  && npm install --no-audit --no-fund pg
USER node-red
