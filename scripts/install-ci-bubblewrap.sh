#!/usr/bin/env bash
set -euo pipefail

# Pin 0.12.0: its mount setup fixes are required for untrusted workspace paths.
sandbox_source="${RUNNER_TEMP:?}/llm-chat-bubblewrap"
sandbox_revision=2a76602a8c71f36c1527cf9fc3417d9149822e0c
sudo apt-get update
sudo apt-get install -y meson ninja-build pkg-config libcap-dev python3
git init --quiet "$sandbox_source"
git -C "$sandbox_source" fetch --quiet --depth=1 https://github.com/containers/bubblewrap.git "$sandbox_revision"
git -C "$sandbox_source" checkout --quiet --detach FETCH_HEAD
meson setup "$sandbox_source/build" "$sandbox_source" --prefix=/usr/local \
  -Dman=disabled -Dselinux=disabled -Dtests=false -Dbash_completion=disabled -Dzsh_completion=disabled
meson compile -C "$sandbox_source/build"
sudo meson install -C "$sandbox_source/build"

# Ubuntu runners may restrict user namespaces with AppArmor. Grant this binary
# access without disabling the host's namespace restrictions globally.
if command -v apparmor_parser >/dev/null && [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || true)" = Y ]; then
  sudo tee /etc/apparmor.d/llm-chat-ci-bubblewrap >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
/usr/local/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
  sudo apparmor_parser -r /etc/apparmor.d/llm-chat-ci-bubblewrap
fi
/usr/local/bin/bwrap --version
