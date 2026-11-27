import contextlib
import json
import os
import re
import shutil
import socket
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest
import uvicorn

import server
from backend.schema import PlaylistConfig, save_playlist


FIXTURE_MEDIA_DIR = Path(__file__).resolve().parent / "fixtures" / "media"
VIEWPORTS = ((1440, 900), (1280, 800), (1024, 768), (900, 700))
ALL_VISUAL_EFFECTS = (
    "auto",
    "none",
    "ken_burns",
    "lyric_stage",
    "vinyl_spin",
    "flow_lyrics",
    "cyber_hud",
    "waveform_aura",
)
ALL_VISUAL_MODIFIERS = ("beat_pulse", "float_3d", "glitch", "retro_crt")


@dataclass
class RuntimeMonitor:
    console_errors: list = field(default_factory=list)
    page_errors: list = field(default_factory=list)
    request_failures: list = field(default_factory=list)
    http_errors: list = field(default_factory=list)
    allowed_http_rules: list = field(default_factory=list)
    allowed_failure_rules: list = field(default_factory=list)

    @contextlib.contextmanager
    def allow_http_error(self, url_substr: str, status: int | None = None):
        rule = (url_substr, status)
        self.allowed_http_rules.append(rule)
        try:
            yield
        finally:
            if rule in self.allowed_http_rules:
                self.allowed_http_rules.remove(rule)

    @contextlib.contextmanager
    def allow_request_failure(self, url_substr: str):
        self.allowed_failure_rules.append(url_substr)
        try:
            yield
        finally:
            if url_substr in self.allowed_failure_rules:
                self.allowed_failure_rules.remove(url_substr)

    def is_http_allowed(self, url: str, status: int) -> bool:
        for substr, allowed_status in self.allowed_http_rules:
            if substr in url and (allowed_status is None or allowed_status == status):
                return True
        return False

    def is_failure_allowed(self, url: str) -> bool:
        return any(substr in url for substr in self.allowed_failure_rules)

    def assert_clean(self):
        assert self.console_errors == [], self.console_errors
        assert self.page_errors == [], self.page_errors
        assert self.request_failures == [], self.request_failures
        assert self.http_errors == [], self.http_errors


def _launch_browser(playwright_instance):
    exe = os.environ.get("MRV_CHROME_EXECUTABLE")
    if exe:
        return playwright_instance.chromium.launch(headless=True, executable_path=exe)
    try:
        return playwright_instance.chromium.launch(headless=True, channel="chrome")
    except Exception:
        return playwright_instance.chromium.launch(headless=True)


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(autouse=True)
def _isolate_extra_server_state(seeded_playlist, monkeypatch):
    import backend.netease_audio as na_mod

    cfg_path = seeded_playlist / "music_source_config.json"
    monkeypatch.setattr(
        server,
        "get_music_source_status",
        lambda: na_mod.get_music_source_status(config_path=cfg_path),
    )
    monkeypatch.setattr(
        server,
        "save_music_source_config",
        lambda **kw: na_mod.save_music_source_config(**kw, config_path=cfg_path),
    )
    server._remotion_studio_proc = None
    server._remotion_render_proc = None
    server._remotion_render_cancelled = False
    yield
    server._remotion_studio_proc = None
    server._remotion_render_proc = None
    server._remotion_render_cancelled = False
    with server.task_lock:
        server.tasks_state["is_downloading"] = False
        server.tasks_state["is_rendering"] = False
        server.tasks_state["queue_count"] = 0
        server.tasks_state["current_song"] = ""
        server.tasks_state["logs"] = []
        server.tasks_state["progress_percent"] = 0


@pytest.fixture
def live_server_url(seeded_playlist):
    from fastapi.staticfiles import StaticFiles

    saved_cover_apps = [
        (r, r.app)
        for r in server.app.router.routes
        if getattr(r, "name", "") == "covers"
    ]
    srv = None
    t = None
    try:
        for r, _ in saved_cover_apps:
            r.app = StaticFiles(directory=str(seeded_playlist / "covers"))

        port = _free_port()
        config = uvicorn.Config(server.app, host="127.0.0.1", port=port, log_level="error")
        srv = uvicorn.Server(config)
        t = threading.Thread(target=srv.run, daemon=True)
        t.start()

        deadline = time.time() + 5.0
        ready = False
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    ready = True
                    break
            except OSError:
                time.sleep(0.05)
        if not ready:
            raise RuntimeError(f"Live server failed to start on 127.0.0.1:{port}")
        yield f"http://127.0.0.1:{port}"
    finally:
        if srv is not None:
            srv.should_exit = True
        if t is not None:
            t.join(timeout=3.0)
        for r, orig_app in saved_cover_apps:
            r.app = orig_app


@pytest.fixture
def browser_page(live_server_url):
    playwright_sync = pytest.importorskip("playwright.sync_api")
    runtime = RuntimeMonitor()

    with playwright_sync.sync_playwright() as p:
        browser = _launch_browser(p)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.route(
            "https://fonts.googleapis.com/**",
            lambda route: route.fulfill(status=200, content_type="text/css", body=""),
        )
        page.route(
            "https://fonts.gstatic.com/**",
            lambda route: route.fulfill(status=200, body=""),
        )

        def _on_console(msg):
            if msg.type != "error":
                return
            text = msg.text
            if text.startswith("Failed to load resource: "):
                loc_url = (msg.location or {}).get("url", "")
                if "the server responded with a status of " in text:
                    m = re.search(r"the server responded with a status of (\d+)", text)
                    if m and runtime.is_http_allowed(loc_url, int(m.group(1))):
                        return
                elif "net::ERR_" in text:
                    if runtime.is_failure_allowed(loc_url):
                        return
            runtime.console_errors.append(text)

        page.on("console", _on_console)
        page.on("pageerror", lambda err: runtime.page_errors.append(str(err)))

        def _on_request_failed(req):
            if req.failure == "net::ERR_ABORTED" and (
                (req.resource_type == "media" and "/api/media/" in req.url)
                or (req.resource_type in ("media", "fetch") and "/api/composition-media/" in req.url)
                or (req.resource_type == "fetch" and "/api/waveform/" in req.url)
            ):
                return
            if not runtime.is_failure_allowed(req.url):
                runtime.request_failures.append(
                    {"url": req.url, "method": req.method, "failure": req.failure}
                )

        def _on_response(resp):
            if resp.status >= 400 and not runtime.is_http_allowed(resp.url, resp.status):
                runtime.http_errors.append(
                    {
                        "status": resp.status,
                        "url": resp.url,
                        "type": resp.request.resource_type,
                    }
                )

        page.on("requestfailed", _on_request_failed)
        page.on("response", _on_response)
        try:
            yield page, live_server_url, runtime
        finally:
            context.close()
            browser.close()


def _assert_no_layout_overflow(
    page,
    required_testids=(),
    allow_vertical_scroll_testids=(),
):
    metrics = page.evaluate(
        """({ requiredTestids, allowScrollTestids }) => {
          const allowSet = new Set(allowScrollTestids);
          const brand = document.querySelector('[data-testid="brand-plate"]');
          const topbar = (brand && brand.closest('header, .topbar')) || document.querySelector('header, .topbar');
          const tbRect = topbar ? topbar.getBoundingClientRect() : { height: 0, left: 0 };

          const visibleImgs = Array.from(document.querySelectorAll('img')).filter(img => {
            if (!img.getAttribute('src')) return false;
            if (typeof img.checkVisibility === 'function' && !img.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
              return false;
            }
            let cur = img;
            while (cur && cur.nodeType === 1) {
              const st = window.getComputedStyle(cur);
              if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) {
                return false;
              }
              cur = cur.parentElement;
            }
            if (!img.complete || img.naturalWidth === 0) {
              return true;
            }
            const r = img.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const brokenImgs = visibleImgs.filter(img => !img.complete || img.naturalWidth === 0).map(i => i.src);

          const controlFailures = [];
          for (const tid of requiredTestids) {
            const el = document.querySelector(`[data-testid="${tid}"]`);
            if (!el) {
              controlFailures.push({ tid, reason: 'missing' });
              continue;
            }
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) {
              controlFailures.push({ tid, reason: 'hidden' });
              continue;
            }
            if (allowSet.has(tid)) {
              el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) {
              controlFailures.push({ tid, reason: 'too_small', width: r.width, height: r.height });
              continue;
            }
            if (r.left < -1 || r.right > window.innerWidth + 1) {
              controlFailures.push({ tid, reason: 'horizontal_oob', left: r.left, right: r.right, innerWidth: window.innerWidth });
              continue;
            }
            if (!allowSet.has(tid) && (r.top < -1 || r.bottom > window.innerHeight + 1)) {
              controlFailures.push({ tid, reason: 'vertical_oob', top: r.top, bottom: r.bottom, innerHeight: window.innerHeight });
              continue;
            }
            const cx = Math.max(0, Math.min(window.innerWidth - 1, r.left + r.width / 2));
            const cy = Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2));
            const hit = document.elementFromPoint(cx, cy);
            if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) {
              controlFailures.push({
                tid,
                reason: 'obstructed',
                hitTag: hit ? hit.tagName : null,
                hitTestId: hit ? hit.getAttribute('data-testid') : null,
              });
            }
          }

          return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            topbarHeight: tbRect.height,
            topbarLeft: tbRect.left,
            brokenImgs,
            controlFailures,
          };
        }""",
        {
            "requiredTestids": list(required_testids),
            "allowScrollTestids": list(allow_vertical_scroll_testids),
        },
    )
    assert metrics["scrollWidth"] <= metrics["innerWidth"] + 1, metrics
    assert metrics["topbarHeight"] <= 64, metrics
    assert metrics["topbarLeft"] >= -1, metrics
    assert metrics["brokenImgs"] == [], metrics
    assert metrics["controlFailures"] == [], metrics


def _assert_modal_unobstructed(page, modal_testid, control_testids=()):
    modal = page.get_by_test_id(modal_testid)
    modal.wait_for(state="visible", timeout=5000)
    box = modal.bounding_box()
    vp = page.viewport_size
    assert box is not None and vp is not None
    assert box["x"] >= -1 and box["y"] >= -1, box
    assert box["x"] + box["width"] <= vp["width"] + 1, (box, vp)
    assert box["y"] + box["height"] <= vp["height"] + 1, (box, vp)
    _assert_no_layout_overflow(page, required_testids=control_testids)


def _maybe_shot(page, name):
    out_dir = os.environ.get("MRV_SCREENSHOT_DIR")
    if out_dir:
        page.evaluate("() => document.fonts ? document.fonts.ready : Promise.resolve()")
        page.wait_for_timeout(150)
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(out_dir) / f"{name}.png"), full_page=False)


def _goto_studio(page, url):
    page.goto(url, wait_until="domcontentloaded")
    page.get_by_test_id("brand-plate").wait_for(state="visible", timeout=8000)
    page.wait_for_function(
        """() => Boolean(
          document.querySelector('[data-testid="deck-title"]') ||
          document.querySelector('[data-testid="empty-state"]')
        )""",
        timeout=8000,
    )


def _reload_and_hydrate(page, has_songs=True):
    with page.expect_response(
        lambda r: "/api/playlist" in r.url and r.request.method == "GET" and r.status == 200
    ):
        page.reload(wait_until="domcontentloaded")
    page.get_by_test_id("brand-plate").wait_for(state="visible", timeout=8000)
    target_tid = "deck-title" if has_songs else "empty-state"
    page.get_by_test_id(target_tid).wait_for(state="visible", timeout=8000)


def _expect_contains(locator, text, timeout=5000):
    from playwright.sync_api import expect

    expect(locator).to_contain_text(text, timeout=timeout)


def _expect_exact(locator, text, timeout=5000):
    from playwright.sync_api import expect

    expect(locator).to_have_text(text, timeout=timeout)


def _seed_sync_lyrics_media(seeded_playlist):
    video_src = FIXTURE_MEDIA_DIR / "project-review.mp4"
    shutil.copyfile(video_src, seeded_playlist / "raw" / "song_a.mp4")
    shutil.copyfile(video_src, seeded_playlist / "processed" / "song_a_norm.mp4")
    (seeded_playlist / "lyrics" / "song_a.json").write_text(
        json.dumps(
            {
                "lines": [
                    {"time": 0.5, "orig": "First line original", "trans": "第一行翻译"},
                    {"time": 2.2, "orig": "Second line original", "trans": "第二行翻译"},
                ],
                "has_translation": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    pl_path = seeded_playlist / "playlist.json"
    pl = json.loads(pl_path.read_text(encoding="utf-8"))
    pl["songs"][0]["end"] = "0:04.5"
    save_playlist(pl, pl_path)


def test_empty_playlist_and_add_track(browser_page, seeded_playlist):
    page, url, runtime = browser_page
    save_playlist(
        PlaylistConfig(output_sequence_name="Empty", songs=[]),
        seeded_playlist / "playlist.json",
    )

    _goto_studio(page, url)
    page.get_by_test_id("empty-state").wait_for(state="visible", timeout=5000)
    _assert_no_layout_overflow(
        page,
        required_testids=("brand-plate", "rack-intro", "empty-state", "empty-import-btn", "empty-add-btn"),
    )

    page.get_by_test_id("empty-add-btn").click()
    page.get_by_test_id("deck-title").wait_for(state="visible", timeout=5000)
    _expect_contains(page.get_by_test_id("deck-title"), "未命名曲目")
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'saved'",
        timeout=5000,
    )
    _assert_no_layout_overflow(page, required_testids=("rack-song-0", "deck-title"))

    _reload_and_hydrate(page, has_songs=True)
    page.get_by_test_id("rack-song-0").wait_for(state="visible", timeout=5000)
    runtime.assert_clean()


def test_missing_filter_excludes_track_with_only_processed_video(browser_page, seeded_playlist):
    page, url, runtime = browser_page
    (seeded_playlist / "raw" / "song_a.mp4").unlink()
    _goto_studio(page, url)
    _expect_contains(page.get_by_test_id("filter-miss"), "(1)")
    page.get_by_test_id("filter-miss").click()
    assert page.get_by_test_id("rack-song-0").count() == 0
    assert page.get_by_test_id("rack-song-1").is_visible()
    runtime.assert_clean()


def test_theme_persistence_and_shell_navigation(browser_page):
    page, url, runtime = browser_page
    _goto_studio(page, url)
    page.get_by_test_id("deck-title").wait_for(state="visible", timeout=5000)

    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "light"
    assert "MRV–02" in page.get_by_test_id("brand-plate").inner_text()
    assert page.get_by_test_id("spec-pill").is_visible()
    assert page.get_by_test_id("save-chip").get_attribute("data-state") == "saved"

    page.get_by_test_id("seq-name-input").fill("Daily Showcase Seq")
    page.get_by_test_id("seq-name-input").dispatch_event("change")
    assert page.get_by_test_id("save-chip").get_attribute("data-state") == "dirty"

    page.get_by_test_id("save-chip").click()
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'saved'",
        timeout=5000,
    )
    _assert_no_layout_overflow(
        page,
        required_testids=(
            "brand-plate",
            "seq-name-input",
            "save-chip",
            "spec-pill",
            "theme-toggle",
            "batch-menu-btn",
            "studio-btn",
            "export-btn",
            "track-rack",
            "filter-all",
            "filter-miss",
            "rack-intro",
            "rack-song-0",
            "rack-song-1",
            "add-track-btn",
            "tab-trim",
            "tab-source",
            "tab-stage",
        ),
    )
    _maybe_shot(page, "day_trim")

    page.get_by_test_id("theme-toggle").click()
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "dark"
    _assert_no_layout_overflow(page, required_testids=("brand-plate", "theme-toggle", "deck-title"))
    _maybe_shot(page, "night_trim")

    _reload_and_hydrate(page, has_songs=True)
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "dark"
    assert page.get_by_test_id("seq-name-input").input_value() == "Daily Showcase Seq"

    page.get_by_test_id("theme-toggle").click()
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "light"
    _reload_and_hydrate(page, has_songs=True)
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "light"

    with runtime.allow_http_error("/api/media/1", 404):
        page.get_by_test_id("rack-song-1").click()
        _expect_contains(page.get_by_test_id("deck-title"), "Song B")
        page.keyboard.press("ArrowDown")
        _expect_contains(page.get_by_test_id("deck-title"), "Song B")

        page.get_by_test_id("rack-song-0").click()
        _expect_contains(page.get_by_test_id("deck-title"), "Song A")
        page.keyboard.press("ArrowUp")
        _expect_contains(page.get_by_test_id("deck-title"), "Song A")

        page.keyboard.press("ArrowDown")
        _expect_contains(page.get_by_test_id("deck-title"), "Song B")
        page.keyboard.press("ArrowUp")
        _expect_contains(page.get_by_test_id("deck-title"), "Song A")

        page.get_by_test_id("seq-name-input").click()
        page.keyboard.press("ArrowDown")
        page.keyboard.press("2")
        _expect_contains(page.get_by_test_id("deck-title"), "Song A")
        assert page.get_by_test_id("lyrics-panel").is_visible()
        page.get_by_test_id("brand-plate").click()

        page.get_by_test_id("filter-miss").click()
        assert page.locator('[data-testid^="rack-song-"]').count() == 1
        page.get_by_test_id("filter-all").click()
        assert page.locator('[data-testid^="rack-song-"]').count() == 2

    page.get_by_test_id("add-track-btn").click()
    assert page.locator('[data-testid^="rack-song-"]').count() == 3
    _expect_contains(page.get_by_test_id("deck-title"), "未命名曲目")
    runtime.assert_clean()


def test_intro_auto_duration_and_global_transition(browser_page, seeded_playlist):
    page, url, runtime = browser_page
    _goto_studio(page, url)

    page.get_by_test_id("rack-intro").click()
    page.get_by_test_id("deck-title").wait_for(state="visible", timeout=5000)
    assert "INTRO" in page.get_by_test_id("deck-title").inner_text().upper()

    page.get_by_test_id("intro-enabled-switch").click()
    intro_text = page.get_by_test_id("intro-text-input")
    intro_text.fill("第一段开场白文字内容\n\n第二段开场白文字内容\n---\n第三段开场白文字内容")
    intro_text.dispatch_event("change")
    assert "3" in page.get_by_test_id("intro-page-badge").inner_text()

    intro_text.fill("第一段开场白文字内容\n\n第二段开场白文字内容")
    intro_text.dispatch_event("change")
    assert "2 PAGE" in page.get_by_test_id("intro-page-badge").inner_text().upper()

    page.get_by_test_id("intro-auto-dur-switch").click()
    dur_input = page.locator("main input[type='number']").first
    dur_input.wait_for(state="visible", timeout=3000)
    assert dur_input.is_enabled()
    page.get_by_test_id("intro-auto-dur-switch").click()
    assert not dur_input.is_enabled()

    intro_main = page.locator("main")
    intro_main.get_by_role("radio", name="IMAGE").click()
    bg_img_input = intro_main.get_by_placeholder("covers/intro_bg.jpg")
    bg_img_input.wait_for(state="visible", timeout=3000)
    bg_img_input.fill("covers/song_a.png")
    intro_main.get_by_role("radio", name="BLACK").click()
    intro_main.get_by_role("radio", name="BLUR TRK 01").click()
    assert intro_main.get_by_role("radio", name="BLUR TRK 01").get_attribute("aria-checked") == "true"

    page.get_by_test_id("global-transition-select").select_option("light_leak")
    page.get_by_role("slider", name="Video duration").press("ArrowRight")
    assert page.get_by_role("spinbutton", name="Video duration exact value").input_value() == "0.7"
    audio_fade = page.get_by_role("spinbutton", name="Audio crossfade exact value")
    audio_fade.fill("4.2")
    audio_fade.press("Enter")
    _assert_no_layout_overflow(
        page,
        required_testids=(
            "intro-enabled-switch",
            "intro-auto-dur-switch",
            "intro-text-input",
            "intro-page-badge",
            "global-transition-select",
            "intro-save-btn",
        ),
        allow_vertical_scroll_testids=("global-transition-select", "intro-save-btn"),
    )
    _maybe_shot(page, "day_intro")

    page.get_by_test_id("intro-save-btn").click()
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'saved'",
        timeout=5000,
    )

    _reload_and_hydrate(page, has_songs=True)
    page.get_by_test_id("rack-intro").click()
    page.get_by_test_id("global-transition-select").wait_for(state="visible", timeout=5000)
    assert page.get_by_test_id("global-transition-select").input_value() == "light_leak"
    assert "第二段开场白" in page.get_by_test_id("intro-text-input").input_value()
    assert page.locator("main").get_by_role("radio", name="BLUR TRK 01").get_attribute("aria-checked") == "true"
    persisted_intro = json.loads((seeded_playlist / "playlist.json").read_text(encoding="utf-8"))
    assert persisted_intro["intro"]["bg_mode"] == "blur_first_song"
    assert persisted_intro["transition"]["video_duration"] == 0.7
    assert persisted_intro["transition"]["audio_duration"] == 4.2
    runtime.assert_clean()


def test_monitor_multiclip_lyrics_sync_and_manual_copy(browser_page, seeded_playlist):
    page, url, runtime = browser_page
    _seed_sync_lyrics_media(seeded_playlist)

    _goto_studio(page, url)
    page.get_by_test_id("deck-title").wait_for(state="visible", timeout=5000)

    video = page.get_by_test_id("monitor-video")
    assert video.get_attribute("controls") is None
    assert page.get_by_test_id("meter-strip").is_visible()
    page.wait_for_function(
        """() => {
          const v = document.querySelector('[data-testid="monitor-video"]');
          return v && v.readyState >= 1 && v.duration >= 3.0;
        }""",
        timeout=6000,
    )

    page.wait_for_function(
        """() => {
          const waveform = document.querySelector('[data-testid="tape-waveform"]');
          return waveform?.dataset.state === 'ready' && waveform.querySelector('path')?.getAttribute('d')?.length > 100;
        }""",
        timeout=6000,
    )
    seek_keycap = page.get_by_test_id("transport-seek-keycap")
    _expect_contains(seek_keycap, "0.5 s")
    page.keyboard.down("Shift")
    _expect_contains(seek_keycap, "2 s")
    page.keyboard.up("Shift")
    _expect_contains(seek_keycap, "0.5 s")
    _maybe_shot(page, "day_tape_waveform")

    row0 = page.get_by_test_id("lyric-row-0")
    row1 = page.get_by_test_id("lyric-row-1")
    assert "First line original" in row0.inner_text()
    assert "第一行翻译" in row0.inner_text()
    assert "Second line original" in row1.inner_text()
    assert "第二行翻译" in row1.inner_text()

    page.evaluate(
        """(t) => {
          const v = document.querySelector('[data-testid="monitor-video"]');
          v.currentTime = t;
          v.dispatchEvent(new Event('timeupdate'));
        }""",
        0.1,
    )
    page.wait_for_timeout(80)
    assert row0.get_attribute("data-active") == "false"
    assert row1.get_attribute("data-active") == "false"

    page.evaluate(
        """(t) => {
          const v = document.querySelector('[data-testid="monitor-video"]');
          v.currentTime = t;
          v.dispatchEvent(new Event('timeupdate'));
        }""",
        0.8,
    )
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"lyric-row-0\"]')?.getAttribute('data-active') === 'true'",
        timeout=3000,
    )
    assert row1.get_attribute("data-active") == "false"

    page.evaluate(
        """(t) => {
          const v = document.querySelector('[data-testid="monitor-video"]');
          v.currentTime = t;
          v.dispatchEvent(new Event('timeupdate'));
        }""",
        2.6,
    )
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"lyric-row-1\"]')?.getAttribute('data-active') === 'true'",
        timeout=3000,
    )
    assert row0.get_attribute("data-active") == "false"

    row0.click()
    page.wait_for_timeout(120)
    seeked_t = page.evaluate("() => document.querySelector('[data-testid=\"monitor-video\"]').currentTime")
    assert abs(seeked_t - 0.5) < 0.45

    page.evaluate(
        """(t) => {
          const v = document.querySelector('[data-testid="monitor-video"]');
          v.currentTime = t;
          v.dispatchEvent(new Event('timeupdate'));
        }""",
        1.7,
    )
    page.wait_for_timeout(60)
    row0.get_by_test_id("lyrics-align-btn").click()
    _expect_contains(page.get_by_test_id("lyrics-offset-readout"), "+1.2")

    page.get_by_test_id("lyrics-offset-minus").click()
    _expect_contains(page.get_by_test_id("lyrics-offset-readout"), "+1.0")
    page.get_by_test_id("lyrics-offset-reset").click()
    _expect_contains(page.get_by_test_id("lyrics-offset-readout"), "0")
    offset_control = page.get_by_role("slider", name="Lyrics offset")
    offset_control.press("ArrowRight")
    _expect_contains(page.get_by_test_id("lyrics-offset-readout"), "+0.1")
    offset_control.dblclick()
    page.get_by_test_id("lyrics-offset-plus").click()
    _expect_contains(page.get_by_test_id("lyrics-offset-readout"), "+0.2")

    page.route(
        "**/api/lyrics/0",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                {
                    "lines": [
                        {"time": 0.5, "orig": "Fetched Line 1", "trans": "拉取译文1"},
                        {"time": 2.2, "orig": "Second line original", "trans": "第二行翻译"},
                    ],
                    "has_translation": True,
                }
            ),
        )
        if route.request.method == "POST"
        else route.continue_(),
    )
    page.get_by_test_id("lyrics-fetch-btn").click()
    page.wait_for_function(
        "() => (document.querySelector('[data-testid=\"lyric-row-0\"]')?.innerText || '').includes('Fetched Line 1')",
        timeout=3000,
    )
    page.unroute("**/api/lyrics/0")

    ly_box = page.get_by_test_id("lyrics-panel").bounding_box()
    rs_box = page.get_by_test_id("reason-panel").bounding_box()
    sp_box = page.get_by_test_id("side-splitter").bounding_box()
    assert ly_box is not None and rs_box is not None and sp_box is not None
    page.mouse.move(sp_box["x"] + sp_box["width"] / 2, sp_box["y"] + sp_box["height"] / 2)
    page.mouse.down()
    page.mouse.move(sp_box["x"] + sp_box["width"] / 2, sp_box["y"] - 80)
    page.mouse.up()
    page.wait_for_timeout(100)
    ly_after = page.get_by_test_id("lyrics-panel").bounding_box()
    assert ly_after is not None and ly_after["height"] < ly_box["height"] - 40
    page.get_by_test_id("side-splitter").dblclick()
    page.wait_for_timeout(100)
    ly_reset = page.get_by_test_id("lyrics-panel").bounding_box()
    rs_reset = page.get_by_test_id("reason-panel").bounding_box()
    assert ly_reset is not None and rs_reset is not None
    assert abs(ly_reset["height"] - rs_reset["height"]) <= 8

    del_btn = page.get_by_test_id("del-clip-btn")
    if del_btn.is_enabled():
        del_btn.click()
        assert page.get_by_test_id("clip-pill-0").is_visible()

    page.get_by_test_id("add-clip-btn").click()
    page.get_by_test_id("clip-pill-1").wait_for(state="visible", timeout=3000)
    page.get_by_test_id("clip-pill-0").click()
    assert page.get_by_test_id("save-chip").get_attribute("data-state") == "dirty"

    in_handle = page.get_by_test_id("scrubber-handle-in").bounding_box()
    assert in_handle is not None
    page.mouse.move(in_handle["x"] + in_handle["width"] / 2, in_handle["y"] + in_handle["height"] / 2)
    page.mouse.down()
    page.mouse.move(in_handle["x"] - 18, in_handle["y"] + in_handle["height"] / 2)
    page.mouse.up()

    io_in = page.get_by_test_id("io-in-box")
    io_out = page.get_by_test_id("io-out-box")
    io_in.get_by_role("button", name="+0.1s", exact=True).click()
    io_out.get_by_role("button", name="-0.1s", exact=True).click()
    page.get_by_test_id("transport-loop").click()
    page.get_by_test_id("transport-jump-in").click()
    page.get_by_test_id("transport-jump-out").click()
    page.get_by_test_id("transport-play").click()
    page.get_by_test_id("transport-play").click()

    page.get_by_test_id("reason-mode-auto").click()
    page.get_by_test_id("reason-mode-manual").click()
    reason_box = page.get_by_test_id("reason-textarea")
    reason_box.fill("First point\n\nSecond point\n\nThird point")
    reason_box.dispatch_event("change")
    page.get_by_test_id("timing-row-2").wait_for(state="visible", timeout=3000)

    reason_box.fill("First point\n\nSecond point")
    reason_box.dispatch_event("change")
    assert page.get_by_test_id("timing-row-2").count() == 0

    page.evaluate(
        """(t) => {
          const v = document.querySelector('[data-testid="monitor-video"]');
          v.currentTime = t;
          v.dispatchEvent(new Event('timeupdate'));
        }""",
        1.8,
    )
    page.wait_for_timeout(80)
    page.get_by_test_id("timing-row-1").get_by_role("button", name="打点").click()

    page.get_by_test_id("apply-trim-save-btn").click()
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'saved'",
        timeout=5000,
    )

    _reload_and_hydrate(page, has_songs=True)
    page.get_by_test_id("clip-pill-1").wait_for(state="visible", timeout=3000)
    _expect_contains(page.get_by_test_id("lyrics-offset-readout"), "+0.2")
    assert page.get_by_test_id("reason-textarea").input_value() == "First point\n\nSecond point"

    persisted = json.loads((seeded_playlist / "playlist.json").read_text(encoding="utf-8"))
    assert len(persisted["songs"][0]["clips"]) == 2
    clip0 = persisted["songs"][0]["clips"][0]
    m, s = clip0["start"].split(":")
    clip_start = int(m) * 60 + float(s)
    assert abs(clip0["reason_timings"][1] - max(0.0, 1.8 - clip_start)) < 0.3

    before_in = page.get_by_test_id("io-in-box").locator(".io-readout").inner_text()
    before_out = page.get_by_test_id("io-out-box").locator(".io-readout").inner_text()
    page.get_by_test_id("reason-textarea").click()
    page.keyboard.press("i")
    page.keyboard.press("o")
    page.keyboard.press("2")
    assert page.get_by_test_id("reason-textarea").is_visible()
    assert page.get_by_test_id("io-in-box").locator(".io-readout").inner_text() == before_in
    assert page.get_by_test_id("io-out-box").locator(".io-readout").inner_text() == before_out
    page.get_by_test_id("brand-plate").click()

    page.evaluate(
        """(t) => {
          const v = document.querySelector('[data-testid="monitor-video"]');
          v.currentTime = t;
          v.dispatchEvent(new Event('timeupdate'));
        }""",
        1.5,
    )
    page.wait_for_timeout(60)
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(60)
    t_right = page.evaluate("() => document.querySelector('[data-testid=\"monitor-video\"]').currentTime")
    assert abs(t_right - 2.0) < 0.3
    page.keyboard.press("ArrowLeft")
    page.wait_for_timeout(60)
    t_left = page.evaluate("() => document.querySelector('[data-testid=\"monitor-video\"]').currentTime")
    assert abs(t_left - 1.5) < 0.3
    page.keyboard.press("i")
    _expect_contains(page.get_by_test_id("io-in-box").locator(".io-readout"), "0:01.")

    page.evaluate(
        """(t) => {
          const v = document.querySelector('[data-testid="monitor-video"]');
          v.currentTime = t;
          v.dispatchEvent(new Event('timeupdate'));
        }""",
        3.6,
    )
    page.wait_for_timeout(60)
    page.keyboard.press("o")
    _expect_contains(page.get_by_test_id("io-out-box").locator(".io-readout"), "0:03.6")

    page.get_by_test_id("del-clip-btn").click()
    assert page.get_by_test_id("clip-pill-1").count() == 0
    page.get_by_test_id("apply-trim-save-btn").click()
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'saved'",
        timeout=5000,
    )
    collapsed = json.loads((seeded_playlist / "playlist.json").read_text(encoding="utf-8"))
    assert collapsed["songs"][0]["clips"] == []
    runtime.assert_clean()


def test_source_matrix_stage_fx_modals_and_escape(browser_page, seeded_playlist):
    page, url, runtime = browser_page
    candidates_payload = {
        "status": "ok",
        "candidates": [
            {
                "id": "BV1abc",
                "title": "Official Live MV",
                "uploader": "Channel X",
                "duration_str": "3:45",
                "url": "https://www.bilibili.com/video/BV1abc",
                "thumbnail": "",
                "platform": "bilibili",
            }
        ],
    }
    page.route(
        "**/api/candidates*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(candidates_payload),
        ),
    )
    page.route(
        "**/api/bilibili/qr/generate",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"qrcode_key": "qr_key_1", "url": "https://example.invalid/qr"}),
        ),
    )
    page.route(
        "**/api/bilibili/qr/poll*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"status": "waiting", "message": "waiting"}),
        ),
    )

    _goto_studio(page, url)
    page.get_by_test_id("deck-title").wait_for(state="visible", timeout=5000)

    page.get_by_test_id("tab-source").click()
    page.get_by_test_id("cand-bay").wait_for(state="visible", timeout=5000)
    page.get_by_test_id("source-bay").wait_for(state="visible", timeout=5000)
    cand_box = page.get_by_test_id("cand-bay").bounding_box()
    src_box = page.get_by_test_id("source-bay").bounding_box()
    assert cand_box is not None and src_box is not None and src_box["y"] > cand_box["y"]

    if page.get_by_test_id("cand-switch-btn").is_visible():
        page.get_by_test_id("cand-switch-btn").click()
    page.get_by_test_id("cand-search-input").fill("Song A live")
    page.get_by_test_id("cand-search-btn").click()
    page.get_by_test_id("cand-card-0").wait_for(state="visible", timeout=5000)
    page.get_by_test_id("cand-card-0").click()

    page.get_by_test_id("locked-source-stage").wait_for(state="visible", timeout=5000)
    download_video = page.get_by_role("button", name="↓ 下载视频", exact=True)
    assert download_video.count() == 1
    assert page.get_by_test_id("locked-source-stage").get_by_role("button", name="↓ 下载视频", exact=True).is_visible()
    ext_link = page.get_by_test_id("cand-bay").locator("a[target='_blank']").first
    assert ext_link.get_attribute("href") == "https://www.bilibili.com/video/BV1abc"
    _assert_no_layout_overflow(
        page,
        required_testids=("source-mode-video_url", "source-mode-netease_cover", "source-mode-local", "cand-switch-btn"),
    )
    _maybe_shot(page, "day_source_focus")

    page.get_by_test_id("cand-switch-btn").click()
    page.get_by_test_id("cand-card-0").wait_for(state="visible", timeout=3000)

    page.get_by_test_id("source-mode-netease_cover").click()
    page.get_by_test_id("netease-synth-card").wait_for(state="visible", timeout=5000)
    _assert_no_layout_overflow(page, required_testids=("netease-synth-card", "source-mode-netease_cover"))
    _maybe_shot(page, "day_source_netease")

    with page.expect_response(
        lambda r: "/api/playlist" in r.url and r.request.method == "POST" and r.status == 200
    ):
        page.get_by_test_id("source-mode-local").click()
    with page.expect_response(
        lambda r: "/api/upload_media/0" in r.url and r.status == 200
    ):
        page.get_by_test_id("local-upload-input").set_input_files(
            str(FIXTURE_MEDIA_DIR / "color-video.mp4")
        )
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'saved'",
        timeout=5000,
    )
    uploaded = json.loads((seeded_playlist / "playlist.json").read_text(encoding="utf-8"))
    assert uploaded["songs"][0]["media_source"] == "local"
    assert "_local.mp4" in uploaded["songs"][0]["file_path"]

    page.get_by_test_id("tab-stage").click()
    page.get_by_test_id("meta-title-input").wait_for(state="visible", timeout=5000)
    assert page.get_by_test_id("meta-start-input").input_value() == "0:01.0"
    assert page.get_by_test_id("meta-end-input").input_value() == "0:05.0"

    asset_diagnostics = page.locator(".asset-diagnostics")
    asset_summary = asset_diagnostics.locator("summary")
    assert not asset_diagnostics.evaluate("(details) => details.open")
    asset_summary.click()
    assert asset_diagnostics.get_by_text("RAW MV", exact=True).is_visible()
    asset_summary.click()

    page.get_by_test_id("meta-title-input").fill("Song A Remastered")
    page.get_by_test_id("meta-artist-input").fill("Artist A Prime")
    page.get_by_test_id("meta-album-input").fill("Album Gold")
    page.get_by_test_id("meta-start-input").fill("0:01.5")
    page.get_by_test_id("meta-end-input").fill("0:04.5")

    page.get_by_test_id("fx-transition-select").select_option("whip_pan")
    visual_select = page.get_by_test_id("fx-visual-select")
    available_effects = visual_select.evaluate(
        "el => Array.from(el.options).map(o => o.value)"
    )
    for fx in ALL_VISUAL_EFFECTS:
        assert fx in available_effects, (fx, available_effects)
        visual_select.select_option(fx)
        assert visual_select.input_value() == fx
    visual_select.select_option("cyber_hud")

    for mod in ALL_VISUAL_MODIFIERS:
        page.get_by_test_id(f"fx-mod-{mod}").click()
    page.get_by_test_id("fx-lyrics-switch").click()
    page.get_by_test_id("fx-shadow-strong").click()
    _assert_no_layout_overflow(
        page,
        required_testids=(
            "meta-title-input",
            "fx-transition-select",
            "fx-visual-select",
            "fx-mod-beat_pulse",
            "fx-shadow-strong",
            "meta-save-btn",
        ),
        allow_vertical_scroll_testids=("fx-transition-select", "fx-visual-select", "fx-mod-beat_pulse", "fx-shadow-strong", "meta-save-btn"),
    )
    page.get_by_role("button", name="FX Preview", exact=True).click()
    page.get_by_text("FX Preview", exact=True).wait_for(state="visible")
    page.locator(".song-effect-preview video").first.wait_for(state="visible")
    page.get_by_test_id("transport-play").click()
    _expect_contains(page.get_by_test_id("transport-play"), "Pause")
    page.get_by_test_id("transport-play").click()
    _expect_contains(page.get_by_test_id("transport-play"), "Play")
    page.get_by_role("button", name="Source Preview", exact=True).click()
    _maybe_shot(page, "day_stage")

    page.get_by_test_id("meta-save-btn").click()
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'saved'",
        timeout=5000,
    )

    _reload_and_hydrate(page, has_songs=True)
    page.get_by_test_id("tab-stage").click()
    assert page.get_by_test_id("meta-title-input").input_value() == "Song A Remastered"
    assert page.get_by_test_id("fx-transition-select").input_value() == "whip_pan"
    assert page.get_by_test_id("fx-visual-select").input_value() == "cyber_hud"
    persisted = json.loads((seeded_playlist / "playlist.json").read_text(encoding="utf-8"))
    s0 = persisted["songs"][0]
    assert set(s0["visual_modifiers"]) == set(ALL_VISUAL_MODIFIERS)
    assert s0["lyrics_enabled"] is False
    assert s0["shadow_boost"] == "strong"

    page.get_by_test_id("tab-trim").click()
    assert page.get_by_test_id("meta-start-input").count() == 0
    page.get_by_test_id("tab-stage").click()
    page.get_by_test_id("fx-visual-select").select_option("waveform_aura")
    page.get_by_test_id("meta-save-btn").click()
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'saved'",
        timeout=5000,
    )

    page.get_by_test_id("batch-menu-btn").click()
    menu = page.get_by_test_id("batch-menu-panel")
    menu.wait_for(state="visible", timeout=3000)
    menu.get_by_role("button", name=re.compile(r"导入网易云|网易云歌单")).click()
    _assert_modal_unobstructed(page, "modal-netease-import", ("modal-close-btn",))
    modal_input = page.get_by_test_id("modal-netease-import").locator("input").first
    modal_input.wait_for(state="visible", timeout=3000)
    modal_input.click()
    page.keyboard.press("1")
    page.keyboard.press("2")
    assert modal_input.input_value() == "12"
    assert page.get_by_test_id("modal-netease-import").is_visible()
    assert page.get_by_test_id("fx-visual-select").is_visible()
    page.keyboard.press("Escape")
    page.get_by_test_id("modal-netease-import").wait_for(state="hidden", timeout=3000)

    page.get_by_test_id("batch-menu-btn").click()
    menu.get_by_role("button", name=re.compile(r"B站|Bilibili")).click()
    _assert_modal_unobstructed(page, "modal-bili-auth", ("modal-close-btn",))
    page.get_by_test_id("modal-close-btn").click()
    page.get_by_test_id("modal-bili-auth").wait_for(state="hidden", timeout=3000)

    page.get_by_test_id("batch-menu-btn").click()
    menu.get_by_role("button", name=re.compile(r"网易云音源|音源设置")).click()
    _assert_modal_unobstructed(page, "modal-netease-audio", ("modal-close-btn",))
    _maybe_shot(page, "day_batch_modal")
    page.keyboard.press("Escape")
    page.get_by_test_id("modal-netease-audio").wait_for(state="hidden", timeout=3000)

    page.get_by_test_id("batch-menu-btn").click()
    menu.wait_for(state="visible", timeout=3000)
    page.keyboard.press("Escape")
    menu.wait_for(state="hidden", timeout=3000)

    server.log_task("E2E console test log")
    page.get_by_test_id("console-toggle-btn").click()
    page.get_by_test_id("console-drawer").wait_for(state="visible", timeout=3000)
    page.wait_for_function(
        "() => (document.querySelector('[data-testid=\"console-drawer\"]')?.innerText || '').includes('E2E console test log')",
        timeout=6000,
    )
    _assert_no_layout_overflow(page, required_testids=("console-drawer", "console-clear-btn"))
    _maybe_shot(page, "day_console_drawer")
    with page.expect_response(
        lambda r: "/api/logs/clear" in r.url and r.request.method == "POST" and r.status == 200
    ):
        page.get_by_test_id("console-clear-btn").click()
    page.wait_for_function(
        "() => (document.querySelector('[data-testid=\"console-drawer\"]')?.innerText || '').includes('NO LOGS YET')",
        timeout=3000,
    )
    assert page.get_by_test_id("console-clear-btn").count() == 0
    assert server.tasks_state["logs"] == []
    page.get_by_test_id("console-toggle-btn").click()

    page.get_by_test_id("add-track-btn").click()
    assert page.locator('[data-testid^="rack-song-"]').count() == 3
    page.get_by_test_id("tab-stage").click()
    page.once("dialog", lambda d: d.accept())
    page.get_by_test_id("meta-delete-btn").click()
    page.wait_for_function(
        "() => document.querySelectorAll('[data-testid^=\"rack-song-\"]').length === 2",
        timeout=5000,
    )
    runtime.assert_clean()


def test_save_failure_preservation_and_retry_flows(browser_page, seeded_playlist):
    page, url, runtime = browser_page
    _goto_studio(page, url)
    page.get_by_test_id("deck-title").wait_for(state="visible", timeout=5000)

    def _fail_playlist(route):
        if route.request.method == "POST":
            route.fulfill(
                status=500,
                content_type="application/json",
                body=json.dumps({"detail": "disk full"}),
            )
        else:
            route.continue_()

    page.route("**/api/playlist", _fail_playlist)
    with runtime.allow_http_error("/api/playlist", 500):
        page.get_by_test_id("reason-textarea").fill("Unsaved Pending Copy")
        page.get_by_test_id("reason-textarea").dispatch_event("change")
        page.get_by_test_id("io-in-box").get_by_role("button", name="+0.1s", exact=True).click()
        _expect_exact(page.get_by_test_id("io-in-box").locator(".io-readout"), "0:01.1")
        page.get_by_test_id("tab-stage").click()
        page.get_by_test_id("fx-visual-select").select_option("waveform_aura")
        page.get_by_test_id("tab-trim").click()
        with page.expect_response(
            lambda r: "/api/playlist" in r.url and r.request.method == "POST" and r.status == 500
        ):
            page.get_by_test_id("apply-trim-save-btn").click()
        page.wait_for_function(
            "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'error'",
            timeout=5000,
        )
        page.get_by_test_id("seq-name-input").fill("Resilient Seq")
        page.get_by_test_id("seq-name-input").dispatch_event("change")
        with page.expect_response(
            lambda r: "/api/playlist" in r.url and r.request.method == "POST" and r.status == 500
        ):
            page.get_by_test_id("seq-name-input").press("Enter")
        page.wait_for_function(
            "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'error'",
            timeout=5000,
        )
        assert page.get_by_test_id("save-chip").get_attribute("data-state") == "error"
        assert page.get_by_test_id("save-retry-btn").is_visible()
        assert page.get_by_test_id("toast-notice").is_visible()
        assert page.get_by_test_id("reason-textarea").input_value() == "Unsaved Pending Copy"
        assert page.get_by_test_id("seq-name-input").input_value() == "Resilient Seq"
        _expect_exact(page.get_by_test_id("io-in-box").locator(".io-readout"), "0:01.1")
        page.unroute("**/api/playlist")
    page.get_by_test_id("save-retry-btn").click()
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'saved'",
        timeout=5000,
    )

    _reload_and_hydrate(page, has_songs=True)
    assert page.get_by_test_id("seq-name-input").input_value() == "Resilient Seq"
    assert page.get_by_test_id("reason-textarea").input_value() == "Unsaved Pending Copy"
    _expect_exact(page.get_by_test_id("io-in-box").locator(".io-readout"), "0:01.1")
    page.get_by_test_id("tab-stage").click()
    assert page.get_by_test_id("fx-visual-select").input_value() == "waveform_aura"
    page.get_by_test_id("tab-trim").click()

    studio_calls = 0

    def _spy_studio(route):
        nonlocal studio_calls
        studio_calls += 1
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"status": "started", "url": "http://127.0.0.1:3022"}),
        )

    page.route("**/api/remotion/studio", _spy_studio)
    page.route("**/api/playlist", _fail_playlist)
    page.get_by_test_id("reason-textarea").fill("Pending Studio Gate Copy")
    page.get_by_test_id("reason-textarea").dispatch_event("change")
    with runtime.allow_http_error("/api/playlist", 500):
        with page.expect_response(
            lambda r: "/api/playlist" in r.url and r.request.method == "POST" and r.status == 500
        ):
            page.get_by_test_id("studio-btn").click()
        page.wait_for_function(
            "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'error'",
            timeout=5000,
        )
        page.unroute("**/api/playlist")
    assert studio_calls == 0
    assert page.get_by_test_id("reason-textarea").input_value() == "Pending Studio Gate Copy"
    _expect_exact(page.get_by_test_id("io-in-box").locator(".io-readout"), "0:01.1")
    page.unroute("**/api/remotion/studio")

    page.get_by_test_id("save-retry-btn").click()
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'saved'",
        timeout=5000,
    )

    render_calls = 0

    def _spy_render(route):
        nonlocal render_calls
        render_calls += 1
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"status": "started", "message": "started"}),
        )

    page.route("**/api/remotion/render", _spy_render)
    page.route("**/api/playlist", _fail_playlist)
    page.get_by_test_id("reason-textarea").fill("Pending Export Gate Copy")
    page.get_by_test_id("reason-textarea").dispatch_event("change")
    page.get_by_test_id("io-out-box").get_by_role("button", name="-0.1s", exact=True).click()
    _expect_exact(page.get_by_test_id("io-out-box").locator(".io-readout"), "0:04.9")
    with runtime.allow_http_error("/api/playlist", 500):
        with page.expect_response(
            lambda r: "/api/playlist" in r.url and r.request.method == "POST" and r.status == 500
        ):
            page.get_by_test_id("export-btn").click()
        page.wait_for_function(
            "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'error'",
            timeout=5000,
        )
        page.unroute("**/api/playlist")
    assert render_calls == 0
    assert page.get_by_test_id("reason-textarea").input_value() == "Pending Export Gate Copy"
    _expect_exact(page.get_by_test_id("io-out-box").locator(".io-readout"), "0:04.9")

    status_step = {"n": 0}

    def _poll_transition(route):
        status_step["n"] += 1
        busy = status_step["n"] == 1
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                {
                    "is_downloading": busy,
                    "is_rendering": False,
                    "queue_count": 0,
                    "current_song": "Song A" if busy else "",
                    "logs": ["[12:00:00] background step"],
                    "progress_percent": 50 if busy else 100,
                }
            ),
        )

    page.route("**/api/status", _poll_transition)
    deadline = time.time() + 6.0
    while status_step["n"] < 2 and time.time() < deadline:
        page.wait_for_timeout(150)
    assert status_step["n"] >= 2, status_step
    page.wait_for_timeout(200)
    assert page.get_by_test_id("reason-textarea").input_value() == "Pending Export Gate Copy"
    _expect_exact(page.get_by_test_id("io-out-box").locator(".io-readout"), "0:04.9")
    page.unroute("**/api/status")
    page.unroute("**/api/remotion/render")

    page.route(
        "**/api/playlist",
        lambda route: route.abort() if route.request.method == "POST" else route.continue_(),
    )
    with runtime.allow_request_failure("/api/playlist"):
        with page.expect_event(
            "requestfailed",
            lambda req: "/api/playlist" in req.url and req.method == "POST",
        ):
            page.get_by_test_id("save-retry-btn").click()
        page.wait_for_function(
            "() => { const el = document.querySelector('[data-testid=\"save-chip\"]'); return el?.getAttribute('data-state') === 'error' && !el.innerText.includes('SAVING'); }",
            timeout=5000,
        )
        page.unroute("**/api/playlist")
    assert page.get_by_test_id("reason-textarea").input_value() == "Pending Export Gate Copy"
    _expect_exact(page.get_by_test_id("io-out-box").locator(".io-readout"), "0:04.9")

    page.get_by_test_id("save-retry-btn").click()
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\"save-chip\"]')?.getAttribute('data-state') === 'saved'",
        timeout=5000,
    )
    _reload_and_hydrate(page, has_songs=True)
    assert page.get_by_test_id("reason-textarea").input_value() == "Pending Export Gate Copy"
    _expect_exact(page.get_by_test_id("io-in-box").locator(".io-readout"), "0:01.1")
    _expect_exact(page.get_by_test_id("io-out-box").locator(".io-readout"), "0:04.9")
    persisted = json.loads((seeded_playlist / "playlist.json").read_text(encoding="utf-8"))
    assert persisted["songs"][0]["start"] == "0:01.1"
    assert persisted["songs"][0]["end"] == "0:04.9"
    runtime.assert_clean()


def test_studio_export_cancel_controlled_api_flows(browser_page):
    page, url, runtime = browser_page
    page.add_init_script(
        "window.__openedUrls = []; window.open = (u) => { window.__openedUrls.push(u); return {}; };"
    )
    _goto_studio(page, url)
    page.get_by_test_id("deck-title").wait_for(state="visible", timeout=5000)

    page.get_by_test_id("reason-textarea").fill("Studio Verified Copy")
    page.get_by_test_id("reason-textarea").dispatch_event("change")

    page.route(
        "**/api/remotion/studio",
        lambda route: route.fulfill(
            status=500,
            content_type="application/json",
            body=json.dumps({"message": "studio failed", "detail": "studio failed"}),
        ),
    )
    with runtime.allow_http_error("/api/remotion/studio", 500):
        with page.expect_response(
            lambda r: "/api/remotion/studio" in r.url and r.status == 500
        ):
            page.get_by_test_id("studio-btn").click()
        page.wait_for_function(
            "() => (document.querySelector('[data-testid=\"toast-notice\"]')?.innerText || '').includes('studio failed')",
            timeout=5000,
        )
    assert page.get_by_test_id("save-chip").get_attribute("data-state") == "saved"
    assert page.get_by_test_id("studio-btn").is_enabled()
    assert page.evaluate("window.__openedUrls") == []
    page.unroute("**/api/remotion/studio")

    page.route(
        "**/api/remotion/studio",
        lambda route: route.fulfill(
            status=504,
            content_type="application/json",
            body=json.dumps({"message": "studio timeout", "detail": "studio timeout"}),
        ),
    )
    with runtime.allow_http_error("/api/remotion/studio", 504):
        with page.expect_response(
            lambda r: "/api/remotion/studio" in r.url and r.status == 504
        ):
            page.get_by_test_id("studio-btn").click()
        page.wait_for_function(
            "() => (document.querySelector('[data-testid=\"toast-notice\"]')?.innerText || '').includes('studio timeout')",
            timeout=5000,
        )
    assert page.get_by_test_id("studio-btn").is_enabled()
    assert page.evaluate("window.__openedUrls") == []
    page.unroute("**/api/remotion/studio")

    page.route(
        "**/api/remotion/studio",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"status": "started", "url": "http://127.0.0.1:3022"}),
        ),
    )
    page.route("http://127.0.0.1:3022/**", lambda route: route.fulfill(body="Remotion Studio", content_type="text/html"))
    with page.expect_response(
        lambda r: "/api/remotion/studio" in r.url and r.status == 200
    ):
        page.get_by_test_id("studio-btn").click()
    frame = page.locator('iframe[title="Remotion Studio"]')
    frame.wait_for(state="visible", timeout=5000)
    assert frame.get_attribute("src") == "http://127.0.0.1:3022"
    assert page.evaluate("window.__openedUrls") == []
    page.get_by_role("button", name="Back to Workstation").click()
    page.wait_for_function(
        "() => (document.querySelector('[data-testid=\"toast-notice\"]')?.innerText || '').includes('Remotion Studio')",
        timeout=5000,
    )
    page.unroute("http://127.0.0.1:3022/**")
    page.unroute("**/api/remotion/studio")

    page.route(
        "**/api/remotion/render",
        lambda route: route.fulfill(
            status=400,
            content_type="application/json",
            body=json.dumps({"message": "当前已有任务在进行中", "detail": "busy"}),
        ),
    )
    with runtime.allow_http_error("/api/remotion/render", 400):
        with page.expect_response(
            lambda r: "/api/remotion/render" in r.url and r.status == 400
        ):
            page.get_by_test_id("export-btn").click()
        page.wait_for_function(
            "() => (document.querySelector('[data-testid=\"toast-notice\"]')?.innerText || '').includes('busy')",
            timeout=5000,
        )
    page.unroute("**/api/remotion/render")

    render_payloads = []

    def _mock_render_start(route):
        render_payloads.append(route.request.post_data_json)
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"status": "started", "message": "已在后台启动 Remotion 全片渲染"}),
        )

    poll_state = {"step": 0}

    def _mock_render_status(route):
        poll_state["step"] += 1
        step = poll_state["step"]
        if step <= 2:
            body = {
                "is_downloading": False,
                "is_rendering": True,
                "queue_count": 0,
                "current_song": "Song A",
                "logs": ["[12:00:01] Rendered 35%"],
                "progress_percent": 35,
            }
        elif step <= 4:
            body = {
                "is_downloading": False,
                "is_rendering": True,
                "queue_count": 0,
                "current_song": "Song A",
                "logs": ["[12:00:01] Rendered 35%", "[12:00:02] Rendered 75%"],
                "progress_percent": 75,
            }
        else:
            body = {
                "is_downloading": False,
                "is_rendering": False,
                "queue_count": 0,
                "current_song": "",
                "logs": [
                    "[12:00:01] Rendered 35%",
                    "[12:00:02] Rendered 75%",
                    "[12:00:03] Export complete",
                ],
                "progress_percent": 100,
            }
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    page.route("**/api/remotion/render", _mock_render_start)
    page.route("**/api/status", _mock_render_status)
    page.get_by_test_id("export-btn").click()
    page.get_by_test_id("cancel-render-btn").wait_for(state="visible", timeout=5000)
    page.wait_for_function(
        "() => (document.querySelector('[data-testid=\"console-drawer\"]')?.innerText || document.querySelector('[data-testid=\"console-latest-msg\"]')?.innerText || '').includes('Rendered 75%')",
        timeout=8000,
    )
    page.wait_for_function(
        "() => Boolean(document.querySelector('[data-testid=\"export-btn\"]'))",
        timeout=8000,
    )
    assert len(render_payloads) == 1
    assert isinstance(render_payloads[0], dict)
    page.unroute("**/api/status")
    page.unroute("**/api/remotion/render")

    cancel_state = {"active": True, "calls": 0}

    def _mock_cancel_status(route):
        body = {
            "is_downloading": False,
            "is_rendering": cancel_state["active"],
            "queue_count": 0,
            "current_song": "Song A" if cancel_state["active"] else "",
            "logs": ["[12:01:00] Rendering frame 40"] if cancel_state["active"] else ["[12:01:02] Cancelled"],
            "progress_percent": 40 if cancel_state["active"] else 0,
        }
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    def _mock_cancel_post(route):
        cancel_state["calls"] += 1
        cancel_state["active"] = False
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"status": "cancelled", "message": "已发送停止渲染信号"}),
        )

    page.route("**/api/remotion/render", _mock_render_start)
    page.route("**/api/status", _mock_cancel_status)
    page.route("**/api/remotion/cancel", _mock_cancel_post)

    page.get_by_test_id("export-btn").click()
    page.get_by_test_id("cancel-render-btn").wait_for(state="visible", timeout=5000)
    page.get_by_test_id("cancel-render-btn").click()
    page.get_by_test_id("export-btn").wait_for(state="visible", timeout=5000)
    assert cancel_state["calls"] == 1
    assert page.get_by_test_id("toast-notice").is_visible()
    runtime.assert_clean()


def test_multi_viewport_layout_and_long_log_operability(browser_page):
    page, url, runtime = browser_page
    server.log_task(
        "nothing in those days, nothingness was still there, samebeam page 1: "
        + "Unable to download API page: HTTPSConnectionPool(host='www.youtube.com', port=443): " * 5
    )
    page.route(
        "**/api/candidates*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"status": "ok", "candidates": []}),
        ),
    )

    _goto_studio(page, url)
    page.get_by_test_id("deck-title").wait_for(state="visible", timeout=5000)

    for w, h in VIEWPORTS:
        page.set_viewport_size({"width": w, "height": h})
        page.wait_for_timeout(120)

        page.get_by_test_id("rack-song-0").click()
        page.get_by_test_id("tab-trim").click()
        if w in (1024, 900):
            page.locator(".deck-body").evaluate("(body) => { body.scrollTop = 0; }")
            _maybe_shot(page, f"chassis_{w}_monitor")
        _assert_no_layout_overflow(
            page,
            required_testids=(
                "brand-plate",
                "seq-name-input",
                "save-chip",
                "studio-btn",
                "export-btn",
                "track-rack",
                "rack-intro",
                "rack-song-0",
                "monitor-screen",
                "tape-scrubber",
                "apply-trim-save-btn",
            ),
            allow_vertical_scroll_testids=("apply-trim-save-btn",),
        )
        boxes = page.evaluate(
            """() => {
              const brand = document.querySelector('[data-testid="brand-plate"]')?.getBoundingClientRect();
              const rack = document.querySelector('[data-testid="track-rack"]')?.getBoundingClientRect();
              return {
                brandX: brand ? brand.x : -1,
                rackX: rack ? rack.x : -1,
                rackW: rack ? rack.width : 0,
              };
            }"""
        )
        assert boxes["brandX"] >= 0, boxes
        assert boxes["rackX"] >= 0 and boxes["rackW"] >= 200, boxes
        if w <= 1060:
            stack = page.evaluate(
                """() => {
                  const sc = document.querySelector('[data-testid="tape-scrubber"]')?.getBoundingClientRect();
                  const ly = document.querySelector('[data-testid="lyrics-panel"]')?.getBoundingClientRect();
                  return { scBottom: sc ? sc.bottom : 0, lyTop: ly ? ly.top : 0 };
                }"""
            )
            assert stack["scBottom"] <= stack["lyTop"] + 1, stack
        if w == 1024:
            _maybe_shot(page, "resize_1024_long_log")
        if w == 900:
            _maybe_shot(page, "viewport_900_trim")

        page.get_by_test_id("tab-source").click()
        if w == 1440:
            with page.expect_response(
                lambda r: "/api/candidates" in r.url and r.status == 200
            ):
                page.get_by_test_id("cand-search-btn").click()
            page.wait_for_function(
                "() => (document.querySelector('[data-testid=\"cand-bay\"]')?.innerText || '').includes('NO CANDIDATES FOUND')",
                timeout=3000,
            )
            assert page.get_by_test_id("cand-card-0").count() == 0
            page.get_by_test_id("cand-switch-btn").click()
        _assert_no_layout_overflow(
            page,
            required_testids=(
                "source-mode-video_url",
                "source-mode-netease_cover",
                "source-mode-local",
                "cand-search-input",
                "cand-search-btn",
            ),
            allow_vertical_scroll_testids=("cand-search-input", "cand-search-btn"),
        )
        if w == 1024:
            _maybe_shot(page, "source_1024")

        page.get_by_test_id("tab-stage").click()
        _assert_no_layout_overflow(
            page,
            required_testids=(
                "meta-title-input",
                "fx-transition-select",
                "fx-visual-select",
                "meta-save-btn",
            ),
            allow_vertical_scroll_testids=(
                "meta-title-input",
                "fx-transition-select",
                "fx-visual-select",
                "meta-save-btn",
            ),
        )
        if w == 1024:
            _maybe_shot(page, "stage_1024")

        page.get_by_test_id("rack-intro").click()
        _assert_no_layout_overflow(
            page,
            required_testids=(
                "intro-enabled-switch",
                "intro-text-input",
                "global-transition-select",
                "intro-save-btn",
            ),
            allow_vertical_scroll_testids=("global-transition-select", "intro-save-btn"),
        )

        page.get_by_test_id("rack-song-0").click()
        page.get_by_test_id("console-toggle-btn").click()
        page.get_by_test_id("console-drawer").wait_for(state="visible", timeout=3000)
        _assert_no_layout_overflow(
            page,
            required_testids=("console-drawer", "console-clear-btn"),
            allow_vertical_scroll_testids=("console-drawer", "console-clear-btn"),
        )
        page.get_by_test_id("console-toggle-btn").click()

        if w <= 1024:
            page.get_by_test_id("batch-menu-btn").click()
            page.get_by_test_id("batch-menu-panel").get_by_role(
                "button", name=re.compile(r"导入网易云|网易云歌单")
            ).click()
            _assert_modal_unobstructed(page, "modal-netease-import", ("modal-close-btn",))
            page.keyboard.press("Escape")
            page.get_by_test_id("modal-netease-import").wait_for(state="hidden", timeout=3000)

    runtime.assert_clean()
