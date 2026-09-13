#!/bin/sh
set -eu
uid="$1"
gid="$2"
getent group "$gid" >/dev/null || groupadd -g "$gid" llmchat
if ! getent passwd "$uid" >/dev/null; then
  useradd -m -u "$uid" -g "$gid" -s /bin/bash llmchat
fi
name="$(getent passwd "$uid" | cut -d: -f1)"
mkdir -p /run/llm-chat /home/llm-chat
chown "$uid:$gid" /run/llm-chat /home/llm-chat
chmod 700 /run/llm-chat /home/llm-chat
printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$name" > /etc/sudoers.d/llm-chat
chmod 440 /etc/sudoers.d/llm-chat
touch /run/llm-chat/ready
exec node /opt/llm-chat-runtime/runner.mjs init
