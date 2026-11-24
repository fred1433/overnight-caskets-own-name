"""The page in real browsers (Chromium and WebKit, the engine of Safari on iPad).

Run: python tests/test_page.py <url> [--only g2,g3] [--shots DIR]   (Playwright for Python)
Every request to overnightcaskets.com is blocked and counted: the page must never open the
supplier link by itself, and the tests never open it either.
  --only g2,g3   runs only the checks of G2 (a Pre-Need-only casket saves and can be ordered) and
                 G3 (the director panel never overflows), which also run on the earlier page.
  --shots DIR    saves screenshots: 1440, 390, iPad family, iPad director, presentation.
"""
import argparse
import asyncio
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ap = argparse.ArgumentParser()
ap.add_argument("url", nargs="?", default="http://127.0.0.1:8813/")
ap.add_argument("--only", default="")
ap.add_argument("--shots", default="")
ap.add_argument("--engines", default="chromium,webkit")
ARGS = ap.parse_args()
URL = ARGS.url
ONLY = set(filter(None, ARGS.only.split(",")))
SIZES = [(1440, 900), (1180, 820), (820, 1180), (390, 844), (1024, 768), (768, 1024)]
JACKSON_PRE_NEED = "50035105333441"
fails = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


async def small_targets(pg):
    return await pg.evaluate("""() => [...document.querySelectorAll('#app button, #app select, #app input, #app a')]
      .filter(e => e.offsetParent !== null)
      .map(e => { const r = e.getBoundingClientRect(); return [e.dataset.k || e.className || e.tagName, Math.round(r.width), Math.round(r.height)]; })
      .filter(([, w, h]) => w < 44 || h < 44)""")


async def new_page(browser, w, h, hits=None):
    ctx = await browser.new_context(viewport={"width": w, "height": h}, has_touch=w < 1260, is_mobile=w < 600)
    pg = await ctx.new_page()

    async def block(route):
        if hits is not None:
            hits.append(route.request.url)
        await route.abort()

    await pg.route(re.compile(r"https?://(www\.)?overnightcaskets\.com/.*"), block)
    await pg.goto(URL, wait_until="networkidle")
    return ctx, pg


async def director_fits(pg):
    """G3: the director panel and its content stay inside the window."""
    return await pg.evaluate("""() => {
      const d = document.querySelector('.director'), b = document.querySelector('.d-body');
      const r = d.getBoundingClientRect();
      return { body: [b.scrollWidth, b.clientWidth], left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth,
               page: document.documentElement.scrollWidth };
    }""")


async def g3_overflow(browser, engine):
    for w, h in SIZES[:4]:
        ctx, pg = await new_page(browser, w, h)
        await pg.click("[data-act=director]")
        await pg.wait_for_selector(".arr", timeout=90000)
        lind = pg.locator(".arr > li", has_text="Lindqvist")
        await lind.locator("[data-act=checkout]").click()
        await pg.wait_for_selector("[data-checkout]")
        f = await director_fits(pg)
        ok = f["body"][0] <= f["body"][1] + 1 and f["left"] >= -1 and f["right"] <= f["vw"] + 1 and f["page"] <= w
        check(ok, f"G3 {engine} {w}x{h}: director panel fits with a line left out of the link {f}")
        await ctx.close()


async def g2_pre_need_only(browser, engine):
    hits = []
    ctx, pg = await new_page(browser, 1180, 820, hits)
    await pg.click(".nameplate >> nth=1")
    await pg.locator(".room-tab", has_text=re.compile(r"^\s*Wood\s*$")).click()
    await pg.locator(".thumb", has_text="Jackson").click()
    await pg.click(".info [data-act=choose]")
    await pg.click("[data-act=panel][data-id=none]")
    await pg.click("[data-act=to-review]")
    await pg.click("[data-act=save]")
    await pg.wait_for_selector("[data-saved]", timeout=90000)
    await pg.click("[data-act=director]")
    await pg.wait_for_selector(".arr", timeout=90000)
    card = pg.locator(".arr > li", has_text="Whitfield")
    gone = await card.locator(".gone").count()
    check(gone == 0, f"G2 {engine}: the Pre-Need-only Jackson casket just saved is not marked unavailable ({gone})")
    await card.locator("[data-act=checkout]").click()
    url = await card.locator("[data-cart-url]").inner_text() if await card.locator("[data-cart-url]").count() else ""
    check(url == f"https://overnightcaskets.com/cart/{JACKSON_PRE_NEED}:1", f"G2 {engine}: its supplier link orders the Pre-Need variant ({url or 'no link'})")
    text = await card.inner_text()
    check("Order type: Pre-Need" in text, f"G2 {engine}: the arrangement records Pre-Need, with no Buy Now choice offered")
    check(not hits, f"G2 {engine}: no request to overnightcaskets.com ({hits[:1]})")
    await ctx.close()


async def flow(browser, engine):
    store_hits = []
    errors = []
    ctx, pg = await new_page(browser, 1180, 820, store_hits)
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.on("popup", lambda p: store_hits.append("popup " + p.url))

    check(await pg.title() == "Your caskets, under a funeral home’s own name", f"{engine}: page title renamed")
    fam = await pg.inner_text("#app")
    check("overnight" not in fam.lower(), f"{engine}: the family view never names Overnight Caskets")
    check(not re.search(r"\b(add to cart|buy|shop|best seller|sale|discount)\b", fam, re.I), f"{engine}: family vocabulary has no shop words")
    first_price = await pg.inner_text("[data-price]")
    check(first_price == "$3,509.95", f"{engine}: Cambridge at Fennimore Hollis shows $3,509.95 ({first_price})")
    for sel in ("footer .call a", ".repo-line a"):
        t, rel = await pg.get_attribute(sel, "target"), await pg.get_attribute(sel, "rel")
        check(t == "_blank" and "noopener" in (rel or ""), f"{engine}: {sel} opens in a new tab with noopener")

    await pg.click("[data-act=keep]")
    check(await pg.get_attribute("[data-act=keep]", "aria-pressed") == "true", f"{engine}: Keep for comparison toggles on")
    await pg.click("[data-act=next]")
    name2 = await pg.inner_text(".pname")
    check("Presidential" in name2, f"{engine}: next shows the second casket ({name2})")
    await pg.click("[data-act=keep]")
    await pg.click("[data-act=compare]")
    cols = await pg.locator(".compare-table thead th").count()
    check(cols == 3, f"{engine}: comparison shows two caskets ({cols - 1})")
    rows = await pg.locator(".compare-table tbody th").all_inner_texts()
    check(rows == ["Material", "Exterior finish", "Interior", "Bed", "Sealed", "Exterior size"], f"{engine}: comparison rows, no construction or hardware prose ({rows})")
    await pg.click(".compare [data-act=choose] >> nth=0")
    check(await pg.locator(".panels").count() == 1, f"{engine}: choosing moves to the head panel step")
    check(not await pg.is_enabled("[data-act=to-review]"), f"{engine}: review waits for a panel choice")
    await pg.click("[data-act=chip][data-c=Blue]")
    blue = await pg.locator(".ptile").count()
    check(blue == 1 + 9, f"{engine}: Blue filter shows 9 blue panels plus No head panel ({blue - 1})")
    await pg.click(".ptile >> nth=1")
    await pg.click("[data-act=to-review]")
    total = await pg.inner_text(".lines tfoot .l-price")
    check(total == "$3,712.95", f"{engine}: review total $3,509.95 + $203.00 = {total}")
    await pg.click("[data-act=save]")
    await pg.wait_for_selector("[data-saved]", timeout=90000)
    check(True, f"{engine}: Save arrangement saved through the in-page database")

    await pg.click("[data-act=director]")
    await pg.wait_for_selector(".arr", timeout=90000)
    dv = await pg.inner_text(".director")
    check("Sample: Morales family" in dv and "Sample: Lindqvist family" in dv, f"{engine}: director lists this home's arrangements")
    check("Haddad" not in dv and "Okafor" not in dv, f"{engine}: director never lists the other home's arrangements")
    check("Not available in the catalog read on 24 Nov 2026" in dv and "no longer" not in dv.lower(), f"{engine}: the unavailable casket is marked in the words of the one catalog read")
    check("$2,899.99" in dv and "$1,594.99" in dv and "$1,914.96 (54.6%)" in dv, f"{engine}: ledger shows public, cost and margin")
    check("Illustrative wholesale cost" in dv and "Illustrative margin" in dv and "Illustrative cost" in dv, f"{engine}: cost and margin are called illustrative next to the amounts")
    check("struck-through" not in dv, f"{engine}: no sentence about the struck-through price")

    morales = pg.locator(".arr > li", has_text="Morales")
    await morales.locator("select").select_option("Pre-Need")
    await pg.wait_for_timeout(500)
    morales = pg.locator(".arr > li", has_text="Morales")
    await morales.locator("[data-act=checkout]").click()
    url = await pg.inner_text("[data-cart-url]")
    check(url.startswith("https://overnightcaskets.com/cart/50196452901057:1,"), f"{engine}: Pre-Need puts the Pre-Need variant in the link ({url})")
    href = await pg.get_attribute("a.open", "href")
    check(href == url, f"{engine}: the open link is exactly the link shown")
    check(await pg.inner_text("a.open") == "Open public checkout (public prices)", f"{engine}: the button says public checkout, public prices")
    check("Partner prices would come from the wholesale account" in await pg.inner_text("[data-checkout]"), f"{engine}: the line under it says partner prices come from the wholesale account")
    check(await pg.get_attribute("a.open", "target") == "_blank", f"{engine}: the store opens only on the director's click, in a new tab")
    lind = pg.locator(".arr > li", has_text="Lindqvist")
    check(await lind.locator("select").count() == 0, f"{engine}: no Buy Now / Pre-Need choice on a product without it")
    await lind.locator("[data-act=checkout]").click()
    lt = await lind.inner_text()
    check("left out of the link" in lt and "Nothing in this arrangement can be ordered" in lt, f"{engine}: an unavailable casket is left out of the link")
    f = await director_fits(pg)
    check(f["body"][0] <= f["body"][1] + 1, f"{engine}: G3 director panel does not overflow with a line left out ({f['body']})")

    await pg.fill("[data-k=r2-value]", "150")
    await pg.wait_for_timeout(200)
    await pg.click("[data-act=close-director]")
    await pg.click("[data-act=step][data-step=casket]")
    p2 = await pg.inner_text("[data-price]")
    check(p2 != "$3,509.95", f"{engine}: editing the Solid wood rule reprices the room ({p2})")

    await pg.click("[data-act=director]")
    await pg.click("[data-act=as-arranger]")
    await pg.wait_for_timeout(400)
    dv2 = await pg.inner_text(".director")
    check("Illustrative wholesale cost" not in dv2 and "Pricing rules" not in dv2 and "Prepare supplier order" not in dv2,
          f"{engine}: arranger preview hides cost, rules and supplier order")
    await pg.click("[data-act=as-arranger]")
    await pg.keyboard.press("Escape")

    await pg.click(".nameplate >> nth=1")
    brand = await pg.inner_text(".brand-name")
    check(brand.lower() == "calder ruiz", f"{engine}: switching homes changes the brand ({brand})")
    await pg.click("[data-act=director]")
    await pg.wait_for_selector(".arr", timeout=90000)
    dv3 = await pg.inner_text(".director")
    check("Haddad" in dv3 and "Morales" not in dv3 and "Lindqvist" not in dv3, f"{engine}: Calder Ruiz sees only its own arrangements")
    okafor = await pg.locator(".arr > li", has_text="Okafor").inner_text()
    check("Not in the catalog read on 24 Nov 2026" in okafor and "$2,450.00" in okafor, f"{engine}: C1 an arrangement with a model absent from the read shows, marked")
    await pg.keyboard.press("Escape")

    for _ in range(2):
        await pg.click("#run-check")
        await pg.wait_for_function("document.querySelectorAll('#checks .a.pass, #checks .a.fail').length === 11", timeout=90000)
        res = await pg.evaluate("[...document.querySelectorAll('#checks .a')].map(a => a.className)")
        verdict = await pg.inner_text("#verdict")
        check(all("pass" in c for c in res) and verdict.startswith("No."), f"{engine}: cross-tenant check, 11 of 11 as expected ({verdict})")
        prices = await pg.inner_text("[data-check=prices] .a")
        check("permission denied" in prices, f"{engine}: G1 the other home's prices are refused ({prices[:60]})")

    # C5: presentation to the family
    await pg.click(".nameplate >> nth=0")
    await pg.click("#present")
    await pg.wait_for_timeout(400)
    title = await pg.title()
    visible = await pg.evaluate("document.body.innerText")
    check(title == "Fennimore Hollis Funeral Home" and "overnight" not in title.lower(), f"{engine}: presentation titles the tab with the home's name ({title})")
    check("overnight" not in visible.lower(), f"{engine}: presentation shows no Overnight Caskets name anywhere")
    check(await pg.locator("[data-act=director]").count() == 0, f"{engine}: presentation hides Director view")
    box = await pg.evaluate("(() => { const r = document.querySelector('#app').getBoundingClientRect(); return [r.left, r.top, r.width, r.height, innerWidth, innerHeight]; })()")
    check(abs(box[2] - box[4]) <= 1 and abs(box[3] - box[5]) <= 1 and box[0] == 0 and box[1] == 0, f"{engine}: the home fills the window ({box})")
    await pg.click("[data-act=leave-present]")
    await pg.wait_for_timeout(300)
    check(await pg.title() == "Your caskets, under a funeral home’s own name" and await pg.locator("#apart").is_visible(), f"{engine}: the corner button leaves the presentation")

    check(not store_hits, f"{engine}: no request to overnightcaskets.com was made ({store_hits[:2]})")
    check(not errors, f"{engine}: no page errors ({errors[:2]})")
    await ctx.close()


async def layout(browser, engine):
    for w, h in SIZES:
        ctx, pg = await new_page(browser, w, h)
        for state in ("casket", "compare", "panels", "review", "director", "checkout"):
            if state == "compare":
                await pg.click("[data-act=keep]"); await pg.click("[data-act=next]"); await pg.click("[data-act=keep]"); await pg.click("[data-act=compare]")
            if state == "panels":
                await pg.click(".compare [data-act=choose] >> nth=0")
            if state == "review":
                await pg.click(".ptile >> nth=0"); await pg.click("[data-act=to-review]")
            if state == "director":
                await pg.click("[data-act=director]")
                await pg.wait_for_selector(".arr", timeout=90000)
            if state == "checkout":
                await pg.locator(".arr > li", has_text="Lindqvist").locator("[data-act=checkout]").click()
                f = await director_fits(pg)
                check(f["body"][0] <= f["body"][1] + 1 and f["left"] >= -1 and f["right"] <= f["vw"] + 1, f"{engine} {w}x{h} checkout: G3 director panel fits {f}")
            sw = await pg.evaluate("document.documentElement.scrollWidth")
            check(sw <= w, f"{engine} {w}x{h} {state}: no horizontal scroll ({sw})")
            small = await small_targets(pg)
            check(not small, f"{engine} {w}x{h} {state}: touch targets at least 44 px {small[:3]}")
        framed = await pg.evaluate("getComputedStyle(document.querySelector('.device')).paddingTop")
        if w < 1260:
            check(framed == "0px", f"{engine} {w}x{h}: no drawn iPad frame on a tablet or phone")
        await ctx.close()


async def shots(browser, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    ctx, pg = await new_page(browser, 1440, 900)
    await pg.wait_for_timeout(800)
    await pg.screenshot(path=str(out / "osr_1440_fold.png"))
    await pg.click("#run-check")
    await pg.wait_for_function("document.querySelectorAll('#checks .a.pass, #checks .a.fail').length === 11", timeout=90000)
    await pg.evaluate("document.querySelector('#apart').scrollIntoView()")
    await pg.wait_for_timeout(300)
    await pg.screenshot(path=str(out / "osr_1440_section2.png"))
    await ctx.close()
    ctx, pg = await new_page(browser, 390, 844)
    await pg.wait_for_timeout(800)
    await pg.screenshot(path=str(out / "osr_390_fold.png"))
    await ctx.close()
    ctx, pg = await new_page(browser, 1180, 820)
    await pg.evaluate("document.querySelector('#app').scrollIntoView()")
    await pg.wait_for_timeout(800)
    await pg.screenshot(path=str(out / "osr_ipad_famille.png"))
    await pg.click("[data-act=director]")
    await pg.wait_for_selector(".arr", timeout=90000)
    await pg.locator(".arr > li", has_text="Lindqvist").locator("[data-act=checkout]").click()
    await pg.evaluate("document.querySelector('#app').scrollIntoView()")
    await pg.wait_for_timeout(400)
    await pg.screenshot(path=str(out / "osr_ipad_directeur.png"))
    await pg.keyboard.press("Escape")
    await pg.click(".nameplate >> nth=1")
    await pg.click("#present")
    await pg.wait_for_timeout(800)
    await pg.screenshot(path=str(out / "osr_presentation.png"))
    await ctx.close()
    print("screenshots in", out)


async def main():
    async with async_playwright() as p:
        for name in ARGS.engines.split(","):
            b = await getattr(p, name).launch()
            if ONLY:
                if "g2" in ONLY:
                    await g2_pre_need_only(b, name)
                if "g3" in ONLY:
                    await g3_overflow(b, name)
            else:
                await flow(b, name)
                await g2_pre_need_only(b, name)
                await layout(b, name)
            if ARGS.shots and name == "webkit":
                await shots(b, ARGS.shots)
            await b.close()
    print(f"\n{'FAILED: ' + str(len(fails)) if fails else 'all page checks passed'}")
    sys.exit(1 if fails else 0)


asyncio.run(main())
