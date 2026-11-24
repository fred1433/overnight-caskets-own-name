"""The page in real browsers (Chromium and WebKit, the engine of Safari on iPad).

Run: python tests/test_page.py <url>   (Playwright for Python, browsers installed)
Every request to overnightcaskets.com is blocked and counted: the page must never open the
supplier link by itself, and the tests never open it either.
"""
import asyncio
import re
import sys

from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8813/"
SIZES = [(1024, 768), (768, 1024), (1180, 820), (820, 1180), (390, 844), (1440, 900)]
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


async def flow(browser, engine):
    store_hits = []
    ctx = await browser.new_context(viewport={"width": 1180, "height": 820}, has_touch=True)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    async def block(route):
        store_hits.append(route.request.url)
        await route.abort()

    await pg.route(re.compile(r"https?://(www\.)?overnightcaskets\.com/.*"), block)
    pg.on("popup", lambda p: store_hits.append("popup " + p.url))
    await pg.goto(URL, wait_until="networkidle")

    fam = await pg.inner_text("#app")
    check("Overnight" not in fam and "overnight" not in fam.lower(), f"{engine}: the family view never names Overnight Caskets")
    check(not re.search(r"\b(add to cart|buy|shop|best seller|sale|discount)\b", fam, re.I), f"{engine}: family vocabulary has no shop words")
    first_price = await pg.inner_text("[data-price]")
    check(first_price == "$3,509.95", f"{engine}: Cambridge at Fennimore Hollis shows $3,509.95 ({first_price})")

    await pg.click("[data-act=keep]")
    check(await pg.get_attribute("[data-act=keep]", "aria-pressed") == "true", f"{engine}: Keep for comparison toggles on")
    await pg.click("[data-act=next]")
    name2 = await pg.inner_text(".pname")
    check("Presidential" in name2, f"{engine}: next shows the second casket ({name2})")
    await pg.click("[data-act=keep]")
    check(await pg.is_enabled("[data-act=compare]"), f"{engine}: Compare side by side enabled with two kept")
    await pg.click("[data-act=compare]")
    cols = await pg.locator(".compare-table thead th").count()
    check(cols == 3, f"{engine}: comparison shows two caskets ({cols - 1})")
    rows = await pg.locator(".compare-table tbody tr").count()
    check(rows == 7, f"{engine}: comparison has 7 attribute rows read from the product pages")
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
    await pg.wait_for_selector("[data-saved]", timeout=60000)
    check(True, f"{engine}: Save arrangement saved through the in-page database")

    await pg.click("[data-act=director]")
    await pg.wait_for_selector(".arr", timeout=60000)
    dv = await pg.inner_text(".director")
    check("Sample: Morales family" in dv and "Sample: Lindqvist family" in dv, f"{engine}: director lists this home's arrangements")
    check("Haddad" not in dv, f"{engine}: director never lists the other home's arrangement")
    check("No longer available in the current catalog" in dv, f"{engine}: the unavailable casket is marked, the arrangement still shows")
    check("$2,899.99" in dv and "$1,594.99" in dv and "$1,914.96 (54.6%)" in dv, f"{engine}: ledger shows public, cost and margin")

    # Order type changes the variant in the supplier link, shown before anything is opened
    morales = pg.locator(".arr > li", has_text="Morales")
    await morales.locator("select").select_option("Pre-Need")
    await pg.wait_for_timeout(400)
    morales = pg.locator(".arr > li", has_text="Morales")
    await morales.locator("[data-act=checkout]").click()
    url = await pg.inner_text("[data-cart-url]")
    check(url.startswith("https://overnightcaskets.com/cart/50196452901057:1,"), f"{engine}: Pre-Need puts the Pre-Need variant in the link ({url})")
    href = await pg.get_attribute("a.open", "href")
    check(href == url, f"{engine}: the open link is exactly the link shown")
    check(await pg.get_attribute("a.open", "target") == "_blank", f"{engine}: the store opens only on the director's click, in a new tab")
    lind = pg.locator(".arr > li", has_text="Lindqvist")
    await lind.locator("[data-act=checkout]").click()
    lt = await lind.inner_text()
    check("left out of the link" in lt and "Nothing in this arrangement can be ordered" in lt, f"{engine}: an unavailable casket is left out of the link")

    # Rules reprice the rooms
    await pg.fill("[data-k=r2-value]", "150")
    await pg.wait_for_timeout(200)
    await pg.click("[data-act=close-director]")
    await pg.click("[data-act=step][data-step=casket]")
    p2 = await pg.inner_text("[data-price]")
    check(p2 != "$3,509.95", f"{engine}: editing the Solid wood rule reprices the room ({p2})")

    # Arranger preview hides cost and rules
    await pg.click("[data-act=director]")
    await pg.click("[data-act=as-arranger]")
    await pg.wait_for_timeout(400)
    dv2 = await pg.inner_text(".director")
    check("Illustrative wholesale cost" not in dv2 and "Pricing rules" not in dv2 and "Open supplier checkout" not in dv2,
          f"{engine}: arranger preview hides cost, rules and supplier checkout")
    await pg.keyboard.press("Escape")

    # Second home: other brand, other prices, other arrangements
    await pg.click(".nameplate >> nth=1")
    brand = await pg.inner_text(".brand-name")
    check(brand == "Calder Ruiz", f"{engine}: switching homes changes the brand ({brand})")
    await pg.click("[data-act=director]")
    await pg.wait_for_selector(".arr", timeout=60000)
    dv3 = await pg.inner_text(".director")
    check("Haddad" in dv3 and "Morales" not in dv3 and "Lindqvist" not in dv3, f"{engine}: Calder Ruiz sees only its own arrangements")
    await pg.keyboard.press("Escape")

    # Cross-tenant check, both directions
    for _ in range(2):
        await pg.click("#run-check")
        await pg.wait_for_function("document.querySelectorAll('#checks .a.pass, #checks .a.fail').length === 9", timeout=60000)
        res = await pg.evaluate("[...document.querySelectorAll('#checks .a')].map(a => a.className)")
        who = await pg.inner_text("#who-line")
        check(all("pass" in c for c in res), f"{engine}: cross-tenant check, 9 of 9 as expected ({who[:40]})")
    check(not store_hits, f"{engine}: no request to overnightcaskets.com was made ({store_hits[:2]})")
    check(not errors, f"{engine}: no page errors ({errors[:2]})")
    await ctx.close()


async def layout(browser):
    for w, h in SIZES:
        ctx = await browser.new_context(viewport={"width": w, "height": h}, has_touch=w < 1260, is_mobile=w < 600)
        pg = await ctx.new_page()
        await pg.route(re.compile(r"https?://(www\.)?overnightcaskets\.com/.*"), lambda r: r.abort())
        await pg.goto(URL, wait_until="networkidle")
        for state in ("casket", "compare", "panels", "review", "director"):
            if state == "compare":
                await pg.click("[data-act=keep]"); await pg.click("[data-act=next]"); await pg.click("[data-act=keep]"); await pg.click("[data-act=compare]")
            if state == "panels":
                await pg.click(".compare [data-act=choose] >> nth=0")
            if state == "review":
                await pg.click(".ptile >> nth=0"); await pg.click("[data-act=to-review]")
            if state == "director":
                await pg.click("[data-act=director]")
                await pg.wait_for_selector(".arr", timeout=60000)
            sw = await pg.evaluate("document.documentElement.scrollWidth")
            check(sw <= w, f"{w}x{h} {state}: no horizontal scroll ({sw})")
            small = await small_targets(pg)
            check(not small, f"{w}x{h} {state}: touch targets at least 44 px {small[:3]}")
        framed = await pg.evaluate("getComputedStyle(document.querySelector('.device')).paddingTop")
        if w < 1260:
            check(framed == "0px", f"{w}x{h}: no drawn iPad frame on a tablet or phone")
        await ctx.close()


async def main():
    async with async_playwright() as p:
        for name in ("chromium", "webkit"):
            b = await getattr(p, name).launch()
            await flow(b, name)
            if name == "chromium":
                await layout(b)
            await b.close()
    print(f"\n{'FAILED: ' + str(len(fails)) if fails else 'all page checks passed'}")
    sys.exit(1 if fails else 0)


asyncio.run(main())
