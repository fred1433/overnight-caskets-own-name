#!/bin/sh
# Runs tests/rls.test.mjs against a throwaway local PostgreSQL on 127.0.0.1 (initdb in a temp
# directory, stopped and removed at the end). Needs initdb and pg_ctl on PATH.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
port=${PG_TEST_PORT:-54329}
trap 'pg_ctl -D "$tmp/data" -m fast stop >/dev/null 2>&1 || true; rm -rf -- "$tmp"' EXIT
initdb -D "$tmp/data" -U postgres -A trust >/dev/null
pg_ctl -D "$tmp/data" -o "-k $tmp -c listen_addresses=127.0.0.1 -p $port" -l "$tmp/log" -w start >/dev/null
createdb -h 127.0.0.1 -p "$port" -U postgres own_name
postgres --version
cd "$here"
PG_TEST_URL="postgres://postgres@127.0.0.1:$port/own_name" node --test tests/rls.test.mjs
