#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: smoke-container.sh IMAGE}
container="zap-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${RANDOM}"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "$container" \
  --tmpfs /data:uid=1000,gid=1000 \
  --tmpfs /workspace:uid=1000,gid=1000 \
  --env I_KNOW_THIS_IS_NETWORK_ACCESSIBLE=1 \
  --env ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  --env PI_STUB=1 \
  --env LOG_LEVEL=warn \
  "$image" >/dev/null

for _ in $(seq 1 120); do
  if ! docker inspect --format '{{.State.Running}}' "$container" | grep -qx true; then
    docker logs "$container"
    echo "container exited before becoming ready" >&2
    exit 1
  fi
  if docker exec "$container" curl -fsS http://127.0.0.1:3000/api/health/liveness >/dev/null && \
    docker exec "$container" curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
    echo "[container-smoke] verified $image"
    exit 0
  fi
  sleep 0.5
done

docker logs "$container"
echo "timed out waiting for container health" >&2
exit 1