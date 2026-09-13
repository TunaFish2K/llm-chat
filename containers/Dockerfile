FROM node:24-bookworm-slim
ARG APT_FORCE_IPV4=false
RUN apt-get -o Acquire::ForceIPv4=$APT_FORCE_IPV4 update && apt-get -o Acquire::ForceIPv4=$APT_FORCE_IPV4 install -y --no-install-recommends bash ca-certificates curl git python3 python3-venv python3-pip ripgrep sudo util-linux passwd \
    && rm -rf /var/lib/apt/lists/*
LABEL fish.2kb.llm-chat.runtime="1"
