"""Media preprocessing utilities: 1:1 cover extraction and -14 LUFS loudness normalization."""

from __future__ import annotations

from io import BytesIO
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

from PIL import Image, ImageOps
import requests

from backend.download import slug
from backend.netease import HEADERS as NETEASE_HEADERS, search_netease_cover_url
from backend.schema import SongItem


def find_ffmpeg() -> str | None:
    """Locate ffmpeg executable across Windows, macOS, and PATH."""
    env_path = os.environ.get("FFMPEG_PATH", "").strip()
    if env_path and Path(env_path).is_file():
        return env_path

    which_path = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    if which_path:
        return which_path

    for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        if Path(candidate).is_file():
            return candidate
    return None


def parse_time_str(value: str | float | int) -> float:
    """Parse 'MM:SS', 'HH:MM:SS', or numeric seconds into float seconds."""
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "0").strip()
    if not text:
        return 0.0
    parts = text.split(":")
    try:
        if len(parts) == 1:
            return float(parts[0])
        if len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
    except ValueError:
        return 0.0
    return 0.0


def fetch_netease_cover(
    song: SongItem,
    out_cover: Path,
    size: int = 600,
    force: bool = False,
) -> Path | None:
    """Fetch official album cover from NetEase Cloud Music and save as 1:1 PNG."""
    if not force and out_cover.is_file():
        return out_cover

    cover_url = (song.cover_url or "").strip()
    if not cover_url:
        cover_url = search_netease_cover_url(song.title, song.artist, song.album) or ""
        if cover_url:
            song.cover_url = cover_url

    if not cover_url:
        return None

    try:
        # Request high-res square image from NetEase CDN
        dl_url = f"{cover_url}?param={size}y{size}" if "?" not in cover_url else cover_url
        resp = requests.get(dl_url, headers=NETEASE_HEADERS, timeout=15)
        resp.raise_for_status()
        out_cover.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(BytesIO(resp.content)) as img:
            square = ImageOps.fit(
                img.convert("RGB"),
                (size, size),
                method=Image.Resampling.LANCZOS,
            )
            square.save(out_cover, format="PNG")
        return out_cover
    except Exception:
        return None


def extract_square_cover(
    video_path: Path,
    out_cover: Path,
    timestamp_sec: float = 5.0,
    size: int = 600,
    force: bool = False,
) -> Path | None:
    """Extract a video frame and center-crop it into a 1:1 square PNG cover."""
    if not force and out_cover.is_file():
        return out_cover

    ffmpeg = find_ffmpeg()
    if not ffmpeg or not video_path.is_file():
        return None

    out_cover.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp_jpg = Path(tmp.name)

    try:
        cmd = [
            ffmpeg,
            "-y",
            "-ss",
            f"{max(0.0, timestamp_sec):.2f}",
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(tmp_jpg),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not tmp_jpg.is_file():
            return None

        with Image.open(tmp_jpg) as img:
            square = ImageOps.fit(
                img.convert("RGB"),
                (size, size),
                method=Image.Resampling.LANCZOS,
            )
            square.save(out_cover, format="PNG")
        return out_cover
    finally:
        if tmp_jpg.is_file():
            try:
                tmp_jpg.unlink()
            except OSError:
                pass


def normalize_loudness(
    video_path: Path,
    out_video: Path,
    target_lufs: float = -14.0,
    force: bool = False,
) -> Path | None:
    """Normalize audio to EBU R128 (-14 LUFS, 48kHz stereo) while stream-copying video."""
    if not force and out_video.is_file():
        return out_video

    ffmpeg = find_ffmpeg()
    if not ffmpeg or not video_path.is_file():
        return None

    out_video.parent.mkdir(parents=True, exist_ok=True)
    tmp_out = out_video.with_suffix(".tmp.mp4")

    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(video_path),
        "-c:v",
        "copy",
        "-af",
        f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-c:a",
        "aac",
        "-b:a",
        "256k",
        str(tmp_out),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not tmp_out.is_file():
        if tmp_out.is_file():
            tmp_out.unlink(missing_ok=True)
        return None

    tmp_out.replace(out_video)
    return out_video


def normalized_video_name(song: SongItem) -> str:
    stem = slug(song.title, song.artist)
    if Path(song.file_path).name == f"{stem}_cover.mp4":
        stem += "_cover"
    return f"{stem}_norm.mp4"


def preprocess_song(
    song: SongItem,
    project_root: Path,
    force: bool = False,
    log_fn: Callable[[str], None] | None = None,
) -> tuple[bool, bool]:
    """Run cover extraction and loudness normalization for a single song.

    Returns (cover_updated, audio_normalized).
    """
    log = log_fn or (lambda _msg: None)
    base_slug = slug(song.title, song.artist)
    cover_out = project_root / "covers" / f"{base_slug}.png"
    norm_out = project_root / "processed" / normalized_video_name(song)

    cover_ok = False
    if force or not song.cover_path or not (project_root / song.cover_path).is_file():
        res_cover = fetch_netease_cover(song, cover_out, force=force)
        if res_cover:
            song.cover_path = cover_out.relative_to(project_root).as_posix()
            cover_ok = True
            log(f"✓ 网易云官方封面已下载 (1:1): {song.cover_path}")
        else:
            log(f"✗ 未在网易云匹配到封面（可后续手动指定）: {song.title}")

    raw_rel = song.file_path.strip()
    if not raw_rel:
        log(f"跳过响度统一（无本地视频）: {song.title}")
        return cover_ok, False

    raw_path = (
        Path(raw_rel)
        if Path(raw_rel).is_absolute()
        else (project_root / raw_rel)
    )
    if not raw_path.is_file():
        log(f"跳过响度统一（文件不存在）: {raw_path}")
        return cover_ok, False

    norm_ok = False
    res_norm = normalize_loudness(raw_path, norm_out, force=force)
    if res_norm:
        song.normalized_path = norm_out.relative_to(project_root).as_posix()
        norm_ok = True
        log(f"✓ 响度已统一 (-14 LUFS): {song.normalized_path}")
    else:
        log(f"✗ 响度统一失败: {song.title}")

    return cover_ok, norm_ok
