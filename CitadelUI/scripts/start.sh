#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
compose=(compose --project-directory "$root" --file "$root/compose.yaml")
if [[ -f "$root/container.env" ]]; then
  compose+=(--env-file "$root/container.env")
fi

if docker "${compose[@]}" up --detach --build --wait --wait-timeout 120; then
  printf '%s\n' 'Citadel UI is available at http://127.0.0.1:4173'
else
  status=$?
  printf '%s\n' 'Citadel UI did not become healthy. See the Docker Compose error above.' >&2
  exit "$status"
fi
