"""Reads the public storefront feed of overnightcaskets.com into a folder that scripts/build.py turns
into the page's catalog. The full read is not kept in this repository; tests run on tests/fixtures/raw.

  python3 scripts/fetch_catalog.py                      # https://overnightcaskets.com -> data/raw
  python3 scripts/fetch_catalog.py --base URL --out DIR

Requests made: /products.json (250 per page, until a short page), /collections.json, and
/collections/<handle>/products.json for each collection named in config/homes.json. Nothing else.
"""
import argparse
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def get(base, path):
    req = urllib.request.Request(base.rstrip("/") + path, headers={"User-Agent": "catalog-read/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://overnightcaskets.com")
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "raw")
    args = ap.parse_args()
    out = args.out
    (out / "collections").mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    page, seen = 1, set()
    while True:
        batch = get(args.base, f"/products.json?limit=250&page={page}")["products"]
        fresh = [p for p in batch if p["id"] not in seen]
        if not fresh:
            break
        seen.update(p["id"] for p in fresh)
        (out / f"products_p{page}.json").write_text(json.dumps({"products": fresh}, ensure_ascii=False))
        if len(batch) < 250:
            break
        page += 1
        time.sleep(1)

    (out / "collections.json").write_text(json.dumps(get(args.base, "/collections.json?limit=250"), ensure_ascii=False))
    homes = json.loads((ROOT / "config" / "homes.json").read_text())["homes"]
    handles = sorted({r["collection"] for h in homes for r in h["rooms"]} | {r["collection"] for h in homes for r in h["rules"] if r["collection"]})
    for h in handles:
        time.sleep(1)
        data = get(args.base, f"/collections/{h}/products.json?limit=250")
        (out / "collections" / f"{h}.json").write_text(json.dumps(data, ensure_ascii=False))

    (out / "read_started_utc.txt").write_text(started + "\n")
    (out / "read_finished_utc.txt").write_text(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") + "\n")
    print(f"{len(seen)} products, {len(handles)} collections -> {out}")


if __name__ == "__main__":
    main()
