"""Exercise the real page offline. Every HTTP request is fulfilled or blocked.

python -m pip install playwright==1.51.0
python -m playwright install chromium webkit
python tests/desktop-layout.py [chromium|webkit]
"""
import base64
import json
from pathlib import Path
import sys
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://mediashare.test"
FIREBASE = """
export const initializeApp=()=>({}), getAuth=()=>({}), getFirestore=()=>({});
export const signInAnonymously=async()=>({});
export const onAuthStateChanged=(_,callback)=>queueMicrotask(()=>callback({uid:'fixture',getIdToken:async()=>'fixture-token'}));
export const collection=(...args)=>args,doc=(...args)=>args,query=(...args)=>args,where=(...args)=>args;
export const onSnapshot=(_,callback)=>{queueMicrotask(()=>callback({docs:[]}));return ()=>{};};
export const getDoc=async()=>({exists:()=>false,data:()=>({})});
export const setDoc=async()=>{},addDoc=async()=>{},deleteDoc=async()=>{},serverTimestamp=()=>null;
"""


def run(engine):
    with sync_playwright() as p:
        browser = getattr(p, engine).launch()
        context = browser.new_context(viewport={"width": 800, "height": 800}, reduced_motion="reduce")
        page = context.new_page()
        errors, mutations, unexpected = [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        row = dict(id="fixture-slide", revision=1, imageKey="fixture-image", titleStatus="queued",
                   title="", published=False, availableStartingDate="2026-10-25", targetServicePeriod="pm",
                   worker=dict(ready=True, loaded=True, scheduled=True))

        def route(request):
            url = request.request.url
            parsed = urlparse(url)
            if parsed.netloc == "mediashare.test":
                relative = parsed.path.lstrip("/") or "index.html"
                file = ROOT / relative
                if not file.is_file() or ROOT not in file.resolve().parents:
                    request.abort(); return
                mime = "text/html" if file.suffix == ".html" else "text/css" if file.suffix == ".css" else "text/javascript"
                request.fulfill(body=file.read_bytes(), content_type=mime)
            elif parsed.netloc == "www.gstatic.com":
                request.fulfill(body=FIREBASE, content_type="text/javascript")
            elif parsed.netloc == "desktop-vjt2br2.tail385c9d.ts.net":
                method = request.request.method
                if method == "OPTIONS":
                    request.fulfill(status=204, headers={"Access-Control-Allow-Origin": ORIGIN,
                        "Access-Control-Allow-Headers": "authorization,content-type", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE"}); return
                if method in ("POST", "PATCH", "DELETE"):
                    mutations.append((method, (request.request.post_data_buffer or b'').decode('utf-8', errors='replace')))
                if method == "PATCH":
                    row.update(request.request.post_data_json); row["revision"] += 1
                    if row.get("title"):
                        row["title"] = row["title"].strip()
                request.fulfill(json=row, headers={"Access-Control-Allow-Origin": ORIGIN})
            elif parsed.netloc == "avatars.githubusercontent.com":
                request.fulfill(body=(ROOT / "macos/Resources/MediaShare.png").read_bytes(), content_type="image/png")
            elif parsed.netloc in ("fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"):
                # No external fonts or optional local OCR downloads.
                request.abort()
            else:
                unexpected.append(url); request.abort()

        context.route("**/*", route)
        page.goto(ORIGIN)
        expect(page.locator("#connLabel")).to_have_text("Connected")
        expect(page.locator("#composeView > h2")).to_have_count(0)
        date = page.locator("#availableStartingDate")
        date.fill("2026-10-25")
        expect(page.locator("#sundayServicePeriod")).to_be_visible()
        page.locator("#servicePeriodAM").check()
        page.locator("#servicePeriodPM").check()
        expect(page.locator("#servicePeriodAM")).not_to_be_checked()

        def fits(label):
            dimensions = page.evaluate("""() => ({
                width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
                scrollHeight:document.documentElement.scrollHeight,
                bottom:document.querySelector('#submitBtn').getBoundingClientRect().bottom
            })""")
            assert dimensions["scrollWidth"] <= dimensions["width"] + 1, (label, dimensions)
            assert dimensions["scrollHeight"] <= dimensions["height"] + 1, (label, dimensions)
            assert dimensions["bottom"] <= dimensions["height"], (label, dimensions)

        def squares(label):
            for size in (640, 680, 720, 800, 900):
                page.set_viewport_size({"width": size, "height": size})
                fits(f"{label}/{size}")
                preview = page.locator("#dropzone").bounding_box()
                assert abs(preview["width"] - min(size - 44, 636)) < 1, preview
                if label != "empty":
                    image = page.locator("#stagedGrid .tile").bounding_box()
                    assert abs(image["width"] / image["height"] - 16/9) < .01, image
                    title = page.locator("#composeAutoTitle input").bounding_box()
                    assert title["y"] + title["height"] <= preview["y"], (title, preview)

        squares("empty")
        # A generated fixture PNG, never an actual church slide or service record.
        png = page.evaluate("""() => {const c=document.createElement('canvas');c.width=1280;c.height=720;
            const x=c.getContext('2d');x.fillStyle='#123a44';x.fillRect(0,0,1280,720);
            x.fillStyle='#efe9de';x.font='64px Georgia';x.textAlign='center';x.fillText('A Place of Hope',640,380);
            return c.toDataURL().split(',')[1];}""")
        page.locator("#fileInput").set_input_files({"name": "fixture.png", "mimeType": "image/png", "buffer": base64.b64decode(png)})
        expect(page.locator("#composeAutoTitle")).to_have_attribute("data-ai-state", "queued")
        expect(page.locator("#submitBtn")).to_be_enabled()
        assert len(mutations) == 1 and mutations[0][0] == "POST", mutations
        squares("processing")

        # Date edits stay intact while the delayed title arrives.
        date.fill("2026-10-28")
        expect(page.locator("#sundayServicePeriod")).to_be_hidden()
        row.update(titleStatus="complete", title="A Place of Hope", published=True)
        expect(page.locator("#composeAutoTitle input")).to_have_value("A Place of Hope", timeout=12000)
        expect(date).to_have_value("2026-10-28")
        squares("complete")

        page.set_viewport_size({"width": 800, "height": 800})
        help_box = page.locator(".availability-help")
        help_box.locator("summary").hover()
        expect(help_box).to_have_attribute("open", "")
        expect(help_box.locator(".popover-panel")).to_be_in_viewport()
        fits("hover help")
        page.mouse.move(2, 2)
        expect(help_box).not_to_have_attribute("open", "")
        help_box.locator("summary").focus()
        expect(help_box).to_have_attribute("open", "")
        page.keyboard.press("Escape")
        expect(help_box).not_to_have_attribute("open", "")

        page.locator("#notesSummary").click()
        page.locator("#textInput").fill("Optional text still saves with this slide.")
        expect(page.locator(".note-dot")).to_be_visible()
        fits("text popover")
        page.keyboard.press("Escape")
        page.locator("#submitBtn").click()
        expect(page.locator("#toast")).to_have_text("Drop saved")
        patch = next(json.loads(body) for method, body in mutations if method == "PATCH")
        assert patch["text"] == "Optional text still saves with this slide."
        assert patch["availableStartingDate"] == "2026-10-28" and patch["targetServicePeriod"] == ""

        # Edit remains accessible with a long title; no new upload is created.
        page.get_by_role("button", name="Edit title", exact=True).click()
        long_title = "Hope " * 19
        page.locator("#composeAutoTitle input").fill(long_title)
        page.get_by_role("button", name="Save title", exact=True).click()
        expect(page.locator("#composeAutoTitle input")).to_have_value(long_title.strip())
        squares("long title")
        assert sum(method == "POST" for method, _ in mutations) == 1

        # Poll failures remain signaled without forcing a taller layout.
        row.update(titleStatus="error", title="", phase="Fixture extraction failed")
        expect(page.locator(".title-info summary")).to_have_text("!", timeout=12000)
        squares("error")
        page.locator(".title-info summary").click()
        expect(page.locator(".title-info .status")).to_contain_text("could not be read")
        page.keyboard.press("Escape")

        # Keyboard/touch access is available at the native app minimum width too.
        page.set_viewport_size({"width": 440, "height": 560})
        page.locator("#notesSummary").click()
        expect(page.locator(".notes-popover .popover-panel")).to_be_in_viewport()
        page.locator("#textInput").fill("Still editable")
        page.keyboard.press("Escape")

        # Verify actual animated landing into the relocated heading.
        page.set_viewport_size({"width": 800, "height": 800})
        page.emulate_media(reduced_motion="no-preference")
        page.locator("#newDropBtn").click()
        row.update(id="second-fixture", revision=1, titleStatus="queued", title="", published=False)
        page.locator("#fileInput").set_input_files({"name":"fixture.png","mimeType":"image/png","buffer":base64.b64decode(png)})
        expect(page.locator("#composeAutoTitle")).to_have_attribute("data-ai-state", "queued")
        page.evaluate("""() => {window.landings=[];const animate=Element.prototype.animate;
            Element.prototype.animate=function(frames,options){
                if(this.classList.contains('title-flight-word') && options?.duration===850){
                    window.landings.push({y:this.getBoundingClientRect().y,frames});
                }return animate.call(this,frames,options);};}""")
        row.update(titleStatus="complete", title="A Place of Hope", published=True)
        expect(page.locator("#composeAutoTitle")).to_have_attribute("data-ai-state", "revealing", timeout=12000)
        fits("title flight")
        expect(page.locator("#composeAutoTitle")).to_have_attribute("data-ai-state", "complete", timeout=20000)
        assert page.evaluate("window.landings.length") == 4
        # The final transform moves every word above its gathered slide position.
        assert page.evaluate(r"""window.landings.every(({frames}) => {
            const y=f=>Number(f.transform.match(/translate\([^,]+,([^p]+)px/)[1]);
            return y(frames[1]) < y(frames[0]);})""")

        page.wait_for_timeout(1400)
        output = ROOT / "test-results"
        output.mkdir(exist_ok=True)
        for size in (640, 800):
            page.set_viewport_size({"width":size,"height":size})
            fits(f"final/{size}")
            page.screenshot(path=str(output / f"desktop-{engine}-{size}.png"))
        assert not errors, errors
        assert not unexpected, unexpected
        browser.close()
        print(f"PASS {engine}: square geometry, slide size, Sunday controls, popovers, delayed title, edits, errors, upward animation; no live requests")


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "chromium")
