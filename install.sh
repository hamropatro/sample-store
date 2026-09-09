#!/bin/sh
# Installs a versioned copy into a new local directory. No sudo or global changes.
set -eu

main() {
  target=sample-store
  if [ "${1:-}" = "--dir" ]; then
    [ "$#" -eq 2 ] || { printf '%s\n' 'Usage: sh install.sh [--dir PATH]' >&2; return 1; }
    target=$2
  elif [ "$#" -ne 0 ]; then
    printf '%s\n' 'Usage: sh install.sh [--dir PATH]' >&2; return 1
  fi
  for tool in node npm curl tar mktemp; do
    command -v "$tool" >/dev/null 2>&1 || {
      printf 'Missing %s. Install Node.js 22.13+ (https://nodejs.org/en/download) and curl/tar, then retry.\n' "$tool" >&2
      return 1
    }
  done
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13))process.exit(1)' || {
    printf '%s\n' 'Node.js 22.13 or newer is required: https://nodejs.org/en/download' >&2; return 1
  }
  case "$target" in ''|/) printf '%s\n' 'Choose a new directory.' >&2; return 1;; /*) ;; *) target="$PWD/$target";; esac
  if [ -e "$target" ] || [ -L "$target" ]; then
    printf 'Directory already exists: %s\nChoose another with --dir. Nothing was changed.\n' "$target" >&2; return 1
  fi
  parent=$(dirname "$target")
  [ -d "$parent" ] || { printf 'Parent directory does not exist: %s\n' "$parent" >&2; return 1; }
  scratch=$(mktemp -d "$parent/.hamropay-install.XXXXXX")
  trap 'rm -rf "$scratch"' EXIT
  trap 'exit 1' HUP INT TERM
  printf '%s\n' 'Downloading Hamro Pay sample store v1.0.0…'
  curl --proto '=https' --tlsv1.2 -fsSL --retry 2 'https://github.com/hamropatro/sample-store/archive/refs/tags/v1.0.0.tar.gz' -o "$scratch/source.tar.gz"
  mkdir "$scratch/store"
  tar -xzf "$scratch/source.tar.gz" -C "$scratch/store" --strip-components=1
  [ -f "$scratch/store/src/server.mjs" ] && [ -f "$scratch/store/.env.example" ] || {
    printf '%s\n' 'The download is incomplete. Nothing was installed.' >&2; return 1
  }
  (cd "$scratch/store" && node scripts/setup.mjs)
  # mkdir claims the destination exclusively; never overwrite a concurrent install.
  mkdir "$target" || return 1
  cp -R "$scratch/store/." "$target/"
  printf '\nInstalled in %s\n\nRun:\n' "$target"
  node -e 'const p=process.argv[1]; console.log("  cd " + "\x27" + p.replaceAll("\x27", "\x27\\\x27\x27") + "\x27")' "$target"
  printf '%s\n' '  npm start' '' 'Open http://localhost:3000. Demo mode needs no credentials and moves no money.'
}

# Keep the entry point last so a truncated piped download cannot start installation.
main "$@"
