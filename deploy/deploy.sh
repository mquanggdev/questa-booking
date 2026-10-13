#!/bin/sh
# Deploys one image tag of the online demo on the VPS (phase 9). Run by the
# Deploy workflow over SSH, from the deploy directory on the server:
#
#   sh deploy/deploy.sh <image tag = git sha>
#
# The directory holds docker-compose.prod.yml, docker/ (Nginx, Prometheus,
# Grafana config), this script, and .env with the secrets (created once by
# hand, never in git).
#
# Pulls the images, starts the stack (migrations run first, in the
# "migrate" service), waits until the API answers through this stack's
# Nginx, and goes back to the previous tag if it does not.
set -eu

cd "$(dirname "$0")/.."
TAG="${1:?usage: deploy.sh <image tag>}"
COMPOSE="docker compose -f docker-compose.prod.yml"

# The network shared with the VPS's Nginx: created if missing, so a fresh
# server cannot fail on it (ADR-0014).
EDGE_NETWORK="$(grep '^EDGE_NETWORK=' .env | cut -d= -f2-)"
docker network inspect "$EDGE_NETWORK" > /dev/null 2>&1 \
  || docker network create "$EDGE_NETWORK" > /dev/null

PREVIOUS="$(cat .deployed-tag 2> /dev/null || true)"
# Every compose command needs it (the file refuses to load without it),
# including the health check's `exec`.
export IMAGE_TAG="$TAG"

healthy() {
  # Through this stack's Nginx, as the VPS's Nginx will reach it.
  $COMPOSE exec -T nginx wget -qO- http://127.0.0.1/api/v1/health/ready 2> /dev/null \
    | grep -q '"status":"ok"'
}

wait_healthy() {
  i=0
  while [ "$i" -lt 60 ]; do
    if healthy; then return 0; fi
    i=$((i + 1))
    sleep 3
  done
  return 1
}

echo "Deploying $TAG (previous: ${PREVIOUS:-none})"
# SKIP_PULL=1: rehearse locally with images tagged by hand (no registry).
if [ "${SKIP_PULL:-0}" != 1 ]; then
  $COMPOSE pull --quiet
fi
# `up` itself fails when a container cannot start (a broken image): that
# must lead to the rollback below too, not end the script (set -e).
if $COMPOSE up -d --remove-orphans && wait_healthy; then
  echo "$TAG" > .deployed-tag
  docker image prune -f > /dev/null
  echo "Deployed $TAG"
  exit 0
fi

echo "The new version did not become healthy." >&2
$COMPOSE ps >&2
$COMPOSE logs --tail 80 api worker migrate >&2 || true
if [ -n "$PREVIOUS" ]; then
  # Migrations are never rolled back: they must stay compatible with the
  # previous version of the code (expand first, contract in a later
  # release; ADR-0018).
  echo "Rolling back to $PREVIOUS" >&2
  export IMAGE_TAG="$PREVIOUS"
  $COMPOSE up -d --remove-orphans
  wait_healthy && echo "Back on $PREVIOUS" >&2
fi
exit 1
