import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { openDb } from '../site/db.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// npm test runs on tests/fixtures (14 products of the public feed, built by `scripts/build.py --fixture`).
// npm run test:full runs on the full catalog read in data/raw, which stays out of the repository.
export const FULL = process.env.CATALOG === 'full';
export const RAW = FULL ? join(ROOT, 'data/raw') : join(ROOT, 'tests/fixtures/raw');
const BUILT = FULL ? join(ROOT, 'site') : join(ROOT, 'tests/fixtures/build');
export const catalog = JSON.parse(readFileSync(join(BUILT, 'data/catalog.json'), 'utf8'));
export const MIGRATION_PATH = 'supabase/migrations/20261124120000_funeral_homes.sql';
export const sqlFiles = {
  shim: readFileSync(join(ROOT, 'supabase/local_auth_shim.sql'), 'utf8'),
  migration: readFileSync(join(ROOT, MIGRATION_PATH), 'utf8'),
  seed: readFileSync(join(BUILT, 'db/seed.sql'), 'utf8'),
};
export const freshDb = () => openDb(PGlite, sqlFiles);
