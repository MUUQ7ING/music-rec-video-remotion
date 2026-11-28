"""
netease_audio.py — Download NetEase Cloud Music audio via custom LX Music source API
and optionally compose a 1080p album-cover MP4 for Premiere Pro workflows.

Usage:
    python netease_audio.py --id 186016 --quality flac
    python netease_audio.py --playlist --mode video --quality flac
    python netease_audio.py --playlist --only "Our Love Is Alive" --mode audio
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps
import requests

from backend.download import RAW_DIR, slug, to_relative_path
from backend.netease import search_netease_song_id
from backend.preprocess import fetch_netease_cover, find_ffmpeg
from backend.schema import DEFAULT_PLAYLIST_PATH, SongItem, load_playlist, save_playlist

BASE_DIR = Path(__file__).resolve().parent.parent
AUDIO_DIR = BASE_DIR / "audio"
CONFIG_FILE = BASE_DIR / "music_source_config.json"

SUPPORTED_WY_QUALITIES = [
    "master",
    "atmos",
    "hires",
    "flac24bit",
    "flac",
    "320k",
    "128k",
]

DEFAULT_QUALITY = "flac"
REQUEST_USER_AGENT = "lx-music-request/2.0.0"

_CONTENT_TYPE_EXT = {
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
}


def mask_api_key(key: str) -> str:
    """Return a safely masked API key for UI display."""
    k = (key or "").strip()
    if not k:
        return ""
    if len(k) <= 10:
        return "*" * len(k)
    return f"{k[:6]}{'*' * (len(k) - 10)}{k[-4:]}"


def parse_lx_script_text(script_text: str) -> dict:
    """Extract API_URL and API_KEY from either a JSON config or an LX Music custom source .js file."""
    text = (script_text or "").strip()
    if not text:
        return {}

    # 1. Try JSON format first (e.g. {"api_url": "...", "api_key": "..."})
    if text.startswith("{"):
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                result: dict = {}
                url_val = data.get("api_url") or data.get("API_URL") or data.get("url")
                key_val = data.get("api_key") or data.get("API_KEY") or data.get("key")
                quality_val = data.get("default_quality") or data.get("quality")
                if isinstance(url_val, str) and url_val.strip():
                    result["api_url"] = url_val.strip().rstrip("/")
                if isinstance(key_val, str) and key_val.strip():
                    result["api_key"] = key_val.strip()
                if isinstance(quality_val, str) and quality_val.strip():
                    result["default_quality"] = quality_val.strip()
                if result:
                    return result
        except Exception:
            pass

    # 2. Fallback to LX Music .js script regex extraction
    url_match = re.search(r"""API_URL\s*=\s*["']([^"']+)["']""", text)
    key_match = re.search(r"""API_KEY\s*=\s*["']([^"']+)["']""", text)
    result = {}
    if url_match:
        result["api_url"] = url_match.group(1).strip().rstrip("/")
    if key_match:
        result["api_key"] = key_match.group(1).strip()
    return result


def load_music_source_config(config_path: Path = CONFIG_FILE) -> dict:
    """Load custom music source config from local JSON file with env var overrides."""
    cfg = {
        "api_url": "",
        "api_key": "",
        "default_quality": DEFAULT_QUALITY,
    }
    if config_path.is_file():
        try:
            raw = json.loads(config_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                cfg["api_url"] = str(raw.get("api_url") or "").strip().rstrip("/")
                cfg["api_key"] = str(raw.get("api_key") or "").strip()
                dq = str(raw.get("default_quality") or DEFAULT_QUALITY).strip()
                if dq in SUPPORTED_WY_QUALITIES:
                    cfg["default_quality"] = dq
        except Exception:
            pass

    env_url = os.environ.get("IKUN_API_URL", "").strip().rstrip("/")
    env_key = os.environ.get("IKUN_API_KEY", "").strip()
    if env_url:
        cfg["api_url"] = env_url
    if env_key:
        cfg["api_key"] = env_key
    return cfg


def save_music_source_config(
    api_url: str | None = None,
    api_key: str | None = None,
    default_quality: str | None = None,
    config_path: Path = CONFIG_FILE,
) -> dict:
    """Persist music source configuration to gitignored local JSON file."""
    current = load_music_source_config(config_path)
    if api_url is not None and api_url.strip():
        current["api_url"] = api_url.strip().rstrip("/")
    if api_key is not None and api_key.strip():
        current["api_key"] = api_key.strip()
    if default_quality is not None and default_quality.strip() in SUPPORTED_WY_QUALITIES:
        current["default_quality"] = default_quality.strip()

    config_path.write_text(
        json.dumps(current, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return current


def get_music_source_status(config_path: Path = CONFIG_FILE) -> dict:
    """Return non-sensitive config status for the Web Studio UI."""
    cfg = load_music_source_config(config_path)
    return {
        "configured": bool(cfg["api_url"] and cfg["api_key"]),
        "api_url": cfg["api_url"],
        "api_key_masked": mask_api_key(cfg["api_key"]),
        "default_quality": cfg["default_quality"],
        "qualities": SUPPORTED_WY_QUALITIES,
    }


def _quality_candidates(requested: str, auto_fallback: bool) -> list[str]:
    """Build ordered list of qualities from requested down to 128k."""
    q = (requested or DEFAULT_QUALITY).strip().lower()
    if q not in SUPPORTED_WY_QUALITIES:
        q = DEFAULT_QUALITY
    if not auto_fallback:
        return [q]
    start_idx = SUPPORTED_WY_QUALITIES.index(q)
    return SUPPORTED_WY_QUALITIES[start_idx:]


def fetch_netease_audio_url(
    song_id: int | str,
    quality: str = DEFAULT_QUALITY,
    auto_fallback: bool = True,
    config: dict | None = None,
    log_fn: Callable[[str], None] | None = None,
) -> tuple[str, str]:
    """
    Request a direct NetEase Cloud Music audio URL from the configured custom source API.
    Returns (audio_url, actual_quality).
    """
    log = log_fn or print
    cfg = config or load_music_source_config()
    api_url = (cfg.get("api_url") or "").strip().rstrip("/")
    api_key = (cfg.get("api_key") or "").strip()
    if not api_url or not api_key:
        raise RuntimeError(
            "未配置网易云音源 API，请在 Web 端「网易云音源」设置中配置 API_URL 与 API_KEY"
        )

    endpoint = f"{api_url}/music/url"
    headers = {
        "Content-Type": "application/json",
        "User-Agent": REQUEST_USER_AGENT,
        "X-Api-Key": api_key,
    }

    last_error = "获取音频直链失败"
    candidates = _quality_candidates(quality, auto_fallback=auto_fallback)

    for q in candidates:
        for attempt in range(2):
            try:
                resp = requests.post(
                    endpoint,
                    headers=headers,
                    json={
                        "source": "wy",
                        "musicId": str(song_id),
                        "quality": q,
                    },
                    timeout=30,
                    allow_redirects=True,
                )
                body = resp.json()
            except Exception as err:
                last_error = f"请求音源接口失败: {err}"
                if attempt == 0:
                    time.sleep(1.5)
                    continue
                break

            code = body.get("code")
            try:
                code_num = int(code)
            except (TypeError, ValueError):
                last_error = f"音源返回异常响应: {body}"
                break

            if code_num == 200 and body.get("url"):
                return str(body["url"]).strip(), q
            if code_num == 403:
                raise RuntimeError("音源鉴权失败 (403)，请检查 API_KEY 是否有效或过期")
            if code_num == 429:
                last_error = "音源请求过速 (429)"
                if attempt == 0:
                    log("[网易云音源] 触发限流 (429)，等待 3 秒后重试...")
                    time.sleep(3.0)
                    continue
                raise RuntimeError("音源请求过速 (429)，请稍后再试")

            msg = body.get("message") or f"code={code_num}"
            last_error = f"音质 {q} 获取失败 ({msg})"
            if auto_fallback and q != candidates[-1]:
                log(f"[网易云音源] {last_error}，自动尝试降级音质...")
            break

    raise RuntimeError(last_error)


def _guess_audio_ext(url: str, content_type: str, quality: str) -> str:
    """Infer file extension from URL path, HTTP Content-Type, or requested quality."""
    path_ext = os.path.splitext(urlparse(url).path)[1].lower()
    if path_ext in (".flac", ".mp3", ".m4a", ".wav", ".ogg", ".aac"):
        return path_ext

    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in _CONTENT_TYPE_EXT:
        return _CONTENT_TYPE_EXT[ct]

    if quality in ("master", "atmos", "hires", "flac24bit", "flac"):
        return ".flac"
    return ".mp3"


def _ensure_remotion_compatible_audio(audio_path: Path, log: Callable[[str], None]) -> Path:
    if audio_path.suffix.lower() != ".flac":
        return audio_path
    m4a_path = audio_path.with_suffix(".m4a")
    ffmpeg = find_ffmpeg()
    tmp_m4a = m4a_path.with_suffix(".tmp.m4a")
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(audio_path),
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "320k",
        "-movflags",
        "+faststart",
        str(tmp_m4a),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 or not tmp_m4a.is_file() or tmp_m4a.stat().st_size < 4096:
        if tmp_m4a.is_file():
            try:
                tmp_m4a.unlink()
            except OSError:
                pass
        log(f"[网易云音频] FLAC 转码 M4A 失败，保留原文件: {res.stderr[-200:] if res.stderr else ''}")
        return audio_path
    os.replace(tmp_m4a, m4a_path)
    try:
        audio_path.unlink()
    except OSError:
        pass
    log(f"[网易云音频] 已将 FLAC 转码为 Remotion 兼容格式: {m4a_path.name}")
    return m4a_path


def download_netease_audio_file(
    song_id: int | str,
    out_dir: Path = AUDIO_DIR,
    filename_stem: str = "",
    quality: str = DEFAULT_QUALITY,
    auto_fallback: bool = True,
    force: bool = False,
    log_fn: Callable[[str], None] | None = None,
) -> tuple[Path, str]:
    """
    Download NetEase Cloud Music audio file to out_dir.
    Returns (saved_file_path, actual_quality).
    """
    log = log_fn or print
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = filename_stem or f"wy_{song_id}"

    # Check if an existing audio file with matching stem already exists
    if not force:
        for ext in (".m4a", ".mp3", ".wav", ".flac"):
            existing = out_dir / f"{stem}{ext}"
            if existing.is_file() and existing.stat().st_size > 10_000:
                log(f"[网易云音频] 已存在本地文件: {existing.name}")
                return _ensure_remotion_compatible_audio(existing, log), quality

    audio_url, actual_quality = fetch_netease_audio_url(
        song_id=song_id,
        quality=quality,
        auto_fallback=auto_fallback,
        log_fn=log,
    )
    log(f"[网易云音频] 获取直链成功 (ID: {song_id}, 音质: {actual_quality})，开始下载...")

    dl_headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": "https://music.163.com/",
    }

    with requests.get(audio_url, headers=dl_headers, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        ext = _guess_audio_ext(resp.url or audio_url, resp.headers.get("Content-Type", ""), actual_quality)
        out_path = out_dir / f"{stem}{ext}"

        # Clean up stale files with different extension if forcing re-download
        if force:
            for old_ext in (".flac", ".mp3", ".m4a", ".wav"):
                old_file = out_dir / f"{stem}{old_ext}"
                if old_file.is_file() and old_file != out_path:
                    try:
                        old_file.unlink()
                    except OSError:
                        pass

        tmp_path = out_path.with_suffix(out_path.suffix + ".part")
        total_bytes = 0
        try:
            with open(tmp_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=128 * 1024):
                    if chunk:
                        f.write(chunk)
                        total_bytes += len(chunk)
            if total_bytes < 4096:
                raise RuntimeError(f"下载文件过小 ({total_bytes} bytes)，可能链接已失效")
            os.replace(tmp_path, out_path)
        except Exception:
            if tmp_path.is_file():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass
            raise

    size_mb = total_bytes / (1024 * 1024)
    log(f"[网易云音频] 下载完成: {out_path.name} ({size_mb:.2f} MB, {actual_quality})")
    out_path = _ensure_remotion_compatible_audio(out_path, log)
    return out_path, actual_quality


def _render_cover_backdrop_frame(
    cover_path: Path | None,
    out_frame: Path,
    width: int = 1920,
    height: int = 1080,
) -> Path:
    """
    Build a 1080p backdrop PNG with blurred darkened album art and a crisp centered square cover.
    Falls back to a subtle dark studio backdrop when no album cover is available.
    """
    if cover_path and cover_path.is_file():
        with Image.open(cover_path) as src:
            rgb = src.convert("RGB")
            # Blurred full-bleed background
            bg = ImageOps.fit(rgb, (width, height), method=Image.Resampling.LANCZOS)
            bg = bg.filter(ImageFilter.GaussianBlur(radius=42))
            bg = ImageEnhance.Brightness(bg).enhance(0.38)
            bg = ImageEnhance.Color(bg).enhance(1.15)
            canvas = bg.convert("RGBA")

            # Centered sharp album artwork with soft drop shadow and rounded corners
            art_size = int(min(width, height) * 0.56)
            art = ImageOps.fit(rgb, (art_size, art_size), method=Image.Resampling.LANCZOS).convert("RGBA")
            radius = max(18, int(art_size * 0.045))

            mask = Image.new("L", (art_size, art_size), 0)
            draw = ImageDraw.Draw(mask)
            draw.rounded_rectangle((0, 0, art_size - 1, art_size - 1), radius=radius, fill=255)
            art.putalpha(mask)

            # Soft drop shadow behind artwork
            shadow_pad = 48
            shadow_canvas = Image.new("RGBA", (art_size + shadow_pad * 2, art_size + shadow_pad * 2), (0, 0, 0, 0))
            s_draw = ImageDraw.Draw(shadow_canvas)
            s_draw.rounded_rectangle(
                (shadow_pad, shadow_pad + 14, shadow_pad + art_size - 1, shadow_pad + art_size + 13),
                radius=radius,
                fill=(0, 0, 0, 165),
            )
            shadow_canvas = shadow_canvas.filter(ImageFilter.GaussianBlur(radius=24))

            cx = (width - art_size) // 2
            cy = (height - art_size) // 2 - int(height * 0.03)
            canvas.alpha_composite(shadow_canvas, (cx - shadow_pad, cy - shadow_pad))
            canvas.alpha_composite(art, (cx, cy))
            final_img = canvas.convert("RGB")
    else:
        # Fallback dark studio background
        final_img = Image.new("RGB", (width, height), (18, 18, 24))

    out_frame.parent.mkdir(parents=True, exist_ok=True)
    final_img.save(out_frame, format="PNG")
    return out_frame


def compose_cover_video(
    audio_path: Path,
    cover_path: Path | None,
    out_mp4: Path,
    width: int = 1920,
    height: int = 1080,
    fps: int = 30,
    log_fn: Callable[[str], None] | None = None,
) -> Path:
    """
    Mux a downloaded NetEase audio file with a 1080p album-cover frame into a Premiere-ready MP4.
    """
    log = log_fn or print
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("未找到 FFmpeg，无法将音频与专辑封面合成为 MP4 视频")
    if not audio_path.is_file():
        raise FileNotFoundError(f"音频文件不存在: {audio_path}")

    out_mp4.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        frame_png = Path(tmp.name)

    tmp_mp4 = out_mp4.with_suffix(".tmp.mp4")
    try:
        _render_cover_backdrop_frame(cover_path, frame_png, width=width, height=height)
        log(f"[合成视频] 正在用专辑封面合成 {width}x{height} MP4...")

        cmd = [
            ffmpeg,
            "-y",
            "-loop",
            "1",
            "-framerate",
            str(fps),
            "-i",
            str(frame_png),
            "-i",
            str(audio_path),
            "-c:v",
            "libx264",
            "-tune",
            "stillimage",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "320k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-shortest",
            "-movflags",
            "+faststart",
            str(tmp_mp4),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if res.returncode != 0 or not tmp_mp4.is_file():
            err_tail = (res.stderr or "").strip().splitlines()[-4:]
            raise RuntimeError(f"FFmpeg 合成视频失败: {' | '.join(err_tail)}")

        os.replace(tmp_mp4, out_mp4)
        size_mb = out_mp4.stat().st_size / (1024 * 1024)
        log(f"[合成视频] 完成: {out_mp4.name} ({size_mb:.2f} MB)")
        return out_mp4
    finally:
        for p in (frame_png, tmp_mp4):
            if p.is_file():
                try:
                    p.unlink()
                except OSError:
                    pass


def download_netease_for_song(
    song: SongItem,
    base_dir: Path = BASE_DIR,
    mode: str = "video",
    quality: str | None = None,
    auto_fallback: bool = True,
    force: bool = True,
    width: int = 1920,
    height: int = 1080,
    fps: int = 30,
    log_fn: Callable[[str], None] | None = None,
) -> dict:
    """
    Download NetEase audio for a SongItem.
    - mode == 'audio': saves pure audio to audio/<slug>.<ext> and sets song.audio_path.
    - mode == 'video': also fetches album cover, composes 1080p MP4 to raw/<slug>_cover.mp4, and sets song.file_path.
    """
    log = log_fn or print
    cfg = load_music_source_config()
    target_quality = (quality or cfg.get("default_quality") or DEFAULT_QUALITY).strip().lower()

    # Ensure netease_id is populated
    song_id = (song.netease_id or "").strip()
    if not song_id:
        log(f"[网易云音频] 未记录 netease_id，正在搜索《{song.title}》...")
        found_id = search_netease_song_id(song.title, song.artist, song.album)
        if not found_id:
            raise RuntimeError(f"无法在网易云音乐中匹配到歌曲《{song.title}》")
        song.netease_id = str(found_id)
        song_id = song.netease_id
        log(f"[网易云音频] 匹配到歌曲 ID: {song_id}")

    stem = slug(song.title, song.artist)
    audio_dir = base_dir / "audio"
    audio_path, actual_quality = download_netease_audio_file(
        song_id=song_id,
        out_dir=audio_dir,
        filename_stem=stem,
        quality=target_quality,
        auto_fallback=auto_fallback,
        force=force,
        log_fn=log,
    )
    song.audio_path = to_relative_path(str(audio_path), str(base_dir))

    result = {
        "song_id": song_id,
        "quality": actual_quality,
        "audio_path": song.audio_path,
        "video_path": "",
    }

    if mode == "video":
        cover_file = base_dir / "covers" / f"{stem}.png"
        cover_path = fetch_netease_cover(song, cover_file, size=800, force=False)
        if cover_path and cover_path.is_file():
            song.cover_path = to_relative_path(str(cover_path), str(base_dir))

        raw_mp4 = base_dir / "raw" / f"{stem}_cover.mp4"
        compose_cover_video(
            audio_path=audio_path,
            cover_path=cover_path,
            out_mp4=raw_mp4,
            width=width,
            height=height,
            fps=fps,
            log_fn=log,
        )
        song.file_path = to_relative_path(str(raw_mp4), str(base_dir))
        result["video_path"] = song.file_path

    return result


def main():
    parser = argparse.ArgumentParser(description="网易云音乐音频下载与封面视频合成工具")
    parser.add_argument("--id", default="", help="直接按网易云歌曲 ID 下载单曲纯音频")
    parser.add_argument("--playlist", action="store_true", help="批量处理 playlist.json 中的歌曲")
    parser.add_argument("--only", default="", help="仅处理歌名包含此关键词的歌曲（配合 --playlist）")
    parser.add_argument(
        "--mode",
        default="video",
        choices=["audio", "video"],
        help="audio=仅下载纯音频；video=下载音频并用专辑封面合成 1080p MP4 (默认 video)",
    )
    parser.add_argument(
        "--quality",
        default=None,
        choices=SUPPORTED_WY_QUALITIES,
        help="期望音质（默认读取配置文件，无损失败会自动降级）",
    )
    parser.add_argument("--force", action="store_true", help="强制重新下载并覆盖已有文件")
    args = parser.parse_args()

    cfg = load_music_source_config()
    quality = args.quality or cfg.get("default_quality") or DEFAULT_QUALITY

    if args.id:
        try:
            saved, actual_q = download_netease_audio_file(
                song_id=args.id,
                out_dir=AUDIO_DIR,
                filename_stem=f"wy_{args.id}",
                quality=quality,
                force=args.force,
            )
            print(f"\n[完成] 已保存: {saved} (音质: {actual_q})")
        except Exception as e:
            print(f"\n[错误] {e}", file=sys.stderr)
            sys.exit(1)
        return

    if args.playlist:
        playlist = load_playlist(DEFAULT_PLAYLIST_PATH)
        changed = False
        for i, song in enumerate(playlist.songs):
            if args.only and args.only.lower() not in song.title.lower():
                continue
            if i > 0:
                time.sleep(1.5)
            try:
                download_netease_for_song(
                    song=song,
                    base_dir=BASE_DIR,
                    mode=args.mode,
                    quality=quality,
                    force=args.force,
                    width=playlist.resolution.width,
                    height=playlist.resolution.height,
                    fps=min(playlist.fps, 30),
                )
                changed = True
            except Exception as e:
                print(f"[ERROR] {song.title}: {e}")
        if changed:
            save_playlist(playlist, DEFAULT_PLAYLIST_PATH)
            print("\n[完成] playlist.json 已更新。")
        return

    parser.print_help()


if __name__ == "__main__":
    main()
