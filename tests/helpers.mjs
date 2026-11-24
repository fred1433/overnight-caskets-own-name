import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { openDb } from '../site/db.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const catalog = JSON.parse(readFileSync(join(ROOT, 'site/data/catalog.json'), 'utf8'));
export const sqlFiles = {
  shim: readFileSync(join(ROOT, 'supabase/local_auth_shim.sql'), 'utf8'),
  migration: readFileSync(join(ROOT, 'supabase/migrations/20261124120000_selection_room.sql'), 'utf8'),
  seed: readFileSync(join(ROOT, 'site/db/seed.sql'), 'utf8'),
};
export const freshDb = () => openDb(PGlite, sqlFiles);
