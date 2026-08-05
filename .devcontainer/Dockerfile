FROM mcr.microsoft.com/devcontainers/base:noble

ARG NODE_VERSION=24.0.0
ARG TARGETARCH

USER root

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates curl xz-utils \
    && case "${TARGETARCH}" in \
        amd64) NODE_ARCH="x64" ;; \
        arm64) NODE_ARCH="arm64" ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && mkdir --parents /opt/node \
    && curl --fail --silent --show-error --location \
        "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
        | tar --extract --xz --strip-components=1 --directory /opt/node \
    && apt-get clean \
    && rm --recursive --force /var/lib/apt/lists/*

ENV PATH="/opt/node/bin:${PATH}"

RUN corepack enable

USER vscode