#!/bin/sh
# Herdr spawns plugin commands as raw argv with the server's environment.
# Under launchd/systemd that PATH is bare (/usr/bin:/bin:...), so locate
# node ourselves instead of relying on PATH lookup.
if ! command -v node >/dev/null 2>&1; then
  for dir in \
    "$HOME/.local/share/mise/shims" \
    /opt/homebrew/bin \
    /usr/local/bin \
    "$HOME"/.nvm/versions/node/*/bin
  do
    if [ -x "$dir/node" ]; then
      PATH="$dir:$PATH"
      export PATH
      break
    fi
  done
fi

script=$1
shift
exec node "$(dirname "$0")/$script" "$@"
