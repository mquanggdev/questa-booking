#!/bin/sh
# Installs the .env the Deploy workflow wrote from GitHub Secrets
# (.env.new, next to docker-compose.prod.yml). Run over SSH before
# deploy.sh:
#
#   sh deploy/install-env.sh
#
# PostgreSQL keeps the password it was created with: changing
# POSTGRES_PASSWORD in GitHub would leave the API unable to connect, so a
# different value is refused and the current .env kept (docs/deploy-vps.md).
set -eu

cd "$(dirname "$0")/.."
umask 077
[ -s .env.new ] || { echo ".env.new is missing or empty" >&2; exit 1; }

value() { grep "^$1=" "$2" | head -n 1 | cut -d= -f2-; }

if [ -f .env ]; then
  if [ "$(value POSTGRES_PASSWORD .env)" != "$(value POSTGRES_PASSWORD .env.new)" ]; then
    rm -f .env.new
    echo "POSTGRES_PASSWORD in GitHub differs from the one the database was created with; .env left unchanged." >&2
    exit 1
  fi
  # Keep the previous version, to put back by hand if a new value is wrong.
  cmp -s .env .env.new || cp -p .env .env.prev
fi
mv .env.new .env
chmod 600 .env
echo "Installed .env ($(grep -c '=' .env) variables)"
