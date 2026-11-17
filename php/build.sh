#!/usr/bin/env bash
# Baut aus public/ + php/api.php die Ablage für PHP-Hosting (HestiaCP) in php/dist/.
# Aufruf aus dem Repo-Root oder von überall: php/build.sh [ZIELORDNER]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
out="${1:-$here/dist}"
sortable="$root/node_modules/sortablejs/Sortable.min.js"

if [ ! -f "$sortable" ]; then
  echo "SortableJS fehlt: erst 'npm install' im Repo-Root ausführen." >&2
  exit 1
fi

web="$out/public_html"
priv="$out/private/feature-voting"
rm -rf "$web"
mkdir -p "$web/vendor" "$priv"

cp "$root"/public/*.html "$root"/public/*.css "$root"/public/*.js "$web/"
cp "$sortable" "$web/vendor/"
cp "$here/api.php" "$web/"

# why: schaltet das gemeinsame Frontend auf PHP-Endpunkte und Polling (siehe public/backend.js)
for f in index.html live.html; do
  perl -0pi -e 's|<meta charset="utf-8">|<meta charset="utf-8">\n  <meta name="fv-backend" content="php">|' "$web/$f"
  grep -q 'name="fv-backend" content="php"' "$web/$f" || { echo "Meta-Tag in $f nicht gesetzt" >&2; exit 1; }
done

cp "$root/config.json" "$priv/config.json"
if [ ! -s "$priv/admin-token" ]; then
  if command -v openssl >/dev/null; then
    openssl rand -hex 16 > "$priv/admin-token"
  else
    head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$priv/admin-token"
  fi
  echo "Neuer Admin-Token: $(cat "$priv/admin-token")"
fi
chmod 600 "$priv/admin-token"

echo "Fertig: $out"
echo "  public_html/              -> /home/USER/web/DOMAIN/public_html/"
echo "  private/feature-voting/   -> /home/USER/web/DOMAIN/private/feature-voting/"
