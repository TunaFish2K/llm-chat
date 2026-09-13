#!/bin/sh
set -eu
engine="${1:-docker}"
case "$engine" in docker|podman) ;; *) echo 'Use docker or podman' >&2; exit 1;; esac
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$engine" build --network host --build-arg "APT_FORCE_IPV4=${LLM_CHAT_APT_FORCE_IPV4:-false}" -t llm-chat-runtime:local "$root"
