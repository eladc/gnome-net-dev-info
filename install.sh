#!/usr/bin/env bash
# Install (or reinstall) the Net Device Info extension for the current user.
set -euo pipefail

UUID="gnome-net-dev-info@eladc.github.io"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"

echo "Installed to $DEST"

if command -v gnome-extensions >/dev/null; then
    gnome-extensions enable "$UUID" || \
        echo "Could not enable yet - restart GNOME Shell, then: gnome-extensions enable $UUID"
fi

if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    echo "Wayland session: run ./dev-reload.sh to load it into the running shell,"
    echo "or log out and back in."
else
    echo "X11 session: press Alt+F2, type 'r', press Enter to reload GNOME Shell."
fi
