#!/usr/bin/env bash
# Purity guard: mathmeander-core's NORMAL dependency tree must be free of I/O, async-runtime,
# FFI, and nondeterminism crates (arch doc §5). One of three independent guards
# (with the wasm32 CI check and crates/core/clippy.toml disallowed-methods).
set -euo pipefail

DENYLIST='^(tokio|hyper|reqwest|sqlx|postgres|tokio-postgres|rusqlite|napi|napi-derive|axum|actix|rand|getrandom|mio|libc)$'

tree=$(cargo tree -p mathmeander-core -e normal --prefix none --format '{lib}' | sort -u)

violations=$(echo "$tree" | grep -E "$DENYLIST" || true)

if [[ -n "$violations" ]]; then
  echo "FAIL: mathmeander-core's dependency tree contains forbidden crates:"
  echo "$violations"
  echo
  echo "The integrity core is pure (arch doc §5). I/O belongs in the glue tier or"
  echo "mathmeander-schema-gen; FFI belongs in mathmeander-core-node."
  exit 1
fi

echo "OK: mathmeander-core dependency tree is pure ($(echo "$tree" | wc -l | tr -d ' ') crates checked)"
