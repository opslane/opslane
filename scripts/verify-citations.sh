#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <repo> <commit> <path> [path ...]" >&2
  exit 2
fi

repo=$1
commit=$2
shift 2

git -C "$repo" fetch --quiet --all
for path in "$@"; do
  git -C "$repo" cat-file -e "${commit}:${path}"
  echo "verified ${commit}:${path}"
done
