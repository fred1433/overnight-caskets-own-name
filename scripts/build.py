"""Catalog read -> catalog.json, seed.sql, and the SQL the page runs.

Reads only a folder written by scripts/fetch_catalog.py (the public storefront feed) and
config/homes.json; never the store itself.
  python3 scripts/build.py              data/raw -> site/ (the page; data/raw is not in the repository)
  python3 scripts/build.py --fixture    tests/fixtures/raw (14 products) -> tests/fixtures/build/
"""
import argparse
import html
import json
import re
import shutil
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
SITE = ROOT / "site"
FIXTURE = False

PANEL = re.compile(r"\b(head|cap) panel\b", re.I)
PET = re.compile(r"\bpet\b", re.I)
URN = re.compile(r"\burns?\b|keepsake", re.I)


def classify(p):
    t = p["title"]
    if PANEL.search(t):
        return "lid_panel"
    if PET.search(t):
        return "pet_casket"
    if URN.search(t) or "urn" in (p.get("product_type") or "").lower():
        return "urn"
    body = p.get("body_html") or ""
    if re.search(r"casket", t, re.I) or "INTERIOR LINING" in body or "EXTERIOR FINISH" in body:
        return "casket"
    return "other"


def text(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def features(body):
    """Each <li><strong>KEY</strong> - value</li> of the product page, verbatim."""
    out = []
    for li in re.findall(r"<li[^>]*>(.*?)</li>", body or "", re.S | re.I):
        m = re.match(r"\s*(?:<span[^>]*>\s*)?<strong>(.*?)</strong>(.*)", li, re.S | re.I)
        if not m:
            continue
        key = text(m.group(1)).strip(" -:")
        val = text(m.group(2)).lstrip(" -:–").strip()
        if key:
            out.append((key, val))
    return out


def attributes(body):
    f = features(body)
    a = {}

    def first(pred):
        for k, v in f:
            if pred(k.upper()):
                return k, v
        return None

    c = first(lambda k: any(w in k for w in ("CONSTRUCTION", "SOLID", "HARDWOOD", "VENEER", "KOSHER", "CLOTH COVERED", "GREEN BURIAL")))
    if c:
        a["construction"] = (c[0].capitalize() + (": " + c[1] if c[1] else "")).strip()
        m = material(c[0])
        if m:
            a["material"] = m
    for key, name in (("EXTERIOR FINISH", "finish"), ("INTERIOR LINING", "interior"), ("HARDWARE", "hardware")):
        hit = first(lambda k, key=key: k == key)
        if hit and hit[1]:
            a[name] = hit[1]
    bed = first(lambda k: "COUCH" in k)
    if bed:
        a["bed"] = bed[0].capitalize().replace("&", "and")
    seal = first(lambda k: "SEALED" in k)
    a["sealed"] = (seal[1] or "Sealed and locked") if seal else None
    ext = first(lambda k: k == "EXTERIOR")
    if ext and ext[1]:
        a["exterior_size"] = ext[1]
    return {k: v for k, v in a.items() if v}


def clean(title):
    """Whitespace collapsed, and the stray apostrophes of some source titles dropped
    ("White Cross' Lords Prayer" -> "White Cross Lords Prayer"); "God's" keeps its own."""
    t = re.sub(r"\s+", " ", title).strip()
    return re.sub(r"(?<=[A-Za-z])['\u2019](?![A-Za-z])", "", t)


def material(construction_key):
    """Wood or steel, in the product page's own words: "Steel construction" -> "Steel"."""
    k = re.sub(r"\s+construction$", "", construction_key.strip(), flags=re.I)
    k = re.sub(r"^(Solid \w+) wood$", r"\1", k, flags=re.I)
    return None if k.lower() in ("durable", "") else k[0].upper() + k[1:].lower()


def display_name(title):
    t = clean(title)
    t = re.sub(r"\s*-\s*[^-]*casket\s*$", "", t, flags=re.I)
    m = re.match(r"(.*?)\s+(with .*)$", t, re.I)
    if m and len(m.group(1)) > 6:
        return m.group(1), m.group(2)[0].lower() + m.group(2)[1:]
    return t, ""


def cents(s):
    d, _, c = s.partition(".")
    return int(d) * 100 + int((c + "00")[:2])


def order_type(p, v):
    for i, o in enumerate(p["options"], start=1):
        if o["name"] == "Order Type":
            return v.get(f"option{i}")
    return None


def main():
    global RAW, SITE, FIXTURE
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", action="store_true", help="tests/fixtures/raw -> tests/fixtures/build")
    ap.add_argument("--raw", type=Path)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    if args.fixture:
        FIXTURE, RAW, SITE = True, ROOT / "tests" / "fixtures" / "raw", ROOT / "tests" / "fixtures" / "build"
    RAW, SITE = args.raw or RAW, args.out or SITE
    if not (RAW / "read_started_utc.txt").exists():
        raise SystemExit(f"{RAW} holds no catalog read: run scripts/fetch_catalog.py first, or use --fixture")
    read_start = (RAW / "read_started_utc.txt").read_text().strip()
    read_end = (RAW / "read_finished_utc.txt").read_text().strip()
    products = []
    for f in sorted(RAW.glob("products_p*.json")):
        products += json.loads(f.read_text())["products"]
    by_handle = {p["handle"]: p for p in products}
    by_title = {p["title"]: p for p in products}

    collections_meta = {c["handle"]: c for c in json.loads((RAW / "collections.json").read_text())["collections"]}
    members = {}
    for f in sorted((RAW / "collections").glob("*.json")):
        members[f.stem] = [p["handle"] for p in json.loads(f.read_text())["products"]]
    in_coll = {}
    for h, hs in members.items():
        for x in hs:
            in_coll.setdefault(x, []).append(h)

    counts = {"products": len(products), "variants": sum(len(p["variants"]) for p in products)}
    for p in products:
        t = classify(p)
        counts[t] = counts.get(t, 0) + 1

    items = {}
    for p in products:
        t = classify(p)
        if t not in ("casket", "lid_panel"):
            continue
        name, sub = display_name(p["title"]) if t == "casket" else (clean(p["title"]), "")
        img = p["images"][0]["src"] if p["images"] else None
        items[str(p["id"])] = {
            "id": p["id"],
            "type": t,
            "handle": p["handle"],
            "title": p["title"],
            "name": name,
            "sub": sub,
            "image": img,
            "collections": sorted(in_coll.get(p["handle"], [])),
            "attributes": attributes(p.get("body_html")) if t == "casket" else {},
            "options": [o["name"] for o in p["options"]],
            "variants": [
                {
                    "id": v["id"],
                    "title": v["title"],
                    "order_type": order_type(p, v),
                    "price": cents(v["price"]),
                    "available": bool(v["available"]),
                }
                for v in p["variants"]
            ],
        }

    homes = json.loads((ROOT / "config" / "homes.json").read_text())["homes"]
    out_homes = []
    for h in homes:
        rooms = []
        for r in h["rooms"]:
            if r["items"] == "all_available":
                handles = [x for x in members[r["collection"]] if any(v["available"] for v in by_handle[x]["variants"])]
            else:
                handles = [x for x in r["items"] if x in by_handle or not FIXTURE]
            ids = []
            for x in handles:
                if x not in by_handle:
                    raise SystemExit(f"config/homes.json names {x}, which the catalog read in {RAW} does not hold "
                                     "(--fixture keeps only the products present)")
                p = by_handle[x]
                assert x in members[r["collection"]], f"{x} is not in {r['collection']}"
                assert classify(p) == "casket", x
                assert any(v["available"] for v in p["variants"]), f"{x} has no available variant"
                ids.append(p["id"])
            if FIXTURE and not ids:
                continue
            rooms.append({
                "id": str(uuid.uuid5(uuid.UUID(h["id"]), r["name"])),
                "name": r["name"],
                "collection": r["collection"],
                "collection_title": collections_meta[r["collection"]]["title"],
                "collection_read": len(members[r["collection"]]),
                "items": ids,
            })
        samples = []
        for s in h["samples"]:
            lines = []
            for ln in s["lines"]:
                if ln.get("absent"):
                    # A line saved before the catalog read, of a product that read does not hold.
                    lines.append({"step": ln["step"], "item": 0, "variant": 0, "title": ln["title"], "retail": round(ln["retail"] * 100)})
                    continue
                p = by_handle[ln["handle"]] if "handle" in ln else by_title[ln["title"]]
                vs = p["variants"]
                v = next((x for x in vs if order_type(p, x) == s.get("order_type")), vs[0])
                lines.append({"step": ln["step"], "item": p["id"], "variant": v["id"], "title": p["title"]})
            samples.append({
                "id": str(uuid.uuid5(uuid.UUID(h["id"]), s["family"])),
                "family": s["family"],
                "order_type": s.get("order_type"),
                "lines": lines,
            })
        out_homes.append({**{k: h[k] for k in ("id", "name", "short", "monogram", "brand", "wholesale_basis_pct",
                                                 "users", "session_family")},
                          "rules": [{**r, "id": str(uuid.uuid5(uuid.UUID(h["id"]), "rule-" + r["label"])), "position": i + 1}
                                    for i, r in enumerate(h["rules"])],
                          "rooms": rooms, "samples": samples})

    catalog = {
        "read_started": read_start,
        "read_finished": read_end,
        "source": "https://overnightcaskets.com/products.json and /collections.json (public storefront feed)",
        "counts": counts,
        "collections": {h: {"title": collections_meta[h]["title"], "read": len(m),
                            "products_count": collections_meta[h].get("products_count")} for h, m in members.items()},
        "items": items,
        "homes": out_homes,
    }
    (SITE / "data").mkdir(parents=True, exist_ok=True)
    (SITE / "data" / "catalog.json").write_text(json.dumps(catalog, separators=(",", ":"), ensure_ascii=False))

    # Seed: what the sync (service role) and the onboarding would have written.
    q = lambda s: "null" if s is None else "'" + str(s).replace("'", "''") + "'"
    sql = ["-- Generated by scripts/build.py from the catalog snapshot and config/homes.json. Run as the service role.",
           "begin;"]
    for it in items.values():
        sql.append(
            "insert into public.catalog_items (id, item_type, handle, title, attributes, image_url, collections, read_at) values "
            f"({it['id']}, {q(it['type'])}, {q(it['handle'])}, {q(it['title'])}, {q(json.dumps(it['attributes'], ensure_ascii=False))}::jsonb, "
            f"{q(it['image'])}, {q('{' + ','.join(it['collections']) + '}')}::text[], {q(read_start)});")
        for v in it["variants"]:
            sql.append(
                "insert into public.catalog_variants (id, item_id, title, order_type, public_price_cents, available, read_at) values "
                f"({v['id']}, {it['id']}, {q(v['title'])}, {q(v['order_type'])}, {v['price']}, {str(v['available']).lower()}, {q(read_start)});")
    for h in out_homes:
        sql.append(f"insert into public.organizations (id, name, brand, wholesale_basis_pct) values "
                   f"({q(h['id'])}, {q(h['name'])}, {q(json.dumps({**h['brand'], 'monogram': h['monogram']}))}::jsonb, {h['wholesale_basis_pct']});")
        for u in h["users"]:
            sql.append("insert into public.memberships (org_id, user_id, label, role, can_see_cost, can_edit_pricing, can_order) values "
                       f"({q(h['id'])}, {q(u['id'])}, {q(u['label'])}, {q(u['role'])}, {str(u['can_see_cost']).lower()}, "
                       f"{str(u['can_edit_pricing']).lower()}, {str(u['can_order']).lower()});")
        for r in h["rules"]:
            sql.append("insert into public.pricing_rules (id, org_id, position, label, item_type, collection_handle, markup_kind, markup_value, rounding, floor_cents) values "
                       f"({q(r['id'])}, {q(h['id'])}, {r['position']}, {q(r['label'])}, {q(r['item_type'])}, {q(r['collection'])}, "
                       f"{q(r['kind'])}, {r['value']}, {q(r['rounding'])}, {int(round(r['floor'] * 100))});")
        for i, r in enumerate(h["rooms"]):
            sql.append(f"insert into public.selection_rooms (id, org_id, name, source_collection, position) values "
                       f"({q(r['id'])}, {q(h['id'])}, {q(r['name'])}, {q(r['collection'])}, {i});")
            for j, it in enumerate(r["items"]):
                sql.append(f"insert into public.selection_room_items (room_id, org_id, item_id, position) values "
                           f"({q(r['id'])}, {q(h['id'])}, {it}, {j});")
        sql.append(f"insert into public.session_steps (org_id, key, label, item_type, required, position) values "
                   f"({q(h['id'])}, 'casket', 'Casket', 'casket', true, 1), ({q(h['id'])}, 'lid_panel', 'Head panel', 'lid_panel', false, 2);")
        for s in h["samples"]:
            sql.append(f"insert into public.arrangements (id, org_id, family_label, order_type) values "
                       f"({q(s['id'])}, {q(h['id'])}, {q('Sample: ' + s['family'])}, {q(s['order_type'])});")
            for k, ln in enumerate(s["lines"]):
                sql.append("insert into public.arrangement_lines (arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents, position) values "
                           f"({q(s['id'])}, {q(h['id'])}, {q(ln['step'])}, {ln['item']}, {ln['variant']}, {q(ln['title'])}, {ln.get('retail', 0)}, {k});")
    sql.append("commit;")
    (SITE / "db").mkdir(parents=True, exist_ok=True)
    (SITE / "db" / "seed.sql").write_text("\n".join(sql) + "\n")
    shutil.copy(ROOT / "supabase" / "local_auth_shim.sql", SITE / "db" / "local_auth_shim.sql")
    migs = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))
    (SITE / "db" / "migration.sql").write_text("\n".join(m.read_text() for m in migs))

    # PGlite, served from this site rather than a third-party CDN.
    src = ROOT / "node_modules" / "@electric-sql" / "pglite" / "dist"
    dst = SITE / "vendor" / "pglite"
    if src.exists() and not FIXTURE:
        dst.mkdir(parents=True, exist_ok=True)
        for f in src.iterdir():
            if f.is_file() and (f.suffix in (".js", ".wasm", ".data")) and not f.name.endswith(".map"):
                shutil.copy(f, dst / f.name)
    print(json.dumps(counts), len(items), "items,", sum(len(r["items"]) for h in out_homes for r in h["rooms"]), "room places")


if __name__ == "__main__":
    main()
