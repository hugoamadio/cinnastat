#!/bin/sh
# Install (or update) cinnastat for the current user.
#
#   ./install.sh            copy the applet into ~/.local/share/cinnamon/applets
#   ./install.sh --link     symlink it instead, so edits here show up after a reload
#   ./install.sh --remove   uninstall
#
# Then right-click the panel > Applets and add cinnastat.
set -eu

UUID=cinnastat@hugoamadio
SRC=$(cd "$(dirname "$0")" && pwd)/files/$UUID
DEST=${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/applets/$UUID

reload() {
  # restart the applet if it is already on a panel; harmless otherwise
  dbus-send --session --dest=org.Cinnamon.LookingGlass --type=method_call \
    /org/Cinnamon/LookingGlass org.Cinnamon.LookingGlass.ReloadExtension \
    string:"$UUID" string:APPLET >/dev/null 2>&1 || true
}

case "${1:-}" in
  --remove)
    rm -rf "$DEST"
    echo "cinnastat removed. Take it off the panel if it is still there."
    exit 0
    ;;
  --link)
    mkdir -p "$(dirname "$DEST")"
    rm -rf "$DEST"
    ln -s "$SRC" "$DEST"
    ;;
  "")
    mkdir -p "$(dirname "$DEST")"
    rm -rf "$DEST"
    cp -r "$SRC" "$DEST"
    ;;
  *)
    echo "usage: $0 [--link|--remove]" >&2
    exit 2
    ;;
esac

reload
echo "cinnastat installed in $DEST"
echo "Right-click the panel > Applets, then add cinnastat."
