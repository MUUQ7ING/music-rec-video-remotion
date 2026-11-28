"""Unified playlist schema and load/save helpers for music-rec-video."""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


DEFAULT_PLAYLIST_PATH = Path(__file__).resolve().parent.parent / "playlist.json"

_PLAYLIST_IO_LOCK = threading.RLock()

# Runtime-only status fields injected by GET /api/playlist; never persist to disk.
RUNTIME_SONG_FIELDS = frozenset({
    "has_file",
    "file_size_mb",
    "has_cover",
    "has_normalized",
    "has_pre_rendered",
    "has_lyrics",
    "has_beat",
    "has_audio",
    "audio_size_mb",
})


class ResolutionConfig(BaseModel):
    """Output sequence resolution."""

    model_config = ConfigDict(extra="allow")

    width: int = 1920
    height: int = 1080


class IntroConfig(BaseModel):
    """Optional opening monologue/intro card before the first song."""

    model_config = ConfigDict(extra="allow")

    enabled: bool = False
    text: str = ""
    auto_duration: bool = True
    duration: float = 8.0
    bg_mode: Literal["black", "blur_first_song", "image"] = "black"
    bg_image: str = ""


class TransitionConfig(BaseModel):
    """Song-to-song transition settings."""

    model_config = ConfigDict(extra="allow")

    video_style: str = "cross_dissolve"  # cross_dissolve | blur_slide | zoom_blur | cross_zoom | dip_to_black | flash_white | slide | wipe | flip | none
    video_duration: float = 0.6
    audio_duration: float = 0.8


class SongClip(BaseModel):
    """A sub-segment within a single song (for multi-drop/multi-part showcases)."""

    model_config = ConfigDict(extra="allow")

    start: str = "0:00"
    end: str = "0:30"
    reason: str = ""
    reason_mode: Literal["auto", "manual"] = "auto"
    reason_timings: list[float] = Field(default_factory=list)
    visual_effect: str | None = None
    visual_modifiers: list[str] | None = None


class SongItem(BaseModel):
    """Single song entry in the playlist."""

    model_config = ConfigDict(extra="allow")

    title: str
    artist: str
    album: str = ""
    netease_id: str = ""
    youtube_url: str = ""
    media_source: Literal["auto", "video_url", "netease_cover", "local"] = "auto"
    start: str = "0:00"
    end: str = "0:30"
    clips: list[SongClip] = Field(default_factory=list)
    file_path: str = ""
    audio_path: str = ""
    normalized_path: str = ""
    cover_url: str = ""
    cover_path: str = ""
    reason: str = ""
    reason_mode: Literal["auto", "manual"] = "auto"
    reason_timings: list[float] = Field(default_factory=list)
    transition_style: str = "inherit"
    visual_effect: str = "auto"
    visual_modifiers: list[str] = Field(default_factory=list)
    display_index: Optional[int] = None
    # Lyrics settings
    lyrics_path: str = ""
    lyrics_offset: float = 0.0
    lyrics_enabled: bool = True
    # Dynamic shadow contrast (always white text + boosted dark shadow on bright backgrounds)
    shadow_boost: Literal["auto", "normal", "strong"] = "auto"
    detected_bright: dict = Field(default_factory=dict)


class PlaylistConfig(BaseModel):
    """Root playlist configuration."""

    model_config = ConfigDict(extra="allow")

    output_sequence_name: str = "音乐推荐合辑"
    resolution: ResolutionConfig = Field(default_factory=ResolutionConfig)
    fps: int = 60
    intro: IntroConfig = Field(default_factory=IntroConfig)
    transition: TransitionConfig = Field(default_factory=TransitionConfig)
    songs: list[SongItem] = Field(default_factory=list)


def _strip_runtime_song_fields(data: dict) -> dict:
    """Return a shallow copy of playlist data with runtime-only song fields removed."""
    songs = data.get("songs")
    if isinstance(songs, list):
        cleaned_songs = []
        for song in songs:
            if isinstance(song, dict):
                cleaned_songs.append(
                    {k: v for k, v in song.items() if k not in RUNTIME_SONG_FIELDS}
                )
            else:
                cleaned_songs.append(song)
        data = {**data, "songs": cleaned_songs}
    return data


def load_playlist(path: Path | str = DEFAULT_PLAYLIST_PATH) -> PlaylistConfig:
    """Load and validate playlist.json, filling defaults for missing fields."""
    target = Path(path)
    with _PLAYLIST_IO_LOCK:
        if not target.exists():
            return PlaylistConfig()
        raw = json.loads(target.read_text(encoding="utf-8"))
        return PlaylistConfig.model_validate(raw)


def save_playlist(
    playlist: PlaylistConfig | dict,
    path: Path | str = DEFAULT_PLAYLIST_PATH,
) -> Path:
    """Persist playlist configuration atomically as formatted UTF-8 JSON."""
    target = Path(path)
    if isinstance(playlist, PlaylistConfig):
        raw_data = playlist.model_dump(exclude_none=True)
    else:
        raw_data = PlaylistConfig.model_validate(playlist).model_dump(exclude_none=True)
    cleaned_data = _strip_runtime_song_fields(raw_data)
    payload = json.dumps(cleaned_data, ensure_ascii=False, indent=2) + "\n"

    with _PLAYLIST_IO_LOCK:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{target.name}.",
            suffix=".tmp",
            dir=str(target.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_name, target)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
    return target
