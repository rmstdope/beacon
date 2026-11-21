#!/usr/bin/env bash
# Starts the built image the way production runs it (read-only, user 10001, settings from an env
# file) with throwaway credentials, and checks health and the release marker.
# Usage: deploy/smoke-test.sh <image> <full commit SHA>
set -euo pipefail
image=$1 revision=$2
work=$(mktemp -d)
name="beacon-smoke-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

openssl genrsa -traditional -out "$work/key.pem" 2048 2>/dev/null
{
  echo "GITHUB_APP_ID=1"
  echo "GITHUB_APP_PRIVATE_KEY_BASE64=$(openssl base64 -A < "$work/key.pem")"
  echo 'BEACON_CLIENTS={"smoke":{"repo":"rmstdope/beacon","origins":["http://localhost:5173"]}}'
} > "$work/web.env"

docker run -d --name "$name" --user 10001:10001 --read-only --init \
  --env-file "$work/web.env" -e PORT=8080 -p 127.0.0.1:18080:8080 "$image" >/dev/null

for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$name")
  [ "$status" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || { docker logs "$name"; exit 1; }
  sleep 1
done
[ "$status" = healthy ] || { echo "container never became healthy ($status)"; docker logs "$name"; exit 1; }

curl -fsS http://127.0.0.1:18080/healthz | grep -q '"status":"ok"'
served=$(curl -fsS http://127.0.0.1:18080/release.json)
[ "$served" = "{\"revision\":\"$revision\"}" ] || { echo "release.json served $served"; exit 1; }
label=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[ "$label" = "$revision" ] || { echo "revision label is $label"; exit 1; }
echo "smoke test passed for $image"
