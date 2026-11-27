import json
import threading
from backend.schema import (
    IntroConfig,
    PlaylistConfig,
    RUNTIME_SONG_FIELDS,
    SongClip,
    SongItem,
    TransitionConfig,
    load_playlist,
    save_playlist,
)


def test_load_missing_returns_defaults(tmp_path):
    pl = load_playlist(tmp_path / "nonexistent.json")
    assert pl.fps == 60
    assert pl.resolution.width == 1920
    assert pl.resolution.height == 1080
    assert pl.songs == []
    assert pl.intro.enabled is False
    assert pl.transition.video_style == "cross_dissolve"


def test_strip_runtime_fields_on_save(tmp_path):
    target = tmp_path / "playlist.json"
    raw = {
        "output_sequence_name": "CleanTest",
        "songs": [
            {
                "title": "Track 1",
                "artist": "Art 1",
                "has_file": True,
                "file_size_mb": 42.5,
                "has_cover": True,
                "has_normalized": True,
                "has_lyrics": True,
                "has_audio": True,
                "audio_size_mb": 9.1,
            }
        ],
    }
    save_playlist(raw, target)
    persisted = json.loads(target.read_text(encoding="utf-8"))
    song = persisted["songs"][0]
    for k in RUNTIME_SONG_FIELDS:
        assert k not in song


def test_multi_clip_and_reason_modes_roundtrip(tmp_path):
    target = tmp_path / "playlist.json"
    pl = PlaylistConfig(
        output_sequence_name="MultiClip",
        intro=IntroConfig(enabled=True, text="Page 1\n\nPage 2", auto_duration=False, duration=12.5, bg_mode="blur_first_song"),
        transition=TransitionConfig(video_style="light_leak", video_duration=0.8, audio_duration=1.0),
        songs=[
            SongItem(
                title="Drop Song",
                artist="DJ",
                clips=[
                    SongClip(start="0:10.0", end="0:25.5", reason="P1\n\nP2", reason_mode="manual", reason_timings=[0.0, 7.5]),
                    SongClip(start="1:05.0", end="1:20.0", reason="Second drop", reason_mode="auto"),
                ],
                visual_effect="vinyl_spin",
                visual_modifiers=["beat_pulse", "glitch"],
                transition_style="whip_pan",
            )
        ],
    )
    save_playlist(pl, target)
    loaded = load_playlist(target)
    assert loaded.intro.enabled is True
    assert loaded.intro.duration == 12.5
    assert loaded.transition.video_style == "light_leak"
    assert len(loaded.songs[0].clips) == 2
    assert loaded.songs[0].clips[0].reason_timings == [0.0, 7.5]
    assert loaded.songs[0].visual_modifiers == ["beat_pulse", "glitch"]


def test_concurrent_atomic_saves_never_corrupt(tmp_path):
    target = tmp_path / "playlist.json"
    errors = []

    def writer(n):
        try:
            for i in range(15):
                pl = PlaylistConfig(
                    output_sequence_name=f"W{n}-{i}",
                    songs=[SongItem(title=f"T{n}_{i}", artist="A")],
                )
                save_playlist(pl, target)
                loaded = load_playlist(target)
                assert loaded.output_sequence_name.startswith("W")
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=writer, args=(k,)) for k in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    final = load_playlist(target)
    assert len(final.songs) == 1
