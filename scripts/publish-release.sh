#!/usr/bin/env bash
#
# Publishes the release for a tag: creates it the first time, and re-cuts it after.
#
#   scripts/publish-release.sh v1.0.0 notes.md dist/*.dmg dist/*.exe ...
#
# A version that shipped with something wrong with it is published again under the same
# tag, and the page has to end up as if the first publish never happened: the release is
# deleted and created again, so the notes come from the commits as they are now and the
# files are exactly this build's — the old ones cannot stay beside them, and a page that
# offers two downloads for one job is a page where someone downloads the wrong one. `gh` is
# the only thing here that talks to GitHub.
#
# It is a script rather than a block of YAML because it is the part of a release that is
# worth running by hand: with `gh` on the PATH, this is the whole release path, and it can
# be exercised with a stub in front of it (see the end-to-end note in AGENTS.md).

set -euo pipefail

TAG="${1:-}"
NOTES="${2:-}"
shift 2 2>/dev/null || true

if [ -z "$TAG" ] || [ -z "$NOTES" ]; then
  echo "usage: publish-release.sh <tag> <notes-file> <file>..." >&2
  exit 2
fi
if [ ! -f "$NOTES" ]; then
  echo "no notes at $NOTES" >&2
  exit 2
fi

FILES=("$@")
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no files to attach" >&2
  exit 2
fi
for file in "${FILES[@]}"; do
  if [ ! -f "$file" ]; then
    echo "missing file: $file" >&2
    exit 2
  fi
done

REPO="${GITHUB_REPOSITORY:-}"
if [ -z "$REPO" ]; then
  echo "GITHUB_REPOSITORY is not set (owner/name)" >&2
  exit 2
fi
REPO_ARG=(--repo "$REPO")

if gh release view "$TAG" "${REPO_ARG[@]}" >/dev/null 2>&1; then
  # The release is replaced, and the tag is left alone: the tag is what the workflow ran
  # from, and deleting it would leave a published release with nothing pointing at it.
  echo "replacing the release for $TAG"
  gh release delete "$TAG" "${REPO_ARG[@]}" --yes
fi

echo "publishing $TAG"
gh release create "$TAG" "${FILES[@]}" "${REPO_ARG[@]}" --title "Guya $TAG" --notes-file "$NOTES"
