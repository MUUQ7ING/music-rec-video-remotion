import shutil
import json
import os
import shutil
import threading
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

import pytest

import backend.netease as netease_mod
import server
from backend.schema import RUNTIME_SONG_FIELDS


FIXTURE_MEDIA_DIR = Path(__file__).resolve().parent / "fixtures" / "media"


class _LocalAssetParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = []

    def handle_starttag(self, tag, attrs):
        attr_map = {k.lower(): v for k, v in attrs if v is not None}
        tag_l = tag.lower()
        if tag_l == "script" and attr_map.get("src"):
            self.assets.append(attr_map["src"])
        elif tag_l == "link":
            rel_tokens = set((attr_map.get("rel") or "").lower().split())
            if "stylesheet" in rel_tokens and attr_map.get("href"):
                self.assets.append(attr_map["href"])


def test_static_assets_and_root_served(client):
    r_root = client.get("/")
    assert r_root.status_code == 200
    assert "MRV-02" in r_root.text
    assert r_root.headers.get("cache-control") == "no-store"

    parser = _LocalAssetParser()
    parser.feed(r_root.text)
    local_assets = []
    for asset_url in parser.assets:
        parsed = urlparse(asset_url)
        if parsed.scheme or parsed.netloc or asset_url.startswith("//"):
            continue
        local_assets.append(asset_url)

    assert len(local_assets) >= 1
    dist_built = Path(server.WEB_DIR, "dist", "index.html").is_file()
    if dist_built:
        static_assets = [u for u in local_assets if u.startswith("/static/")]
        assert len(static_assets) >= 1
        for asset_url in local_assets:
            r_asset = client.get(asset_url)
            assert r_asset.status_code == 200, asset_url
            assert r_asset.headers.get("cache-control") == "no-store", asset_url
    else:
        for asset_url in local_assets:
            if asset_url.startswith("/static/"):
                r_asset = client.get(asset_url)
                assert r_asset.status_code == 200, asset_url
                assert r_asset.headers.get("cache-control") == "no-store", asset_url
        r_static_index = client.get("/static/index.html")
        assert r_static_index.status_code == 200
        assert r_static_index.headers.get("cache-control") == "no-store"


def test_web_dir_fallback_and_dist_switching(client, tmp_path, monkeypatch):
    web_root = tmp_path / "web_env"
    web_root.mkdir()
    (web_root / "index.html").write_text("<html>legacy-index</html>", encoding="utf-8")
    (web_root / "legacy.js").write_text("console.log('legacy');", encoding="utf-8")
    monkeypatch.setattr(server, "WEB_DIR", str(web_root))

    r_root_legacy = client.get("/")
    assert r_root_legacy.status_code == 200
    assert "legacy-index" in r_root_legacy.text
    assert r_root_legacy.headers.get("cache-control") == "no-store"

    r_js_legacy = client.get("/static/legacy.js")
    assert r_js_legacy.status_code == 200
    assert "legacy" in r_js_legacy.text
    assert r_js_legacy.headers.get("cache-control") == "no-store"

    dist_dir = web_root / "dist"
    (dist_dir / "assets").mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html>dist-index</html>", encoding="utf-8")
    (dist_dir / "assets" / "app.js").write_text("console.log('dist');", encoding="utf-8")

    r_root_dist = client.get("/")
    assert r_root_dist.status_code == 200
    assert "dist-index" in r_root_dist.text
    assert r_root_dist.headers.get("cache-control") == "no-store"

    r_js_dist = client.get("/static/assets/app.js")
    assert r_js_dist.status_code == 200
    assert "dist" in r_js_dist.text
    assert r_js_dist.headers.get("cache-control") == "no-store"

    r_traversal = client.get("/static/%2e%2e/legacy.js")
    assert r_traversal.status_code == 404


def test_playlist_runtime_flags_and_roundtrip(client):
    r = client.get("/api/playlist")
    assert r.status_code == 200
    data = r.json()
    assert len(data["songs"]) == 2

    s0, s1 = data["songs"]
    assert s0["has_file"] is True
    assert s0["has_normalized"] is True
    assert s0["has_cover"] is True
    assert s0["has_audio"] is True
    assert s0["has_lyrics"] is True
    assert s0["file_size_mb"] > 0

    assert s1["has_file"] is False
    assert s1["has_normalized"] is False
    assert s1["has_cover"] is False
    assert s1["has_lyrics"] is False

    data["output_sequence_name"] = "Updated Seq"
    data["songs"][1]["reason"] = "Great track"
    r_save = client.post("/api/playlist", json={"data": data})
    assert r_save.status_code == 200

    r2 = client.get("/api/playlist").json()
    assert r2["output_sequence_name"] == "Updated Seq"
    assert r2["songs"][1]["reason"] == "Great track"


def test_youtube_cookie_import_keeps_other_domains_out(client, isolated_env):
    bilibili = isolated_env / "cookies.txt"
    bilibili.write_text("existing Bilibili data")
    fake_cookie = (
        "# Netscape HTTP Cookie File\n"
        "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSESSION\tfake-test-value\n"
        ".example.com\tTRUE\t/\tTRUE\t0\tSESSION\tother-value\n"
    )
    endpoint = "/api/youtube/cookies"
    assert client.get(endpoint).json() == {"configured": False}
    upload = {"file": ("cookies.txt", fake_cookie, "text/plain")}
    assert client.post(endpoint, files=upload, headers={"Origin": "https://example.com"}).status_code == 403
    assert client.post(endpoint, files=upload).json() == {"configured": True}
    path = isolated_env / "youtube_cookies.txt"
    saved = path.read_text()
    assert "#HttpOnly_.youtube.com" in saved and "other-value" not in saved
    assert path.stat().st_mode & 0o077 == 0
    assert bilibili.read_text() == "existing Bilibili data"
    assert client.post(endpoint, files={"file": ("cookies.txt", "invalid")}).status_code == 422
    assert path.read_text() == saved


def test_media_and_audio_streaming_states(client):
    assert client.get("/api/media/0").status_code == 200
    assert client.get("/api/media/1").status_code == 404
    assert client.get("/api/media/99").status_code == 404
    assert client.get("/api/media/-1").status_code == 404

    assert client.get("/api/audio/0").status_code == 200
    assert client.get("/api/audio/1").status_code == 404
    assert client.get("/api/audio/99").status_code == 404


def test_preview_waveform_follows_normalized_media_and_handles_missing(client, seeded_playlist):
    shutil.copyfile(FIXTURE_MEDIA_DIR / "project-review.mp4", seeded_playlist / "processed" / "song_a_norm.mp4")

    response = client.get("/api/waveform/0")
    assert response.status_code == 200
    waveform = response.json()
    assert 4 < waveform["duration"] < 5
    assert len(waveform["peaks"]) == 240
    assert 0 < max(waveform["peaks"]) <= 1
    assert client.get("/api/waveform/1").json() == {"duration": 0, "peaks": []}


def test_upload_local_media_binds_and_clears_stale_norm(client, seeded_playlist):
    video_bytes = (FIXTURE_MEDIA_DIR / "color-video.mp4").read_bytes()
    r = client.post(
        "/api/upload_media/0",
        files={"file": ("live_show.mp4", video_bytes, "video/mp4")},
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["status"] == "ok"
    assert payload["file_path"].startswith("raw/")
    assert "_local.mp4" in payload["file_path"]

    pl = client.get("/api/playlist").json()
    s0 = pl["songs"][0]
    assert s0["media_source"] == "local"
    assert s0["normalized_path"] == ""
    assert s0["has_file"] is True

    r_oob = client.post(
        "/api/upload_media/99",
        files={"file": ("x.mp4", video_bytes, "video/mp4")},
    )
    assert r_oob.status_code == 404


def test_lyrics_read_and_missing_fallback(client):
    r0 = client.get("/api/lyrics/0")
    assert r0.status_code == 200
    assert len(r0.json()["lines"]) == 2
    assert r0.json()["has_translation"] is True

    r1 = client.get("/api/lyrics/1")
    assert r1.status_code == 200
    assert r1.json()["lines"] == []

    assert client.get("/api/lyrics/99").status_code == 404


def test_resolve_song_index_survives_reorder_and_deletion():
    songs = [
        {"netease_id": "101", "title": "Alpha", "artist": "A"},
        {"netease_id": "202", "title": "Beta", "artist": "B"},
        {"netease_id": "", "title": "Gamma", "artist": "C"},
    ]
    key_beta = server._make_song_key(songs[1])
    key_gamma = server._make_song_key(songs[2])

    reordered = [songs[2], songs[0], songs[1]]
    assert server._resolve_song_index(reordered, 1, key_beta) == 2
    assert server._resolve_song_index(reordered, 2, key_gamma) == 0

    deleted = [songs[0], songs[2]]
    assert server._resolve_song_index(deleted, 1, key_beta) is None


def test_exclusive_task_mutex_blocks_concurrent_and_recovers_on_error(client):
    gate = threading.Event()

    def failing_worker():
        gate.wait(timeout=2)
        raise RuntimeError("boom")

    started = server._start_exclusive_task(failing_worker, label="test-busy", flag="is_rendering")
    assert started is True

    r_dl = client.post("/api/download_all", json={"force": False})
    r_na = client.post("/api/netease_audio/download_all", json={})
    r_pp = client.post("/api/preprocess", json={"force": False})
    r_av = client.post("/api/analyze_visuals")
    r_rr = client.post("/api/remotion/render", json={})

    for resp, expected_code in (
        (r_dl, 400),
        (r_na, 400),
        (r_pp, 400),
        (r_av, 409),
        (r_rr, 400),
    ):
        assert resp.status_code == expected_code
        body = resp.json()
        assert isinstance(body.get("detail"), str) and body["detail"]
        assert isinstance(body.get("message"), str) and body["message"]

    gate.set()
    deadline = time.time() + 2.0
    while time.time() < deadline:
        st = client.get("/api/status").json()
        if not st["is_rendering"] and not st["is_downloading"]:
            break
        time.sleep(0.05)

    st = client.get("/api/status").json()
    assert st["is_rendering"] is False
    assert st["is_downloading"] is False


def test_logs_clear_and_status_endpoint(client):
    server.log_task("hello-test-log")
    st = client.get("/api/status").json()
    assert any("hello-test-log" in line for line in st["logs"])

    r = client.post("/api/logs/clear")
    assert r.status_code == 200
    assert client.get("/api/status").json()["logs"] == []


def test_netease_audio_script_parsing_and_invalid_script(client, monkeypatch, isolated_env):
    import backend.netease_audio as na_mod
    cfg_file = isolated_env / "music_source_config.json"
    monkeypatch.setattr(server, "save_music_source_config", lambda **kw: na_mod.save_music_source_config(**kw, config_path=cfg_file))
    monkeypatch.setattr(server, "get_music_source_status", lambda: na_mod.get_music_source_status(config_path=cfg_file))

    r_bad = client.post("/api/netease_audio/config", json={"script_text": "const x = 1;"})
    assert r_bad.status_code == 400

    lx_script = "const API_URL = 'https://example.test/api';\nconst API_KEY = 'secret-123456';\n"
    r_ok = client.post("/api/netease_audio/config", json={"script_text": lx_script, "default_quality": "flac"})
    assert r_ok.status_code == 200
    cfg = r_ok.json()
    assert cfg["configured"] is True
    assert cfg["api_url"] == "https://example.test/api"
    assert cfg["default_quality"] == "flac"


def test_bilibili_status_and_logout_and_remotion_cancel_idle(client):
    st = client.get("/api/bilibili/status").json()
    assert st["logged_in"] is False

    assert client.post("/api/bilibili/logout").status_code == 200

    cancel = client.post("/api/remotion/cancel").json()
    assert cancel["status"] == "idle"


def test_remotion_studio_missing_dir_returns_404(client, isolated_env):
    r = client.post("/api/remotion/studio")
    assert r.status_code == 404
    body = r.json()
    assert isinstance(body.get("detail"), str) and body["detail"]
    assert isinstance(body.get("message"), str) and body["message"]


def test_remotion_studio_already_running_returns_200(client, isolated_env, monkeypatch):
    (isolated_env / "remotion").mkdir()
    monkeypatch.setattr(server, "_is_port_open", lambda port: True)

    r = client.post("/api/remotion/studio")
    assert r.status_code == 200
    assert r.json() == {"status": "running", "url": f"http://127.0.0.1:{server.STUDIO_PORT}"}


def test_remotion_studio_start_success_and_closes_log_handle(client, isolated_env, monkeypatch):
    (isolated_env / "remotion").mkdir()
    port_states = iter([False, False, True])
    monkeypatch.setattr(server, "_is_port_open", lambda port: next(port_states, True))
    monkeypatch.setattr(server.time, "sleep", lambda _sec: None)

    captured = {}

    class FakeProc:
        def poll(self):
            return None

    def fake_popen(cmd, **kwargs):
        captured["handle"] = kwargs.get("stdout")
        return FakeProc()

    monkeypatch.setattr(server.subprocess, "Popen", fake_popen)

    r = client.post("/api/remotion/studio")
    assert r.status_code == 200
    assert r.json() == {"status": "started", "url": f"http://127.0.0.1:{server.STUDIO_PORT}"}
    assert captured["handle"] is not None
    assert captured["handle"].closed is True
    assert (isolated_env / "remotion" / "studio.log").is_file()


def test_remotion_studio_popen_error_crash_and_timeout_close_log_handle(client, isolated_env, monkeypatch):
    (isolated_env / "remotion").mkdir()
    monkeypatch.setattr(server, "_is_port_open", lambda port: False)
    monkeypatch.setattr(server.time, "sleep", lambda _sec: None)

    def raise_popen(cmd, **kwargs):
        raise OSError("npx unavailable")

    monkeypatch.setattr(server.subprocess, "Popen", raise_popen)
    r_err = client.post("/api/remotion/studio")
    assert r_err.status_code == 500
    err_body = r_err.json()
    assert isinstance(err_body.get("detail"), str) and err_body["detail"]
    assert isinstance(err_body.get("message"), str) and err_body["message"]
    assert any("启动失败" in line for line in client.get("/api/status").json()["logs"])

    captured_crash = {}

    class CrashProc:
        def poll(self):
            return 1

    def crash_popen(cmd, **kwargs):
        captured_crash["handle"] = kwargs.get("stdout")
        return CrashProc()

    monkeypatch.setattr(server, "_remotion_studio_proc", None)
    monkeypatch.setattr(server.subprocess, "Popen", crash_popen)
    r_crash = client.post("/api/remotion/studio")
    assert r_crash.status_code == 500
    crash_body = r_crash.json()
    assert isinstance(crash_body.get("detail"), str) and crash_body["detail"]
    assert isinstance(crash_body.get("message"), str) and crash_body["message"]
    assert captured_crash["handle"].closed is True

    captured_timeout = {}

    class SlowProc:
        def poll(self):
            return None

    def timeout_popen(cmd, **kwargs):
        captured_timeout["handle"] = kwargs.get("stdout")
        return SlowProc()

    monkeypatch.setattr(server, "_remotion_studio_proc", None)
    monkeypatch.setattr(server.subprocess, "Popen", timeout_popen)
    r_timeout = client.post("/api/remotion/studio")
    assert r_timeout.status_code == 504
    timeout_body = r_timeout.json()
    assert isinstance(timeout_body.get("detail"), str) and timeout_body["detail"]
    assert isinstance(timeout_body.get("message"), str) and timeout_body["message"]
    assert captured_timeout["handle"].closed is True


def test_remotion_render_progress_busy_and_completion(client, seeded_playlist, monkeypatch):
    (seeded_playlist / "remotion").mkdir()
    mid_evt = threading.Event()
    finish_evt = threading.Event()
    captured = {}

    class FakeRenderProc:
        pid = 424242

        def __init__(self, out_path: Path):
            self._out_path = out_path
            self._done = False
            self.stdout = self._iter_lines()

        def _iter_lines(self):
            yield "Rendered 2/4\n"
            mid_evt.set()
            finish_evt.wait(timeout=3.0)
            self._out_path.parent.mkdir(parents=True, exist_ok=True)
            self._out_path.write_bytes(b"fake-mp4-content")
            yield "Rendered 4/4\n"

        def poll(self):
            return 0 if self._done else None

        def wait(self):
            self._done = True
            return 0

    def fake_popen(cmd, **kwargs):
        out_path = Path(cmd[5])
        captured["out_path"] = out_path
        return FakeRenderProc(out_path)

    monkeypatch.setattr(server.subprocess, "Popen", fake_popen)

    r_start = client.post("/api/remotion/render", json={"output_name": "smoke_out"})
    assert r_start.status_code == 200
    assert r_start.json()["status"] == "started"

    assert mid_evt.wait(timeout=3.0)
    deadline = time.time() + 3.0
    while time.time() < deadline:
        st = client.get("/api/status").json()
        if st["is_rendering"] and st["progress_percent"] == 50:
            break
        time.sleep(0.02)

    st = client.get("/api/status").json()
    assert st["is_rendering"] is True
    assert st["progress_percent"] == 50

    r_busy = client.post("/api/remotion/render", json={})
    assert r_busy.status_code == 400
    busy_body = r_busy.json()
    assert isinstance(busy_body.get("detail"), str) and busy_body["detail"]
    assert isinstance(busy_body.get("message"), str) and busy_body["message"]

    finish_evt.set()
    deadline = time.time() + 3.0
    while time.time() < deadline:
        st = client.get("/api/status").json()
        if not st["is_rendering"]:
            break
        time.sleep(0.02)

    st = client.get("/api/status").json()
    assert st["is_rendering"] is False
    assert st["progress_percent"] == 100
    assert captured["out_path"].is_file()


def test_remotion_render_cancel_active_and_idle(client, seeded_playlist, monkeypatch):
    (seeded_playlist / "remotion").mkdir()
    started_evt = threading.Event()
    stop_evt = threading.Event()

    class CancellableRenderProc:
        pid = 525252

        def __init__(self):
            self.stdout = self._iter_lines()

        def _iter_lines(self):
            yield "Rendered 1/10\n"
            started_evt.set()
            stop_evt.wait(timeout=3.0)

        def poll(self):
            return -15 if stop_evt.is_set() else None

        def terminate(self):
            stop_evt.set()

        def kill(self):
            stop_evt.set()

        def wait(self):
            stop_evt.wait(timeout=3.0)
            return -15

    proc_holder = {}

    def fake_popen(cmd, **kwargs):
        proc = CancellableRenderProc()
        proc_holder["proc"] = proc
        return proc

    monkeypatch.setattr(server.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(os, "killpg", lambda pid, sig: proc_holder["proc"].terminate())

    r_start = client.post("/api/remotion/render", json={})
    assert r_start.status_code == 200
    assert started_evt.wait(timeout=3.0)

    deadline = time.time() + 3.0
    while time.time() < deadline and server._remotion_render_proc is None:
        time.sleep(0.02)
    assert server._remotion_render_proc is not None

    r_cancel = client.post("/api/remotion/cancel")
    assert r_cancel.status_code == 200
    assert r_cancel.json()["status"] == "cancelled"

    deadline = time.time() + 3.0
    while time.time() < deadline:
        st = client.get("/api/status").json()
        if not st["is_rendering"]:
            break
        time.sleep(0.02)

    st = client.get("/api/status").json()
    assert st["is_rendering"] is False
    assert any("Remotion 渲染已手动停止" in line for line in st["logs"])

    r_idle = client.post("/api/remotion/cancel")
    assert r_idle.status_code == 200
    assert r_idle.json()["status"] == "idle"


def test_post_playlist_validation_failure_and_write_error_preserve_disk_file(client, seeded_playlist, monkeypatch):
    pl_path = seeded_playlist / "playlist.json"
    orig_bytes = pl_path.read_bytes()

    invalid_payloads = [
        {"songs": [{"artist": "Only Artist"}]},
        {"fps": "bad", "songs": []},
        {"songs": [{"title": "T", "artist": "A", "media_source": "bogus"}]},
        {"songs": None},
    ]
    for payload in invalid_payloads:
        r = client.post("/api/playlist", json={"data": payload})
        assert r.status_code == 422
        body = r.json()
        assert isinstance(body.get("detail"), str) and body["detail"]
        assert isinstance(body.get("message"), str) and body["message"]
        assert pl_path.read_bytes() == orig_bytes

    def fail_save(_model, _path):
        raise OSError("disk full")

    monkeypatch.setattr(server, "save_playlist_model", fail_save)
    valid_payload = json.loads(orig_bytes.decode("utf-8"))
    valid_payload["output_sequence_name"] = "Should Not Persist"
    r_err = client.post("/api/playlist", json={"data": valid_payload})
    assert r_err.status_code == 500
    err_body = r_err.json()
    assert isinstance(err_body.get("detail"), str) and err_body["detail"]
    assert isinstance(err_body.get("message"), str) and err_body["message"]
    assert pl_path.read_bytes() == orig_bytes


def test_multiple_imported_playlists_keep_independent_projects(client, seeded_playlist, monkeypatch):
    from backend.schema import save_playlist

    def import_fixture(url, *, limit, output_path):
        save_playlist({"output_sequence_name": url, "songs": [{"title": f"Track {url}", "artist": "Artist"}]}, output_path)
        return 1, url

    monkeypatch.setattr(server, "import_netease_playlist", import_fixture)
    result = client.post("/api/projects/import", json={"urls": ["101", "102"], "limit": 3})
    assert result.status_code == 200, result.text
    catalog = client.get("/api/projects").json()
    projects = {project["name"]: project["id"] for project in catalog["projects"]}
    assert set(projects) == {"101", "102", "Test Seq"}
    assert catalog["active"] == projects["101"]

    current = client.get("/api/playlist").json()
    current["songs"][0]["reason"] = "First project edit"
    assert client.post("/api/playlist", json={"data": current}).status_code == 200
    assert client.post(f"/api/projects/{projects['102']}/activate").status_code == 200
    assert client.get("/api/playlist").json()["songs"][0]["title"] == "Track 102"
    assert client.post("/api/playlist", json={"data": current}).status_code == 409
    assert client.post(f"/api/projects/{projects['101']}/activate").status_code == 200
    assert client.get("/api/playlist").json()["songs"][0]["reason"] == "First project edit"
    assert client.post(f"/api/projects/{projects['Test Seq']}/activate").status_code == 200
    assert client.get("/api/playlist").json()["songs"][0]["title"] == "Song A"


def test_netease_import_uses_atomic_schema_save_and_strips_runtime_fields(isolated_env, monkeypatch):
    target = isolated_env / "playlist.json"
    seed = {
        "output_sequence_name": "Existing Seq",
        "fps": 30,
        "intro": {"enabled": True, "text": "Keep me"},
        "songs": [
            {
                "title": "Old Song",
                "artist": "Old Artist",
                "has_file": True,
                "file_size_mb": 12.3,
                "has_cover": True,
                "has_audio": True,
                "audio_size_mb": 4.5,
            }
        ],
    }
    target.write_text(json.dumps(seed, ensure_ascii=False, indent=2), encoding="utf-8")

    monkeypatch.setattr(
        netease_mod,
        "fetch_playlist_data",
        lambda _pid: {
            "name": "NetEase Imported",
            "description": "",
            "tracks": [
                {
                    "id": 9001,
                    "name": "New Track",
                    "artists": [{"name": "Artist One"}],
                    "album": {"name": None, "picUrl": None},
                    "duration": 180000,
                },
                {
                    "id": 9002,
                    "name": "Old Song",
                    "artists": [{"name": "Old Artist"}],
                    "album": {"name": "Alb", "picUrl": "https://img.test/a.jpg"},
                    "duration": 200000,
                },
            ],
        },
    )

    added, pl_name = netease_mod.import_netease_playlist(
        "3778678",
        limit=5,
        append=True,
        output_path=target,
    )
    assert added == 1
    assert pl_name == "NetEase Imported"

    persisted = json.loads(target.read_text(encoding="utf-8"))
    assert persisted["output_sequence_name"] == "Existing Seq"
    assert persisted["intro"]["enabled"] is True
    assert persisted["intro"]["text"] == "Keep me"
    assert len(persisted["songs"]) == 2
    for song in persisted["songs"]:
        for field in RUNTIME_SONG_FIELDS:
            assert field not in song
    assert list(isolated_env.glob(".*.tmp")) == []

    saved_bytes = target.read_bytes()
    monkeypatch.setattr(os, "replace", lambda _src, _dst: (_ for _ in ()).throw(OSError("replace failed")))
    with pytest.raises(OSError):
        netease_mod.import_netease_playlist(
            "3778678",
            limit=5,
            append=False,
            output_path=target,
        )
    assert target.read_bytes() == saved_bytes
    assert list(isolated_env.glob(".*.tmp")) == []


def test_batch_builds_cover_video_even_when_an_mv_already_exists(seeded_playlist, monkeypatch):
    from backend.download import slug
    from backend.schema import load_playlist, save_playlist

    path = seeded_playlist / "playlist.json"
    playlist = load_playlist(path)
    playlist.songs[0].media_source = "netease_cover"
    playlist.songs[1].media_source = "local"
    save_playlist(playlist, path)
    calls = []

    def synthesize(*, song, base_dir, mode, force, **kwargs):
        calls.append((mode, force))
        song.file_path = f"raw/{slug(song.title, song.artist)}_cover.mp4"
        shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", base_dir / song.file_path)
        return {"quality": "flac"}

    def normalize(song, root, **kwargs):
        name = server.normalized_video_name(song)
        song.normalized_path = f"processed/{name}"
        shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", root / song.normalized_path)
        return False, True

    monkeypatch.setattr(server, "download_netease_for_song", synthesize)
    monkeypatch.setattr(server, "preprocess_song", normalize)
    server._worker_download_all(force=False, quality="1080")
    saved = load_playlist(path).songs[0]
    assert saved.file_path.endswith("_cover.mp4")
    assert saved.normalized_path.endswith("_cover_norm.mp4")
    assert (seeded_playlist / "raw" / "song_a.mp4").exists()

    (seeded_playlist / saved.file_path).unlink()
    server._worker_download_all(force=False, quality="1080")
    assert calls == [("video", False)]


def test_worker_download_all_preserves_prior_songs_and_uses_server_base_dir(tmp_path, monkeypatch):
    import backend.download as dl_mod
    from backend.schema import PlaylistConfig, SongItem, load_playlist, save_playlist

    for d in ("raw", "processed", "covers", "lyrics", "audio", "output"):
        (tmp_path / d).mkdir(parents=True, exist_ok=True)
    wrong_base = tmp_path / "wrong_base"
    wrong_raw = wrong_base / "raw"
    wrong_raw.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(server, "BASE_DIR", str(tmp_path))
    monkeypatch.setattr(server, "BASE_PATH", tmp_path)
    monkeypatch.setattr(server, "PLAYLIST_FILE", str(tmp_path / "playlist.json"))
    monkeypatch.setattr(server, "RAW_DIR", str(wrong_raw))
    monkeypatch.setattr(dl_mod, "BASE_DIR", str(wrong_base))
    monkeypatch.setattr(dl_mod, "RAW_DIR", str(wrong_raw))

    shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", tmp_path / "raw" / "existing_s0.mp4")
    shutil.copyfile(FIXTURE_MEDIA_DIR / "cover.png", tmp_path / "covers" / "s0.png")
    shutil.copyfile(FIXTURE_MEDIA_DIR / "cover.png", tmp_path / "covers" / "s1.png")

    pl = PlaylistConfig(
        output_sequence_name="Batch Download Isolation",
        songs=[
            SongItem(
                title="Song Zero",
                artist="Artist Zero",
                netease_id="2001",
                youtube_url="https://www.bilibili.com/video/BV1s0",
                file_path="/legacy/abs/existing_s0.mp4",
                cover_path="covers/s0.png",
                normalized_path="",
            ),
            SongItem(
                title="Song One",
                artist="Artist One",
                netease_id="2002",
                youtube_url="https://www.bilibili.com/video/BV1s1",
                file_path="",
                cover_path="covers/s1.png",
                normalized_path="",
            ),
        ],
    )
    save_playlist(pl, tmp_path / "playlist.json")

    downloaded_paths = []

    def fake_download_mv(url, out_path, quality="1080", log_fn=None):
        downloaded_paths.append(Path(out_path))
        assert Path(out_path).parent == tmp_path / "raw"
        shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", out_path)
        return True

    def fake_preprocess_song(song, project_root, force=False, log_fn=None):
        norm_name = f"{dl_mod.slug(song.title, song.artist)}_norm.mp4"
        norm_path = project_root / "processed" / norm_name
        shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", norm_path)
        song.normalized_path = f"processed/{norm_name}"
        return False, True

    monkeypatch.setattr(server, "download_mv", fake_download_mv)
    monkeypatch.setattr(server, "preprocess_song", fake_preprocess_song)

    server._worker_download_all(force=False, quality="1080")

    assert len(downloaded_paths) == 1
    assert downloaded_paths[0].name == "Artist_One_Song_One.mp4"

    saved = load_playlist(tmp_path / "playlist.json")
    assert saved.songs[0].normalized_path == "processed/Artist_Zero_Song_Zero_norm.mp4"
    assert saved.songs[0].cover_path == "covers/s0.png"
    assert saved.songs[1].file_path == "raw/Artist_One_Song_One.mp4"
    assert saved.songs[1].normalized_path == "processed/Artist_One_Song_One_norm.mp4"
    assert saved.songs[1].cover_path == "covers/s1.png"


def test_worker_download_single_preserves_concurrent_playlist_edits(tmp_path, monkeypatch):
    import backend.download as dl_mod
    from backend.schema import PlaylistConfig, SongItem, load_playlist, save_playlist

    for d in ("raw", "processed", "covers", "lyrics", "audio", "output"):
        (tmp_path / d).mkdir(parents=True, exist_ok=True)
    wrong_base = tmp_path / "wrong_base"
    wrong_raw = wrong_base / "raw"
    wrong_raw.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(server, "BASE_DIR", str(tmp_path))
    monkeypatch.setattr(server, "BASE_PATH", tmp_path)
    monkeypatch.setattr(server, "PLAYLIST_FILE", str(tmp_path / "playlist.json"))
    monkeypatch.setattr(server, "RAW_DIR", str(wrong_raw))
    monkeypatch.setattr(dl_mod, "BASE_DIR", str(wrong_base))
    monkeypatch.setattr(dl_mod, "RAW_DIR", str(wrong_raw))

    shutil.copyfile(FIXTURE_MEDIA_DIR / "cover.png", tmp_path / "covers" / "c0.png")
    pl = PlaylistConfig(
        output_sequence_name="Initial Seq",
        songs=[
            SongItem(
                title="Title Single",
                artist="Artist Single",
                netease_id="3001",
                youtube_url="https://www.bilibili.com/video/BV1c0",
                cover_path="covers/c0.png",
                reason="Before download",
            )
        ],
    )
    save_playlist(pl, tmp_path / "playlist.json")

    def fake_download_mv(url, out_path, quality="1080", log_fn=None):
        assert Path(out_path).parent == tmp_path / "raw"
        shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", out_path)
        concurrent = load_playlist(tmp_path / "playlist.json")
        concurrent.output_sequence_name = "Concurrent Edit"
        concurrent.songs[0].reason = "Edited while downloading"
        save_playlist(concurrent, tmp_path / "playlist.json")
        return True

    def fake_preprocess_song(song, project_root, force=False, log_fn=None):
        norm_name = f"{dl_mod.slug(song.title, song.artist)}_norm.mp4"
        shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", project_root / "processed" / norm_name)
        song.normalized_path = f"processed/{norm_name}"
        return False, True

    monkeypatch.setattr(server, "download_mv", fake_download_mv)
    monkeypatch.setattr(server, "preprocess_song", fake_preprocess_song)

    key = server._make_song_key(pl.songs[0])
    server._worker_download_single(0, force=True, quality="1080", song_key=key)

    saved = load_playlist(tmp_path / "playlist.json")
    assert saved.output_sequence_name == "Concurrent Edit"
    assert saved.songs[0].reason == "Edited while downloading"
    assert saved.songs[0].file_path == "raw/Artist_Single_Title_Single.mp4"
    assert saved.songs[0].normalized_path == "processed/Artist_Single_Title_Single_norm.mp4"


def test_upload_media_unlinks_stale_norm_so_preprocess_renormalizes(client, isolated_env):
    from backend.download import slug
    from backend.schema import PlaylistConfig, SongItem, save_playlist

    song_slug = slug("Title X", "Artist X")
    stale_norm = isolated_env / "processed" / f"{song_slug}_norm.mp4"
    shutil.copyfile(FIXTURE_MEDIA_DIR / "cover.png", isolated_env / "covers" / "x.png")
    shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", isolated_env / "raw" / "old_mv.mp4")
    stale_norm.write_bytes(b"OLD_STALE_NORM_BYTES")

    pl = PlaylistConfig(
        output_sequence_name="Upload Norm Cleanup",
        songs=[
            SongItem(
                title="Title X",
                artist="Artist X",
                netease_id="4001",
                media_source="video_url",
                file_path="raw/old_mv.mp4",
                normalized_path=f"processed/{song_slug}_norm.mp4",
                cover_path="covers/x.png",
            )
        ],
    )
    save_playlist(pl, isolated_env / "playlist.json")

    new_video_bytes = (FIXTURE_MEDIA_DIR / "project-review.mp4").read_bytes()
    r_up = client.post(
        "/api/upload_media/0",
        files={"file": ("new_local.mp4", new_video_bytes, "video/mp4")},
    )
    assert r_up.status_code == 200
    assert r_up.json()["file_path"] == f"raw/{song_slug}_local.mp4"
    assert stale_norm.exists() is False
    assert list((isolated_env / "raw").glob(".*.tmp")) == []

    r_media = client.get("/api/media/0")
    assert r_media.status_code == 200
    assert r_media.headers.get("cache-control") == "no-store"

    server._worker_preprocess(force=False)

    assert stale_norm.is_file() is True
    norm_bytes = stale_norm.read_bytes()
    assert norm_bytes != b"OLD_STALE_NORM_BYTES"
    assert b"ftyp" in norm_bytes[:32]
    s0 = client.get("/api/playlist").json()["songs"][0]
    assert s0["normalized_path"] == f"processed/{song_slug}_norm.mp4"
    assert s0["has_normalized"] is True


def test_worker_netease_audio_batch_preserves_prior_normalized_path_and_edits(isolated_env, monkeypatch):
    from backend.download import slug
    from backend.schema import PlaylistConfig, SongItem, load_playlist, save_playlist

    pl = PlaylistConfig(
        output_sequence_name="NE Batch Initial",
        songs=[
            SongItem(
                title="Track Zero",
                artist="Art Zero",
                netease_id="5001",
                reason="Original S0 reason",
            ),
            SongItem(
                title="Track One",
                artist="Art One",
                netease_id="5002",
                reason="Original S1 reason",
            ),
        ],
    )
    save_playlist(pl, isolated_env / "playlist.json")

    monkeypatch.setattr(server.time, "sleep", lambda _sec: None)

    def fake_download_netease(song, base_dir, mode="video", quality=None, force=True, width=1920, height=1080, fps=30, log_fn=None):
        s_slug = slug(song.title, song.artist)
        shutil.copyfile(FIXTURE_MEDIA_DIR / "sine-audio.mp3", base_dir / "audio" / f"{s_slug}.mp3")
        song.audio_path = f"audio/{s_slug}.mp3"
        if mode == "video":
            shutil.copyfile(FIXTURE_MEDIA_DIR / "cover.png", base_dir / "covers" / f"{s_slug}.png")
            shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", base_dir / "raw" / f"{s_slug}.mp4")
            song.cover_path = f"covers/{s_slug}.png"
            song.file_path = f"raw/{s_slug}.mp4"
        if song.netease_id == "5002":
            concurrent = load_playlist(isolated_env / "playlist.json")
            concurrent.output_sequence_name = "Edited During Batch"
            concurrent.songs[0].reason = "Concurrent S0 reason"
            save_playlist(concurrent, isolated_env / "playlist.json")
        return {"song_id": song.netease_id, "quality": "flac", "audio_path": song.audio_path, "video_path": song.file_path}

    def fake_preprocess_song(song, project_root, force=False, log_fn=None):
        s_slug = slug(song.title, song.artist)
        norm_rel = f"processed/{s_slug}_norm.mp4"
        shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", project_root / norm_rel)
        song.normalized_path = norm_rel
        return False, True

    monkeypatch.setattr(server, "download_netease_for_song", fake_download_netease)
    monkeypatch.setattr(server, "preprocess_song", fake_preprocess_song)

    server._worker_netease_audio_batch(mode="video", quality="flac", force=False, missing_only=False)

    saved = load_playlist(isolated_env / "playlist.json")
    assert saved.output_sequence_name == "Edited During Batch"
    assert saved.songs[0].reason == "Concurrent S0 reason"
    assert saved.songs[0].file_path == f"raw/{slug('Track Zero', 'Art Zero')}.mp4"
    assert saved.songs[0].cover_path == f"covers/{slug('Track Zero', 'Art Zero')}.png"
    assert saved.songs[0].audio_path == f"audio/{slug('Track Zero', 'Art Zero')}.mp3"
    assert saved.songs[0].normalized_path == f"processed/{slug('Track Zero', 'Art Zero')}_norm.mp4"
    assert saved.songs[1].file_path == f"raw/{slug('Track One', 'Art One')}.mp4"
    assert saved.songs[1].normalized_path == f"processed/{slug('Track One', 'Art One')}_norm.mp4"


def test_worker_netease_audio_single_preserves_edits_and_reresolves_on_reorder(isolated_env, monkeypatch):
    from backend.download import slug
    from backend.schema import PlaylistConfig, SongItem, load_playlist, save_playlist

    pl = PlaylistConfig(
        output_sequence_name="NE Single Initial",
        songs=[
            SongItem(
                title="Song First",
                artist="Art A",
                netease_id="6001",
                reason="First reason",
            ),
            SongItem(
                title="Song Target",
                artist="Art B",
                netease_id="6002",
                reason="Before NE single",
            ),
        ],
    )
    save_playlist(pl, isolated_env / "playlist.json")

    preprocessed_titles = []

    def fake_download_netease(song, base_dir, mode="video", quality=None, force=True, width=1920, height=1080, fps=30, log_fn=None):
        s_slug = slug(song.title, song.artist)
        shutil.copyfile(FIXTURE_MEDIA_DIR / "sine-audio.mp3", base_dir / "audio" / f"{s_slug}.mp3")
        shutil.copyfile(FIXTURE_MEDIA_DIR / "cover.png", base_dir / "covers" / f"{s_slug}.png")
        shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", base_dir / "raw" / f"{s_slug}.mp4")
        song.audio_path = f"audio/{s_slug}.mp3"
        song.cover_path = f"covers/{s_slug}.png"
        song.file_path = f"raw/{s_slug}.mp4"

        concurrent = load_playlist(isolated_env / "playlist.json")
        concurrent.output_sequence_name = "Reordered Seq"
        concurrent.songs = [concurrent.songs[1], concurrent.songs[0]]
        concurrent.songs[0].reason = "Edited during NE single"
        save_playlist(concurrent, isolated_env / "playlist.json")
        return {"song_id": song.netease_id, "quality": "flac", "audio_path": song.audio_path, "video_path": song.file_path}

    def fake_preprocess_song(song, project_root, force=False, log_fn=None):
        preprocessed_titles.append(song.title)
        s_slug = slug(song.title, song.artist)
        norm_rel = f"processed/{s_slug}_norm.mp4"
        shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", project_root / norm_rel)
        song.normalized_path = norm_rel

        concurrent = load_playlist(isolated_env / "playlist.json")
        concurrent.songs[1].reason = "Edited during preprocess"
        save_playlist(concurrent, isolated_env / "playlist.json")
        return False, True

    monkeypatch.setattr(server, "download_netease_for_song", fake_download_netease)
    monkeypatch.setattr(server, "preprocess_song", fake_preprocess_song)

    key = server._make_song_key(pl.songs[1])
    server._worker_netease_audio_single(1, mode="video", quality="flac", force=True, song_key=key)

    assert preprocessed_titles == ["Song Target"]
    saved = load_playlist(isolated_env / "playlist.json")
    assert saved.output_sequence_name == "Reordered Seq"
    assert saved.songs[0].title == "Song Target"
    assert saved.songs[0].reason == "Edited during NE single"
    assert saved.songs[0].file_path == f"raw/{slug('Song Target', 'Art B')}.mp4"
    assert saved.songs[0].normalized_path == f"processed/{slug('Song Target', 'Art B')}_norm.mp4"
    assert saved.songs[1].title == "Song First"
    assert saved.songs[1].reason == "Edited during preprocess"
    assert saved.songs[1].normalized_path == ""


def test_worker_preprocess_preserves_concurrent_playlist_edits(isolated_env, monkeypatch):
    from backend.download import slug
    from backend.schema import PlaylistConfig, SongItem, load_playlist, save_playlist

    pl = PlaylistConfig(
        output_sequence_name="Prep Initial",
        songs=[
            SongItem(title="Prep Zero", artist="Art P0", netease_id="7001", reason="Initial P0"),
            SongItem(title="Prep One", artist="Art P1", netease_id="7002", start="0:00", end="0:10"),
        ],
    )
    save_playlist(pl, isolated_env / "playlist.json")

    def fake_preprocess_song(song, project_root, force=False, log_fn=None):
        s_slug = slug(song.title, song.artist)
        song.cover_path = f"covers/{s_slug}.png"
        song.normalized_path = f"processed/{s_slug}_norm.mp4"
        if song.netease_id == "7001":
            concurrent = load_playlist(isolated_env / "playlist.json")
            concurrent.output_sequence_name = "Concurrent Prep Seq"
            concurrent.songs[0].reason = "Updated during prep"
            concurrent.songs[1].start = "0:03.0"
            save_playlist(concurrent, isolated_env / "playlist.json")
        return True, True

    monkeypatch.setattr(server, "preprocess_song", fake_preprocess_song)

    server._worker_preprocess(force=False)

    saved = load_playlist(isolated_env / "playlist.json")
    assert saved.output_sequence_name == "Concurrent Prep Seq"
    assert saved.songs[0].reason == "Updated during prep"
    assert saved.songs[0].cover_path == f"covers/{slug('Prep Zero', 'Art P0')}.png"
    assert saved.songs[0].normalized_path == f"processed/{slug('Prep Zero', 'Art P0')}_norm.mp4"
    assert saved.songs[1].start == "0:03.0"
    assert saved.songs[1].normalized_path == f"processed/{slug('Prep One', 'Art P1')}_norm.mp4"


def test_worker_analyze_visuals_preserves_concurrent_playlist_edits(isolated_env, monkeypatch):
    from backend.download import slug
    from backend.schema import PlaylistConfig, SongItem, load_playlist, save_playlist

    pl = PlaylistConfig(
        output_sequence_name="Visual Initial",
        songs=[
            SongItem(title="Vis Zero", artist="Art V0", netease_id="8001", reason="Initial V0", start="0:00", end="0:12"),
            SongItem(title="Vis One", artist="Art V1", netease_id="8002", reason="Initial V1"),
        ],
    )
    save_playlist(pl, isolated_env / "playlist.json")

    def fake_fetch_lyrics(song, project_root, force=False, log=None):
        s_slug = slug(song.title, song.artist)
        lyrics_rel = f"lyrics/{s_slug}.json"
        (project_root / lyrics_rel).write_text("{}", encoding="utf-8")
        song.lyrics_path = lyrics_rel
        return project_root / lyrics_rel

    def fake_analyze_visuals(song, project_root, log=None):
        bright = {"index": True, "reason": False, "bottom": True}
        song.detected_bright = bright
        if song.netease_id == "8001":
            concurrent = load_playlist(isolated_env / "playlist.json")
            concurrent.output_sequence_name = "Concurrent Visual Seq"
            concurrent.songs[0].reason = "Updated during visuals"
            concurrent.songs[0].start = "0:04.5"
            save_playlist(concurrent, isolated_env / "playlist.json")
        return {"title": song.title, "bright": bright, "is_static": False, "mad": 5.0}

    monkeypatch.setattr(server, "fetch_and_save_lyrics", fake_fetch_lyrics)
    monkeypatch.setattr(server, "analyze_song_visuals", fake_analyze_visuals)

    server._worker_analyze_visuals()

    saved = load_playlist(isolated_env / "playlist.json")
    assert saved.output_sequence_name == "Concurrent Visual Seq"
    assert saved.songs[0].reason == "Updated during visuals"
    assert saved.songs[0].start == "0:04.5"
    assert saved.songs[0].lyrics_path == f"lyrics/{slug('Vis Zero', 'Art V0')}.json"
    assert saved.songs[0].detected_bright == {"index": True, "reason": False, "bottom": True}
    assert saved.songs[1].lyrics_path == f"lyrics/{slug('Vis One', 'Art V1')}.json"
    assert saved.songs[1].detected_bright == {"index": True, "reason": False, "bottom": True}
