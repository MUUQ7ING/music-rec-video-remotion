import json
import os
import shutil
import struct
import subprocess
from pathlib import Path
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
