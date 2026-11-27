import json
import shutil
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

import server
from backend.schema import PlaylistConfig, SongItem, save_playlist


FIXTURE_MEDIA_DIR = Path(__file__).resolve().parent / "fixtures" / "media"


@pytest.fixture
def isolated_env(tmp_path, monkeypatch):
    for d in ("raw", "processed", "covers", "lyrics", "audio", "output"):
        (tmp_path / d).mkdir(parents=True, exist_ok=True)

    playlist_path = tmp_path / "playlist.json"
    cookies_path = tmp_path / "cookies.txt"

    monkeypatch.setattr(server, "BASE_DIR", str(tmp_path))
    monkeypatch.setattr(server, "BASE_PATH", tmp_path)
    monkeypatch.setattr(server, "PLAYLIST_FILE", str(playlist_path))
    monkeypatch.setattr(server, "BILI_COOKIES_FILE", str(cookies_path))
    monkeypatch.setattr(server, "COVERS_DIR", str(tmp_path / "covers"))
    monkeypatch.setattr(server, "RAW_DIR", str(tmp_path / "raw"))
    monkeypatch.setattr(server, "_remotion_studio_proc", None)
    monkeypatch.setattr(server, "_remotion_render_proc", None)
    monkeypatch.setattr(server, "_remotion_render_cancelled", False)

    covers_dir = str(tmp_path / "covers")
    for route in server.app.routes:
        if getattr(route, "path", None) == "/covers" and hasattr(route, "app"):
            monkeypatch.setattr(route.app, "directory", covers_dir)
            monkeypatch.setattr(route.app, "all_directories", [covers_dir])

    import backend.download as dl_mod
    monkeypatch.setattr(dl_mod, "BASE_DIR", str(tmp_path))
    monkeypatch.setattr(dl_mod, "RAW_DIR", str(tmp_path / "raw"))

    with server.task_lock:
        server.tasks_state["is_downloading"] = False
        server.tasks_state["is_rendering"] = False
        server.tasks_state["queue_count"] = 0
        server.tasks_state["current_song"] = ""
        server.tasks_state["logs"] = []
        server.tasks_state["progress_percent"] = 0

    return tmp_path


@pytest.fixture
def seeded_playlist(isolated_env):
    video_src = FIXTURE_MEDIA_DIR / "color-video.mp4"
    cover_src = FIXTURE_MEDIA_DIR / "cover.png"
    audio_src = FIXTURE_MEDIA_DIR / "sine-audio.mp3"

    shutil.copyfile(video_src, isolated_env / "raw" / "song_a.mp4")
    shutil.copyfile(video_src, isolated_env / "processed" / "song_a_norm.mp4")
    shutil.copyfile(cover_src, isolated_env / "covers" / "song_a.png")
    shutil.copyfile(audio_src, isolated_env / "audio" / "song_a.mp3")
    (isolated_env / "lyrics" / "song_a.json").write_text(
        json.dumps(
            {
                "lines": [
                    {"time": 1.0, "orig": "First line original", "trans": "第一行翻译"},
                    {"time": 4.5, "orig": "Second line original", "trans": "第二行翻译"},
                ],
                "has_translation": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    pl = PlaylistConfig(
        output_sequence_name="Test Seq",
        songs=[
            SongItem(
                title="Song A",
                artist="Artist A",
                album="Album A",
                netease_id="1001",
                youtube_url="https://www.bilibili.com/video/BV1testA",
                media_source="video_url",
                start="0:01.0",
                end="0:05.0",
                file_path="raw/song_a.mp4",
                normalized_path="processed/song_a_norm.mp4",
                cover_path="covers/song_a.png",
                audio_path="audio/song_a.mp3",
                lyrics_path="lyrics/song_a.json",
                reason="Line one\n\nLine two",
                reason_mode="manual",
                reason_timings=[0.0, 2.0],
            ),
            SongItem(
                title="Song B",
                artist="Artist B",
                netease_id="1002",
                start="0:00",
                end="0:15",
            ),
        ],
    )
    save_playlist(pl, isolated_env / "playlist.json")
    return isolated_env


@pytest.fixture
def client(seeded_playlist):
    return TestClient(server.app)
