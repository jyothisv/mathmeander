#!/usr/bin/env bash
# Purity guard: the pure crates' NORMAL dependency trees must be free of I/O, async-runtime,
# FFI, and nondeterminism crates (arch doc §5). One of three independent guards
# (with the wasm32 CI check and the clippy.toml disallowed-methods in each crate).
# Covers BOTH pure crates: the integrity core and the owned surface language (core → surface).
set -euo pipefail

# Shared base: no I/O, async-runtime, FFI, or entropy crates in either pure crate.
BASE='tokio|hyper|reqwest|sqlx|postgres|tokio-postgres|rusqlite|napi|napi-derive|axum|actix|rand|getrandom|mio|libc'

for crate in mathmeander-core mathmeander-surface; do
  # The surface language additionally has NO clock/identity deps (the core legitimately
  # uses chrono+uuid for its wire types; the surface owns neither), so name them explicitly
  # — a stronger, per-crate guard than the comment-level "no clock" claim.
  deny="^($BASE)\$"
  if [[ "$crate" == "mathmeander-surface" ]]; then
    deny="^($BASE|chrono|uuid)\$"
  fi
  tree=$(cargo tree -p "$crate" -e normal --prefix none --format '{lib}' | sort -u)
  violations=$(echo "$tree" | grep -E "$deny" || true)
  if [[ -n "$violations" ]]; then
    echo "FAIL: $crate's dependency tree contains forbidden crates:"
    echo "$violations"
    echo
    echo "The integrity core and surface language are pure (arch doc §5). I/O belongs in"
    echo "the glue tier or mathmeander-schema-gen; FFI belongs in mathmeander-core-node."
    exit 1
  fi
  echo "OK: $crate dependency tree is pure ($(echo "$tree" | wc -l | tr -d ' ') crates checked)"
done
