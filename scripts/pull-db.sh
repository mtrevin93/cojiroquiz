#!/bin/sh
# Local development with live data: downloads a copy of the production database to
# data/prod-copy.db (gitignored). Read-only on the server; local changes never go back.
# Then run `pnpm dev:live`: the dev site reads the copy and loads pictures from the live bucket.
set -e
cd "$(dirname "$0")/.."
mkdir -p data
rm -f data/prod-copy.db data/prod-copy.db-wal data/prod-copy.db-shm
fly ssh sftp get /data/cojiro.db data/prod-copy.db -a cojiroquiz
# Recent writes live in the write-ahead log; without it the copy is stale.
fly ssh sftp get /data/cojiro.db-wal data/prod-copy.db-wal -a cojiroquiz || true
echo "Copied. Start the site with: pnpm dev:live"
