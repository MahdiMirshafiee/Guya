#!/usr/bin/env bash
#
# Cut a release: bump the version, commit it, tag it, push the tag.
#
# The tag is what starts the Release workflow on GitHub, which builds the macOS
# and Windows artifacts and attaches them to a GitHub release.
#
#   scripts/release.sh 1.2.0
#
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: scripts/release.sh <version>    e.g. scripts/release.sh 1.1.0" >&2
  exit 1
fi

if ! command -v git >/dev/null || ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "this is not a git repository" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "the working tree is not clean — commit or stash first" >&2
  exit 1
fi

if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "tag v$VERSION already exists" >&2
  exit 1
fi

echo "==> tests"
npm test

echo "==> icons"
npm run icons

echo "==> version $VERSION"
npm version "$VERSION" --no-git-tag-version

git add package.json package-lock.json assets/icon.png build/icon.png
git commit -m "chore(release): v$VERSION"
git tag "v$VERSION"

echo "==> pushing"
git push origin HEAD
git push origin "v$VERSION"

echo
echo "v$VERSION is on its way. The Release workflow builds both platforms and"
echo "publishes them here:"
echo "  $(git remote get-url origin 2>/dev/null | sed 's#\.git$##' || echo '<remote>')/actions"
