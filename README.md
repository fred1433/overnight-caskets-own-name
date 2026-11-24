# Your caskets, under a funeral home's own name

A first milestone, working: two sample funeral homes run the same app under their own name, colour and
prices, on the public catalog of overnightcaskets.com. A director walks a family through a selection on an
iPad (rooms, comparison, an optional head panel, a saved arrangement), full screen in front of the family
if they wish; the family sees only the funeral home. The director's view shows the cost basis, the pricing
rule, the margin, the order type, and prepares the supplier cart link from the saved arrangement.

Page: https://theaipipe.com/demos/overnight-caskets-own-name/ (the earlier address
`/demos/overnight-selection-room/` answers 301 to it).

The two homes, their staff, families and arrangements are invented. Wholesale costs are not known: the
page uses an illustrative share of the public price (55% and 60%), labelled as such, and never the
struck-through `compare_at_price`.

## What is in here

| Path | What it is |
|---|---|
| `scripts/fetch_catalog.py` | Reads the public storefront feed (`/products.json`, `/collections.json`, the products of the collections named in `config/homes.json`) into `data/raw/`. The page's read was made on 24 Nov 2026 between 12:29 and 12:30 UTC. That full read stays out of this repository. |
| `tests/fixtures/raw/` | 14 products of that read (12 caskets, 2 head panels) and their collections: what the tests run on. |
| `config/homes.json` | The two sample homes: brand, staff and their access switches, pricing rules, hand-picked rooms, earlier arrangements (one of them holds a product the catalog read does not have). |
| `scripts/build.py` | A catalog read to `catalog.json` and `seed.sql` (`--fixture` builds the 14 products into `tests/fixtures/build/`); copies PGlite into `site/vendor/`. |
| `supabase/migrations/20261124120000_funeral_homes.sql` | Schema and row level security: `organizations`, `memberships` (per-person switches), `catalog_items` (with `item_type` and `attributes jsonb`), `catalog_variants`, `pricing_rules`, `selection_rooms`, `selection_room_items`, `session_steps`, `arrangements`, `arrangement_lines`, `arrangement_line_costs`. Prices are computed by the database from the home's rules when a line is saved; the client cannot set them. |
| `supabase/local_auth_shim.sql` | What Supabase already provides (`auth.uid()`, `auth.jwt()`, the `authenticated` and `service_role` roles), for a plain Postgres only. Not for a Supabase project. |
| `site/` | The page. `pricing.js` (prices in cents, what is saved, the cart link), `db.js` (the in-page database), `checks.js` (the cross-tenant check, shared with the tests), `app.js`. |
| `tests/` | Node tests (PGlite and, through `pg_local.sh`, a local PostgreSQL), `probes.mjs` (shared by the tests and the mutants), mutants, and the page in Chromium and WebKit. |
| `worker.js`, `wrangler.toml`, `redirect/` | The Cloudflare Worker serving `site/`, and the one answering 301 at the earlier address. |

## How the pieces behave

- **Isolation.** Every row a home owns carries `org_id`; policies allow a signed-in person only the rows of
  homes they belong to (`app.is_member`). The arrangement list query has no home filter: the database
  returns each home its own rows. `app.price_for(home, variant)` reads any home's rules and cost basis, so
  no signed-in person may execute it: only the pricing triggers (as the owner) and the service role call it.
  Postgres grants every new function to PUBLIC; the migration revokes that for the whole `app` schema.
- **Per-person access.** `can_see_cost`, `can_edit_pricing`, `can_order` on the membership. An arranger can
  save arrangements but cannot read saved costs, change rules, change the order type or mark an
  arrangement ordered; the database refuses each (policies, and the `guard_order` trigger for ordering).
- **Prices.** cost = public price x basis %; retail = rule (percent or amount), then rounding (to the cent,
  up to the whole dollar, or up to .95), then floor. First matching rule wins, by Overnight Caskets'
  own collections. `site/pricing.js` and `app.apply_rule` / `app.price_for` give the same cents. The margin
  percentage is rounded half up in whole numbers.
- **Buy Now / Pre-Need.** 61 caskets list both, with two variant ids at the same price. The family is shown
  Buy Now when it can be ordered, otherwise the variant that can (Jackson Cherry Veneer is offered only as
  Pre-Need). Saving records that variant and its order type; the database refuses a Buy Now or Pre-Need
  line under another order type, and a variant of another product. The director can switch the type only
  when both can be ordered; the database then moves the line to the matching variant (Cambridge Solid
  Mahogany: `50196452868289` Buy Now, `50196452901057` Pre-Need).
- **Supplier link.** `https://overnightcaskets.com/cart/<variant>:<qty>,...`, built only from variant ids of
  the catalog read that are available; anything else is listed as left out. It is shown in full before it
  can be opened, and only the director's click opens it. On 24 Nov 2026 that link led to the public Shop
  Pay checkout at public prices; partner prices through the wholesale account are not checked here.
- **Products the read does not hold.** Arrangement lines keep their title and price and have no foreign key
  to the catalog, so an arrangement holding a product the sync later deletes stays readable, marked "Not in
  the catalog read on <date>". One sample arrangement shows it.
- **Catalog sync.** The demo uses one dated read of the public feed. On that read every product carried
  the same `updated_at` minute, so the public feed cannot drive an incremental sync; production would use
  the Shopify Admin API with product update and delete notifications.
- **Sign-in.** Staff would sign in with a 6-digit email code (Supabase Auth OTP) scoped to their home; the
  demo opens the two sample homes directly and sends no email.

## Run it

```bash
npm install                                   # PGlite 0.5.15 and pg, for the tests
npm test                                      # builds tests/fixtures, then node --test tests/ on PGlite (Postgres 17 in WebAssembly)
node tests/mutants.mjs                        # deliberate breaks of the migration and of pricing.js, each must be caught
sh tests/pg_local.sh                          # the RLS tests again on a throwaway local PostgreSQL (127.0.0.1)
python3 scripts/fetch_catalog.py              # reads the public feed into data/raw (not in the repository)
python3 scripts/build.py                      # data/raw -> site/data/catalog.json, site/db/seed.sql, site/vendor/
npm run test:full                             # the same tests on the full read (CATALOG=full also works for mutants.mjs and pg_local.sh)
python3 scripts/serve.py 8813 site            # local preview on 127.0.0.1:8813
python3 tests/test_page.py http://127.0.0.1:8813/   # the page in Chromium and WebKit (Playwright for Python)
```

On a Supabase project: apply `supabase/migrations/`, then load `seed.sql` with the service role.
The migration has been run on PGlite (Postgres 17) and on PostgreSQL 14, not on a hosted Supabase project.

## Results on 24 Nov 2026

- `npm test`: 28 passed on the 14-product fixture; `npm run test:full`: 28 passed on the full read
  (369 products). Among them: every product of every room saves as shown and can then be ordered; a
  Buy Now or Pre-Need variant only under its own order type; no person can read another home's prices
  through `app.price_for`; only a person allowed to order changes the order type or the status; a line's
  variant belongs to its product; margin percentage on whole cents; no stray apostrophe in a name.
- `sh tests/pg_local.sh`: 22 passed (the 11 RLS tests on PGlite and on PostgreSQL 14.23), fixture and full read.
- `node tests/mutants.mjs`: 18 of 18 mutants caught, fixture and full read.
- `tests/test_page.py` on the page: the full flow, presentation mode, and the director panel with a line
  left out of the link, in Chromium and WebKit, with every request to overnightcaskets.com blocked and
  counted (none made); no horizontal scroll and 44 px touch targets at 1440x900, 1180x820, 820x1180,
  390x844, 1024x768 and 768x1024.

Built by Frederic de Lavenne de Choulot, The AI Pipe.
