#!/usr/bin/env bash
set -Eeuo pipefail
root=${1:?deployment directory required}
release=${2:?release id required}
[[ "$root" =~ ^/[a-zA-Z0-9_./-]+$ && "$root" != / ]] || exit 2
[[ "$release" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || exit 2
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running'; exit 1; }
test -s "$root/shared/.env"
test -d "$root/shared/data"
target="$root/releases/$release"
mkdir -p "$target"
tar -xzf "$root/incoming/$release.tar.gz" -C "$target"
export RELEASE_ID="$release"
cd "$target"
docker compose -p maple-bot build --pull
previous=$(readlink -f "$root/current" 2>/dev/null || true)
if [[ -n "$previous" && -d "$previous" ]]; then
  (cd "$previous"; RELEASE_ID=$(basename "$previous") docker compose -p maple-bot exec -T bot node scripts/backup.js </dev/null)
fi
if docker compose -p maple-bot up -d --wait --wait-timeout 120 &&
  docker compose -p maple-bot exec -T bot node scripts/register.js </dev/null; then
  ln -sfn "$target" "$root/current"
  echo "Deployment healthy: $release"
else
  echo 'Deployment failed; restoring previous code (database is not rewound).'
  if [[ -n "$previous" && -d "$previous" ]]; then
    (cd "$previous"
      export RELEASE_ID=$(basename "$previous")
      docker compose -p maple-bot up -d --wait --wait-timeout 120
      docker compose -p maple-bot exec -T bot node scripts/register.js </dev/null
    )
  else
    docker compose -p maple-bot down
  fi
  exit 1
fi
