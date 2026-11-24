# Selection room for Overnight Caskets

A first milestone, working: two sample funeral homes run the same app under their own name, colour and
prices, on the public catalog of overnightcaskets.com. A director walks a family through a selection on an
iPad (rooms, comparison, an optional head panel, a saved arrangement); the family sees only the funeral
home. The director's view shows the cost basis, the pricing rule, the margin, the order type, and builds
the supplier cart link from the saved arrangement.

Page: https://theaipipe.com/demos/overnight-selection-room/

The two homes, their staff, families and arrangements are invented. Wholesale costs are not known: the
page uses an illustrative share of the public price (55% and 60%), labelled as such, and never the
struck-through `compare_at_price`.

## What is in here

| Path | What it is |
|---|---|
| `data/raw/` | The catalog snapshot, read once on 24 Nov 2026 between 12:29 and 12:30 UTC: `/products.json` (2 pages, 369 products, 515 variants), `/collections.json` (171 collections) and the product lists of six collections. Nothing else was requested from the store. |
| `config/homes.json` | The two sample homes: brand, staff and their access switches, pricing rules, hand-picked rooms, one earlier arrangement each. |
| `scripts/build.py` | Snapshot to `site/data/catalog.json` and `site/db/seed.sql`; copies PGlite into `site/vendor/`. |
| `supabase/migrations/20261124120000_selection_room.sql` | Schema and row level security: `organizations`, `memberships` (per-person switches), `catalog_items` (with `item_type` and `attributes jsonb`), `catalog_variants`, `pricing_rules`, `selection_rooms`, `selection_room_items`, `session_steps`, `arrangements`, `arrangement_lines`, `arrangement_line_costs`. Prices are computed by the database from the home's rules when a line is saved; the client cannot set them. |
| `supabase/local_auth_shim.sql` | What Supabase already provides (`auth.uid()`, `auth.jwt()`, the `authenticated` and `service_role` roles), for a plain Postgres only. Not for a Supabase project. |
| `site/` | The page. `pricing.js` (prices in cents and the cart link), `db.js` (the in-page database), `checks.js` (the cross-tenant check, shared with the tests), `app.js`. |
| `tests/` | Node tests (PGlite and, through `pg_local.sh`, a local PostgreSQL), mutants, and the page in Chromium and WebKit. |

## How the pieces behave

- **Isolation.** Every row a home owns carries `org_id`; policies allow a signed-in person only the rows of
  homes they belong to (`app.is_member`). The arrangement list query has no home filter: the database
  returns each home its own rows.
- **Per-person access.** `can_see_cost`, `can_edit_pricing`, `can_order` on the membership. An arranger can
  save arrangements but cannot read saved costs or change rules; the database refuses both.
- **Prices.** cost = public price x basis %; retail = rule (percent or amount), then rounding (to the cent,
  up to the whole dollar, or up to .95), then floor. First matching rule wins, by Overnight Caskets'
  own collections. `site/pricing.js` and `app.apply_rule` / `app.price_for` give the same cents.
- **Buy Now / Pre-Need.** 61 caskets list both, with two variant ids at the same price. The arrangement
  carries the order type; the cart link uses the matching variant (Cambridge Solid Mahogany:
  `50196452868289` Buy Now, `50196452901057` Pre-Need).
- **Supplier link.** `https://overnightcaskets.com/cart/<variant>:<qty>,...`, built only from variant ids of
  the snapshot that are available; anything else is listed as left out. It is shown in full before it can
  be opened, and only the director's click opens it. On 24 Nov 2026 that link led to the public Shop Pay
  checkout at public prices; wholesale pricing through a partner account is not checked here.
- **Removed products.** Arrangement lines keep their title and price and have no foreign key to the
  catalog, so a product the sync deletes leaves the arrangement readable, marked as no longer in the
  catalog.
- **Catalog sync.** The demo uses a dated snapshot of the public feed. On that read every product carried
  the same `updated_at` minute, so the public feed cannot drive an incremental sync; production would use
  the Shopify Admin API with product update and delete notifications.
- **Sign-in.** Staff would sign in with a 6-digit email code (Supabase Auth OTP) scoped to their home; the
  demo opens the two sample homes directly and sends no email.

## Run it

```bash
npm install                                   # PGlite 0.5.15 and pg, for the tests
python3 scripts/build.py                      # data/raw -> site/data/catalog.json, site/db/seed.sql, site/vendor/
npm test                                      # node --test tests/: 16 tests on PGlite (Postgres 17 in WebAssembly)
node tests/mutants.mjs                        # 8 deliberate breaks of the migration, each must be caught
sh tests/pg_local.sh                          # the RLS tests again on a throwaway local PostgreSQL (127.0.0.1)
python3 scripts/serve.py 8813 site            # local preview on 127.0.0.1:8813
python3 tests/test_page.py http://127.0.0.1:8813/   # the page in Chromium and WebKit (Playwright for Python)
```

On a Supabase project: apply `supabase/migrations/`, then load `site/db/seed.sql` with the service role.
The migration has been run on PGlite (Postgres 17) and on PostgreSQL 14, not on a hosted Supabase project.

## Results on 24 Nov 2026

- `npm test`: 16 passed (snapshot counts, rooms, prices against the raw feed, Buy Now / Pre-Need, cart link,
  page and database prices equal to the cent on every casket and head panel variant for both homes,
  rule scope, rounding and floor, every cross-tenant check in both directions, arranger limits, removed
  product).
- `sh tests/pg_local.sh`: 10 passed (the 5 RLS tests on PGlite and on PostgreSQL 14.23).
- `node tests/mutants.mjs`: 8 of 8 mutants caught.
- `tests/test_page.py`: the full flow in Chromium and WebKit with every request to overnightcaskets.com
  blocked and counted (none made), and no horizontal scroll and 44 px touch targets at 1024x768, 768x1024,
  1180x820, 820x1180, 390x844 and 1440x900.

Built by Frederic de Lavenne de Choulot, The AI Pipe.
