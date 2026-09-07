#!/usr/bin/env bash
# Load the extension into the RUNNING GNOME Shell - no logout needed for the
# FIRST load in a session. There is no reliable way to hot-reload code changes
# after that; see the "Loading without logging out" section in README.md for why.
#
# GNOME Shell does not watch the extensions directory, so a freshly copied
# extension is invisible to the running shell until something tells it to load
# it. Looking Glass evaluates JavaScript inside the shell process - and unlike
# the org.gnome.Shell.Eval D-Bus method it is not gated behind unsafe-mode - so
# we hand it the missing load call.
#
# Usage: ./dev-reload.sh   ->  then press Alt+F2, type 'lg', Enter, and paste
#                              into the "Evaluator" tab prompt.
set -euo pipefail

UUID="gnome-net-dev-info@eladc.github.io"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

SNIPPET=$(cat <<JS
(async () => {
    const uuid = '$UUID';
    const mgr = Main.extensionManager;
    let ext = mgr.lookup(uuid);
    if (ext)
        await mgr.unloadExtension(ext);
    const dir = Gio.File.new_for_path('$DEST');
    ext = mgr.createExtensionObject(uuid, dir, 2);
    await mgr.loadExtension(ext);
    print('gnome-net-dev-info loaded, state =', ext.state);
})();
JS
)

echo "Paste this into Looking Glass (Alt+F2 -> lg -> Evaluator tab):"
echo
echo "$SNIPPET"
echo
echo "NOTE: this re-runs the extension.js that is CACHED in the shell process."
echo "If you already loaded gnome-net-dev-info once this session and have since edited"
echo "extension.js, this snippet will NOT pick up the edit (GJS caches ES"
echo "modules per-process, and GObject.registerClass'd classes can't be"
echo "re-registered under a new module either - see README.md). Log out and"
echo "back in (or Alt+F2 r on X11) to actually see code changes."

if command -v wl-copy >/dev/null; then
    printf '%s' "$SNIPPET" | wl-copy && echo "(copied to clipboard)"
elif command -v xclip >/dev/null; then
    printf '%s' "$SNIPPET" | xclip -selection clipboard && echo "(copied to clipboard)"
fi
