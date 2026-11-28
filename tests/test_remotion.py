import copy
import json
import os
import shutil
import struct
import subprocess
from pathlib import Path
from PIL import Image, ImageChops
import pytest

from backend.schema import (
    IntroConfig,
    PlaylistConfig,
    RUNTIME_SONG_FIELDS,
    ResolutionConfig,
    SongItem,
    TransitionConfig,
    save_playlist,
)


BASE_PATH = Path(__file__).resolve().parent.parent
REMOTION_DIR = BASE_PATH / "remotion"
FIXTURE_MEDIA_DIR = Path(__file__).resolve().parent / "fixtures" / "media"


def _node_env():
    env = os.environ.copy()
    extra = ["/opt/homebrew/bin", "/usr/local/bin"]
    cur = env.get("PATH", "")
    cur_parts = [p for p in cur.split(os.pathsep) if p]
    missing = [p for p in extra if p not in cur_parts]
    if missing:
        env["PATH"] = os.pathsep.join(missing + cur_parts)
    return env


def _tsc_command(project_dir: Path, env: dict[str, str]):
    exe = "tsc.cmd" if os.name == "nt" else "tsc"
    for candidate in (
        project_dir / "node_modules" / ".bin" / exe,
        REMOTION_DIR / "node_modules" / ".bin" / exe,
    ):
        if candidate.is_file():
            return [str(candidate), "--noEmit"]
    which_tsc = shutil.which("tsc", path=env["PATH"])
    if which_tsc:
        return [which_tsc, "--noEmit"]
    npx_name = "npx.cmd" if os.name == "nt" else "npx"
    npx = shutil.which(npx_name, path=env["PATH"])
    if npx:
        return [npx, "tsc", "--noEmit"]
    return None


def _snapshot_real_dirs():
    snap = {}
    pl_file = BASE_PATH / "playlist.json"
    if pl_file.exists():
        st = pl_file.stat()
        snap["playlist.json"] = (st.st_mtime_ns, st.st_size)
    else:
        snap["playlist.json"] = None
    for name in ("raw", "processed", "covers"):
        d = BASE_PATH / name
        if d.is_dir():
            snap[name] = sorted(
                (p.name, p.stat().st_mtime_ns, p.stat().st_size)
                for p in d.iterdir()
                if not p.name.startswith(".")
            )
        else:
            snap[name] = None
    return snap


def _prepare_isolated_remotion_workspace(tmp_path: Path):
    public_dir = tmp_path / "public"
    for sub in ("raw", "processed", "covers", "lyrics", "audio"):
        (public_dir / sub).mkdir(parents=True, exist_ok=True)

    shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", public_dir / "raw" / "smoke_fixture.mp4")
    shutil.copyfile(FIXTURE_MEDIA_DIR / "color-video.mp4", public_dir / "processed" / "smoke_fixture_norm.mp4")
    shutil.copyfile(FIXTURE_MEDIA_DIR / "cover.png", public_dir / "covers" / "smoke_fixture.png")
    shutil.copyfile(FIXTURE_MEDIA_DIR / "sine-audio.mp3", public_dir / "audio" / "smoke_fixture.mp3")
    (public_dir / "lyrics" / "smoke_fixture.json").write_text(
        json.dumps(
            {
                "lines": [
                    {"time": 0.5, "orig": "First line original", "trans": "第一行翻译"},
                    {"time": 1.2, "orig": "Second line original", "trans": "第二行翻译"},
                ],
                "has_translation": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    pl = PlaylistConfig(
        output_sequence_name="Isolated Smoke",
        resolution=ResolutionConfig(width=1920, height=1080),
        fps=60,
        intro=IntroConfig(enabled=False, text="", auto_duration=True, duration=8.0, bg_mode="black", bg_image=""),
        transition=TransitionConfig(video_style="cross_dissolve", video_duration=0.6, audio_duration=0.8),
        songs=[
            SongItem(
                title="Isolated Smoke Song",
                artist="Smoke Artist",
                album="Smoke Album",
                media_source="video_url",
                start="0:00",
                end="0:03",
                file_path="raw/smoke_fixture.mp4",
                normalized_path="processed/smoke_fixture_norm.mp4",
                cover_path="covers/smoke_fixture.png",
                audio_path="audio/smoke_fixture.mp3",
                lyrics_path="lyrics/smoke_fixture.json",
                lyrics_enabled=True,
                reason="Line one\n\nLine two",
                reason_mode="auto",
                visual_effect="auto",
                visual_modifiers=["beat_pulse"],
            )
        ],
    )
    saved_playlist_path = save_playlist(pl, tmp_path / "playlist.json")
    saved_payload = json.loads(saved_playlist_path.read_text(encoding="utf-8"))
    props_file = tmp_path / "props.json"
    props_file.write_text(json.dumps({"playlist": saved_payload}, ensure_ascii=False), encoding="utf-8")
    return props_file, public_dir, saved_payload


def test_frontend_app_js_syntax():
    env = _node_env()
    web_dir = BASE_PATH / "web"
    pkg_file = web_dir / "package.json"
    if pkg_file.is_file():
        pkg = json.loads(pkg_file.read_text(encoding="utf-8"))
        scripts = pkg.get("scripts")
        assert isinstance(scripts, dict) and scripts.get("build")
        if (web_dir / "tsconfig.json").is_file():
            if not (web_dir / "node_modules").exists():
                pytest.skip("web/node_modules not installed")
            cmd = _tsc_command(web_dir, env)
            if not cmd:
                pytest.skip("tsc not found")
            res = subprocess.run(cmd, cwd=str(web_dir), capture_output=True, text=True, env=env, timeout=60)
            assert res.returncode == 0, res.stdout + res.stderr
        else:
            assert (web_dir / "index.html").is_file()
        return

    node = shutil.which("node", path=env["PATH"])
    if not node:
        pytest.skip("node not found")
    res = subprocess.run([node, "--check", str(web_dir / "app.js")], capture_output=True, text=True, env=env, timeout=60)
    assert res.returncode == 0, res.stderr


def test_remotion_typescript_typecheck():
    if not (REMOTION_DIR / "node_modules").exists():
        pytest.skip("remotion/node_modules not installed")
    env = _node_env()
    cmd = _tsc_command(REMOTION_DIR, env)
    if not cmd:
        pytest.skip("tsc not found")
    res = subprocess.run(cmd, cwd=str(REMOTION_DIR), capture_output=True, text=True, env=env, timeout=60)
    assert res.returncode == 0, res.stdout + res.stderr


def test_remotion_isolated_props_match_schema(tmp_path):
    props_file, public_dir, saved_payload = _prepare_isolated_remotion_workspace(tmp_path)
    props = json.loads(props_file.read_text(encoding="utf-8"))
    assert "playlist" in props
    assert props["playlist"] == saved_payload
    song = props["playlist"]["songs"][0]
    for field in RUNTIME_SONG_FIELDS:
        assert field not in song
    for key in ("file_path", "normalized_path", "cover_path", "audio_path", "lyrics_path"):
        assert (public_dir / song[key]).is_file()


@pytest.mark.slow
def test_remotion_still_frame_smoke(tmp_path):
    if not (REMOTION_DIR / "node_modules").exists():
        pytest.skip("remotion/node_modules not installed")
    env = _node_env()
    npx_name = "npx.cmd" if os.name == "nt" else "npx"
    npx = shutil.which(npx_name, path=env["PATH"])
    if not npx:
        pytest.skip("npx not found")

    before_snap = _snapshot_real_dirs()
    props_file, public_dir, _ = _prepare_isolated_remotion_workspace(tmp_path)
    out_png = tmp_path / "still_smoke.png"
    res = subprocess.run(
        [
            npx,
            "remotion",
            "still",
            "src/index.ts",
            "MusicRecVideo",
            str(out_png),
            "--frame=90",
            f"--props={props_file}",
            f"--public-dir={public_dir}",
        ],
        cwd=str(REMOTION_DIR),
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    after_snap = _snapshot_real_dirs()
    assert after_snap == before_snap
    assert res.returncode == 0, res.stdout + res.stderr
    assert out_png.is_file()
    png_bytes = out_png.read_bytes()
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(png_bytes) > 5000
    assert struct.unpack(">II", png_bytes[16:24]) == (1920, 1080)


def _render_remotion_still(
    npx: str,
    env: dict[str, str],
    props_file: Path,
    public_dir: Path,
    out_png: Path,
    frame: int,
):
    res = subprocess.run(
        [
            npx,
            "remotion",
            "still",
            "src/index.ts",
            "MusicRecVideo",
            str(out_png),
            f"--frame={frame}",
            f"--props={props_file}",
            f"--public-dir={public_dir}",
        ],
        cwd=str(REMOTION_DIR),
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    assert res.returncode == 0, res.stdout + res.stderr
    assert out_png.is_file()
    png_bytes = out_png.read_bytes()
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(png_bytes) > 5000
    assert struct.unpack(">II", png_bytes[16:24]) == (1920, 1080)
    return out_png


def _pixel_diff_ratio(png_a: Path, png_b: Path) -> float:
    with Image.open(png_a).convert("RGB") as img_a, Image.open(png_b).convert("RGB") as img_b:
        assert img_a.size == img_b.size
        gray = ImageChops.difference(img_a, img_b).convert("L")
        changed = sum(1 for v in gray.tobytes() if v > 4)
        return changed / (img_a.size[0] * img_a.size[1])


@pytest.mark.slow
def test_remotion_differential_props_rendering(tmp_path):
    if not (REMOTION_DIR / "node_modules").exists():
        pytest.skip("remotion/node_modules not installed")
    env = _node_env()
    npx_name = "npx.cmd" if os.name == "nt" else "npx"
    npx = shutil.which(npx_name, path=env["PATH"])
    if not npx:
        pytest.skip("npx not found")

    before_snap = _snapshot_real_dirs()
    _, public_dir, base_payload = _prepare_isolated_remotion_workspace(tmp_path)
    Image.new("RGB", (128, 128), (220, 110, 30)).save(public_dir / "covers" / "intro_bg.png")

    def write_props(name: str, payload: dict) -> Path:
        p = tmp_path / f"props_{name}.json"
        p.write_text(json.dumps({"playlist": payload}, ensure_ascii=False), encoding="utf-8")
        return p

    base_png = _render_remotion_still(
        npx, env, write_props("base", base_payload), public_dir, tmp_path / "base.png", 90
    )

    intro_black = copy.deepcopy(base_payload)
    intro_black["intro"] = {
        "enabled": True,
        "text": "Welcome Intro",
        "auto_duration": False,
        "duration": 3.0,
        "bg_mode": "black",
        "bg_image": "",
    }
    intro_blur = copy.deepcopy(intro_black)
    intro_blur["intro"]["bg_mode"] = "blur_first_song"
    intro_image = copy.deepcopy(intro_black)
    intro_image["intro"]["bg_mode"] = "image"
    intro_image["intro"]["bg_image"] = "covers/intro_bg.png"

    intro_black_png = _render_remotion_still(
        npx, env, write_props("intro_black", intro_black), public_dir, tmp_path / "intro_black.png", 60
    )
    intro_blur_png = _render_remotion_still(
        npx, env, write_props("intro_blur", intro_blur), public_dir, tmp_path / "intro_blur.png", 60
    )
    intro_image_png = _render_remotion_still(
        npx, env, write_props("intro_image", intro_image), public_dir, tmp_path / "intro_image.png", 60
    )
    assert _pixel_diff_ratio(intro_black_png, intro_blur_png) > 0.01
    assert _pixel_diff_ratio(intro_black_png, intro_image_png) > 0.01
    assert _pixel_diff_ratio(intro_blur_png, intro_image_png) > 0.01

    vinyl_payload = copy.deepcopy(base_payload)
    vinyl_payload["songs"][0]["visual_effect"] = "vinyl_spin"
    vinyl_png = _render_remotion_still(
        npx, env, write_props("vinyl", vinyl_payload), public_dir, tmp_path / "vinyl.png", 90
    )

    lyric_stage_payload = copy.deepcopy(base_payload)
    lyric_stage_payload["songs"][0]["visual_effect"] = "lyric_stage"
    lyric_stage_png = _render_remotion_still(
        npx, env, write_props("lyric_stage", lyric_stage_payload), public_dir, tmp_path / "lyric_stage.png", 90
    )

    assert _pixel_diff_ratio(base_png, vinyl_png) > 0.05
    assert _pixel_diff_ratio(base_png, lyric_stage_png) > 0.05
    assert _pixel_diff_ratio(vinyl_png, lyric_stage_png) > 0.05

    no_lyrics_payload = copy.deepcopy(base_payload)
    no_lyrics_payload["songs"][0]["lyrics_enabled"] = False
    no_lyrics_png = _render_remotion_still(
        npx, env, write_props("no_lyrics", no_lyrics_payload), public_dir, tmp_path / "no_lyrics.png", 90
    )
    assert _pixel_diff_ratio(base_png, no_lyrics_png) > 0.001

    shadow_strong_payload = copy.deepcopy(base_payload)
    shadow_strong_payload["songs"][0]["shadow_boost"] = "strong"
    shadow_strong_png = _render_remotion_still(
        npx, env, write_props("shadow_strong", shadow_strong_payload), public_dir, tmp_path / "shadow_strong.png", 90
    )
    assert _pixel_diff_ratio(base_png, shadow_strong_png) > 0.005

    meta_payload = copy.deepcopy(base_payload)
    meta_payload["songs"][0]["title"] = "Changed Track Title"
    meta_payload["songs"][0]["artist"] = "Changed Track Artist"
    meta_payload["songs"][0]["reason"] = "Updated Recommendation Copy"
    meta_png = _render_remotion_still(
        npx, env, write_props("meta", meta_payload), public_dir, tmp_path / "meta.png", 90
    )
    assert _pixel_diff_ratio(base_png, meta_png) > 0.002

    multi_a = copy.deepcopy(base_payload)
    multi_a["songs"][0]["clips"] = [
        {"start": "0:00", "end": "0:02", "reason": "First Song Clip", "reason_mode": "auto", "reason_timings": []}
    ]
    song_two = copy.deepcopy(base_payload["songs"][0])
    song_two["title"] = "Second Track"
    song_two["artist"] = "Second Artist"
    song_two["start"] = "0:00"
    song_two["end"] = "0:03"
    song_two["reason"] = "Second Song Reason Alpha"
    song_two["clips"] = []
    multi_a["songs"].append(song_two)

    multi_b = copy.deepcopy(multi_a)
    multi_b["songs"][1]["reason"] = "Second Song Reason Beta"

    multi_c = copy.deepcopy(multi_a)
    multi_c["songs"][0]["clips"][0]["end"] = "0:05"

    multi_a_png = _render_remotion_still(
        npx, env, write_props("multi_a", multi_a), public_dir, tmp_path / "multi_a.png", 180
    )
    multi_b_png = _render_remotion_still(
        npx, env, write_props("multi_b", multi_b), public_dir, tmp_path / "multi_b.png", 180
    )
    multi_c_png = _render_remotion_still(
        npx, env, write_props("multi_c", multi_c), public_dir, tmp_path / "multi_c.png", 180
    )
    assert _pixel_diff_ratio(multi_a_png, multi_b_png) > 0.001
    assert _pixel_diff_ratio(multi_a_png, multi_c_png) > 0.002

    after_snap = _snapshot_real_dirs()
    assert after_snap == before_snap
