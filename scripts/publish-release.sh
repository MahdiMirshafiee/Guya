#!/usr/bin/env bash
#
# Publishes the release for a tag: creates it the first time, and re-cuts it after.
#
#   scripts/publish-release.sh v1.0.0 notes.md dist/*.dmg dist/*.exe ...
#
# A version that shipped with something wrong with it is published again under the same
# tag, and the second publish has to leave the page looking like the first one never
# happened: the notes are rewritten from the commits as they are now, the new files
# replace the old ones, and a file this build did not produce — an artifact named before
# the naming changed, a stale architecture — is removed. A re-cut that leaves the previous
# downloads beside the new ones is not a re-cut; it is a page offering a file nobody can
# vouch for. `gh` is the only thing here that talks to GitHub.
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
  echo "re-cutting $TAG"
  gh release edit "$TAG" "${REPO_ARG[@]}" --title "Guya $TAG" --notes-file "$NOTES"
  gh release upload "$TAG" "${FILES[@]}" "${REPO_ARG[@]}" --clobber

  WANTED=()
  for file in "${FILES[@]}"; do WANTED+=("$(basename "$file")"); done
  PRESENT=()
  while IFS= read -r name; do [ -n "$name" ] && PRESENT+=("$name"); done \
    < <(gh release view "$TAG" "${REPO_ARG[@]}" --json assets --jq '.assets[].name')

  for name in "${PRESENT[@]}"; do
    keep=0
    for wanted in "${WANTED[@]}"; do
      if [ "$name" = "$wanted" ]; then keep=1; fi
    done
    if [ "$keep" -eq 0 ]; then
      echo "removing $name (this build does not produce it)"
      gh release delete-asset "$TAG" "$name" "${REPO_ARG[@]}" --yes
    fi
  done
else
  echo "creating $TAG"
  gh release create "$TAG" "${FILES[@]}" "${REPO_ARG[@]}" --title "Guya $TAG" --notes-file "$NOTES"
fi
