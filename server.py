"""
server.py — Visual Web Studio for Music Recommendation Video Workflow

Features:
  - Visual interface for playlist songs
  - Multi-candidate MV search on YouTube (4-6 options with thumbnails & metadata)
  - Interactive selection of candidates with one-click adoption
  - In-place editing of start/end timestamps and recommendation reasons
  - One-click 1080p downloading with real-time status feedback
  - NetEase playlist link parser integration
"""

import json
import os
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn
import yt_dlp

from backend.download import (
    download_mv,
    is_bilibili_url,
    slug,
    RAW_DIR,
    resolve_file_path,
    to_relative_path,
)
from backend.netease import import_netease_playlist
from backend.netease_audio import (
    download_netease_for_song,
    get_music_source_status,
    parse_lx_script_text,
    save_music_source_config,
)
from backend.bilibili import (
    search_bilibili,
    generate_bilibili_qr,
    poll_bilibili_qr,
    get_bilibili_login_status,
    clear_bilibili_cookies,
)
from backend.preprocess import preprocess_song
from backend.lyrics import fetch_and_save_lyrics
from backend.analyze_visuals import analyze_song_visuals
from backend.schema import load_playlist as load_playlist_model, save_playlist as save_playlist_model

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_PATH = Path(BASE_DIR)
PLAYLIST_FILE = os.path.join(BASE_DIR, "playlist.json")
BILI_COOKIES_FILE = os.path.join(BASE_DIR, "cookies.txt")
WEB_DIR = os.path.join(BASE_DIR, "web")
COVERS_DIR = os.path.join(BASE_DIR, "covers")
os.makedirs(COVERS_DIR, exist_ok=True)

app = FastAPI(title="Music Rec Video Studio")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/covers", StaticFiles(directory=COVERS_DIR), name="covers")

# Global task state tracking
task_lock = threading.Lock()
tasks_state = {
    "is_downloading": False,
    "is_rendering": False,
    "queue_count": 0,
    "current_song": "",
    "logs": [],
    "progress_percent": 0,
}

_job_queue: queue.Queue = queue.Queue()


def _queue_worker_loop():
    """Sequential background queue worker for song downloads & NetEase synthesis."""
    while True:
        label, fn, args = _job_queue.get()
        try:
            fn(*args)
        except Exception as e:
            log_task(f"❌ 队列任务异常 ({label}): {e}")
        finally:
            with task_lock:
                tasks_state["queue_count"] = max(0, tasks_state["queue_count"] - 1)
                if tasks_state["queue_count"] == 0:
                    tasks_state["is_downloading"] = False
                    tasks_state["current_song"] = ""
            _job_queue.task_done()


_queue_thread = threading.Thread(target=_queue_worker_loop, daemon=True)
_queue_thread.start()


def enqueue_download_job(label: str, fn, *args):
    """Push a download / synthesis task onto the background queue."""
    with task_lock:
        tasks_state["queue_count"] += 1
        tasks_state["is_downloading"] = True
        q_pos = tasks_state["queue_count"]
    if q_pos > 1:
        log_task(f"📋 已加入下载队列 (当前排队第 {q_pos} 个): {label}")
    _job_queue.put((label, fn, args))


def log_task(msg: str):
    """Append a timestamped message to task logs."""
    timestamp = time.strftime("%H:%M:%S")
    entry = f"[{timestamp}] {msg}"
    print(entry)
    with task_lock:
        tasks_state["logs"].append(entry)
        if len(tasks_state["logs"]) > 50:
            tasks_state["logs"].pop(0)


def load_playlist() -> dict:
    """Load playlist.json via unified schema, filling defaults for missing fields."""
    return load_playlist_model(PLAYLIST_FILE).model_dump()


def save_playlist(data: dict):
    """Save playlist.json to disk, normalizing local file_path entries to portable relative paths."""
    for song in data.get("songs", []):
        fp = song.get("file_path", "")
        if fp:
            resolved = resolve_file_path(fp)
            if os.path.isabs(resolved) and os.path.isfile(resolved):
                song["file_path"] = to_relative_path(resolved)
            elif os.path.isabs(fp):
                song["file_path"] = to_relative_path(fp)
    save_playlist_model(data, PLAYLIST_FILE)


@app.get("/")
def serve_index():
    """Serve the frontend single-page application."""
    index_file = os.path.join(WEB_DIR, "index.html")
    if not os.path.isfile(index_file):
        raise HTTPException(status_code=404, detail="index.html not found")
    return FileResponse(index_file, headers={"Cache-Control": "no-store"})


@app.get("/api/media/{index}")
def stream_song_media(index: int):
    """Stream local video file (normalized preferred) with Range support for precise web trimming."""
    data = load_playlist()
    songs = data.get("songs", [])
    if index < 0 or index >= len(songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = songs[index]
    for key in ("normalized_path", "file_path"):
        fp = resolve_file_path(song.get(key, ""))
        if fp and os.path.isfile(fp):
            return FileResponse(fp, media_type="video/mp4")
    raise HTTPException(status_code=404, detail="Local media file not found")


@app.post("/api/upload_media/{index}")
async def upload_local_song_media(index: int, file: UploadFile = File(...)):
    """Upload a local video file (e.g. live performance) into raw/ and bind it to the song."""
    playlist = load_playlist_model(PLAYLIST_FILE)
    if index < 0 or index >= len(playlist.songs):
        raise HTTPException(status_code=404, detail="Song index out of range")

    song = playlist.songs[index]
    raw_dir = BASE_PATH / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    orig_ext = Path(file.filename or "video.mp4").suffix.lower() or ".mp4"
    safe_name = f"{slug(song.title, song.artist)}_local{orig_ext}"
    dest = raw_dir / safe_name

    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            f.write(chunk)

    song.file_path = f"raw/{safe_name}"
    song.normalized_path = ""
    song.media_source = "local"
    save_playlist_model(playlist, PLAYLIST_FILE)
    log_task(f"📁 已导入本地视频 [{song.title}]: {song.file_path}")
    return {"status": "ok", "file_path": song.file_path}


@app.get("/api/audio/{index}")
def download_song_audio_file(index: int):
    """Download or stream the saved pure NetEase audio file for a song."""
    data = load_playlist()
    songs = data.get("songs", [])
    if index < 0 or index >= len(songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = songs[index]
    ap = resolve_file_path(song.get("audio_path", ""))
    if ap and os.path.isfile(ap):
        return FileResponse(ap, filename=os.path.basename(ap))
    raise HTTPException(status_code=404, detail="Local audio file not found")


@app.get("/api/lyrics/{index}")
def get_song_lyrics(index: int):
    """Return parsed bilingual lyrics lines for the given song index."""
    playlist = load_playlist_model(PLAYLIST_FILE)
    if index < 0 or index >= len(playlist.songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = playlist.songs[index]
    lp = resolve_file_path(song.lyrics_path)
    if lp and os.path.isfile(lp):
        try:
            with open(lp, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"lines": [], "has_translation": False}


@app.post("/api/lyrics/{index}")
def fetch_single_lyrics(index: int):
    """Fetch or refresh bilingual lyrics from NetEase for a single song."""
    playlist = load_playlist_model(PLAYLIST_FILE)
    if index < 0 or index >= len(playlist.songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = playlist.songs[index]
    out = fetch_and_save_lyrics(song, BASE_PATH, force=True, log=log_task)
    if out and out.is_file():
        save_playlist_model(playlist, PLAYLIST_FILE)
        return json.loads(out.read_text(encoding="utf-8"))
    return {"lines": [], "has_translation": False}


@app.post("/api/analyze_visuals")
def analyze_all_visuals_api():
    """Run batch lyrics fetch + 3-zone brightness analysis + static-MV beat curve extraction."""
    with task_lock:
        if tasks_state["is_downloading"]:
            raise HTTPException(status_code=409, detail="Another background task is already running")
        tasks_state["is_downloading"] = True
        tasks_state["current_song"] = "视觉分析 & 双语歌词"
        tasks_state["progress_percent"] = 0

    def _run():
        try:
            playlist = load_playlist_model(PLAYLIST_FILE)
            total = max(1, len(playlist.songs))
            for i, song in enumerate(playlist.songs):
                with task_lock:
                    tasks_state["current_song"] = f"分析 {song.title}"
                    tasks_state["progress_percent"] = int((i / total) * 100)
                fetch_and_save_lyrics(song, BASE_PATH, force=False, log=log_task)
                analyze_song_visuals(song, BASE_PATH, log=log_task)
            save_playlist_model(playlist, PLAYLIST_FILE)
            log_task("✅ 视觉亮度与双语歌词分析完成！")
        except Exception as e:
            log_task(f"❌ 视觉分析异常: {e}")
        finally:
            with task_lock:
                tasks_state["is_downloading"] = False
                tasks_state["current_song"] = ""
                tasks_state["progress_percent"] = 100

    threading.Thread(target=_run, daemon=True).start()
    return {"status": "started"}


@app.get("/api/playlist")
def get_playlist_api():
    """Get the current playlist configuration."""
    data = load_playlist()
    # Check actual file existence on disk for each song
    for song in data.get("songs", []):
        fp = resolve_file_path(song.get("file_path", ""))
        song["has_file"] = bool(fp and os.path.isfile(fp))
        if song["has_file"]:
            try:
                song["file_size_mb"] = round(os.path.getsize(fp) / 1024 / 1024, 2)
            except Exception:
                song["file_size_mb"] = 0
        else:
            song["file_size_mb"] = 0

        cp = resolve_file_path(song.get("cover_path", ""))
        song["has_cover"] = bool(cp and os.path.isfile(cp))
        np = resolve_file_path(song.get("normalized_path", ""))
        song["has_normalized"] = bool(np and os.path.isfile(np))
        lp = resolve_file_path(song.get("lyrics_path", ""))
        song["has_lyrics"] = bool(lp and os.path.isfile(lp))
        ap = resolve_file_path(song.get("audio_path", ""))
        song["has_audio"] = bool(ap and os.path.isfile(ap))
        if song["has_audio"]:
            try:
                song["audio_size_mb"] = round(os.path.getsize(ap) / 1024 / 1024, 2)
            except Exception:
                song["audio_size_mb"] = 0
        else:
            song["audio_size_mb"] = 0
    return data


class PlaylistUpdateRequest(BaseModel):
    data: dict


@app.post("/api/playlist")
def update_playlist_api(req: PlaylistUpdateRequest):
    """Save updated playlist configuration."""
    save_playlist(req.data)
    return {"status": "ok", "message": "歌单已保存"}


class NeteaseImportRequest(BaseModel):
    url: str
    limit: int = 10
    append: bool = False


@app.post("/api/netease")
def import_netease_api(req: NeteaseImportRequest):
    """Parse NetEase Cloud Music playlist link, update playlist.json, and auto-run preprocessing."""
    try:
        count, name = import_netease_playlist(
            input_str=req.url,
            limit=req.limit,
            append=req.append,
            output_path=PLAYLIST_FILE,
        )
        # Automatically run background preprocessing (fetch 1:1 covers & normalize any existing videos)
        if not tasks_state["is_downloading"]:
            t = threading.Thread(target=_worker_preprocess, args=(False,), daemon=True)
            t.start()
        return {"status": "ok", "count": count, "playlist_name": name}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/bilibili/status")
def bilibili_login_status_api():
    """Return current Bilibili cookies.txt login & VIP status."""
    return get_bilibili_login_status(BILI_COOKIES_FILE)


@app.post("/api/bilibili/qr/generate")
def bilibili_qr_generate_api():
    """Generate a new Bilibili web QR login URL and qrcode_key."""
    try:
        return generate_bilibili_qr()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/bilibili/qr/poll")
def bilibili_qr_poll_api(qrcode_key: str = Query(..., description="Bilibili QR login key")):
    """Poll Bilibili QR login status and persist cookies.txt on success."""
    try:
        result = poll_bilibili_qr(qrcode_key, BILI_COOKIES_FILE)
        if result.get("status") == "success":
            u = result.get("user") or {}
            vip_tag = f" ({u.get('vip_label') or '大会员'})" if u.get("is_vip") else ""
            log_task(f"✅ B站扫码登录成功: {u.get('uname', '')}{vip_tag}，已保存 cookies.txt")
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/bilibili/logout")
def bilibili_logout_api():
    """Clear locally saved Bilibili cookies.txt."""
    clear_bilibili_cookies(BILI_COOKIES_FILE)
    log_task("已退出 B 站登录并删除本地 cookies.txt")
    return {"status": "ok"}


@app.get("/api/candidates")
def search_candidates_api(
    query: str = Query(..., description="Search query string"),
    platform: str = Query("all", description="Search platform: all, bilibili, or youtube"),
    limit: int = Query(8, ge=1, le=20),
):
    """
    Search candidate videos from YouTube and Bilibili.
    Returns list of options with title, uploader, duration, thumbnail, platform, and URL.
    """
    results = []
    log_task(f"正在检索候选方案 ({platform}): {query}")

    # ── 1. Bilibili candidates ───────────────────────────────
    if platform in ("all", "bilibili"):
        try:
            bili_limit = limit if platform == "bilibili" else max(4, limit // 2)
            bili_results = search_bilibili(query, limit=bili_limit)
            results.extend(bili_results)
        except Exception as e:
            log_task(f"[B站] 检索异常: {e}")

    # ── 2. YouTube candidates ────────────────────────────────
    if platform in ("all", "youtube"):
        try:
            yt_limit = limit if platform == "youtube" else max(4, limit // 2)
            opts = {
                "quiet": True,
                "no_warnings": True,
                "extract_flat": True,
                "remote_components": ["ejs:github"],
            }
            search_term = f"ytsearch{yt_limit}:{query}"
            with yt_dlp.YoutubeDL(opts) as ydl:
                res = ydl.extract_info(search_term, download=False)
                entries = res.get("entries", [])
                for e in entries:
                    vid = e.get("id") or ""
                    dur = e.get("duration")
                    if dur:
                        mins = int(dur) // 60
                        secs = int(dur) % 60
                        dur_str = f"{mins}:{secs:02d}"
                    else:
                        dur_str = "--:--"

                    v_url = e.get("url")
                    if not v_url or "http" not in v_url:
                        v_url = f"https://www.youtube.com/watch?v={vid}"

                    thumb = f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg" if vid else ""

                    results.append({
                        "id": vid,
                        "title": e.get("title", "未知标题"),
                        "uploader": e.get("uploader", "未知作者"),
                        "duration_str": dur_str,
                        "url": v_url,
                        "thumbnail": thumb,
                        "platform": "youtube",
                    })
        except Exception as e:
            log_task(f"[YouTube] 检索异常: {e}")

    return {"status": "ok", "candidates": results}


class DownloadSingleRequest(BaseModel):
    index: int
    force: bool = True
    quality: str = "1080"


def _preprocess_after_download(index: int, refresh_norm: bool = True):
    """Ensure 1:1 cover and -14 LUFS loudness normalization are updated right after download."""
    playlist = load_playlist_model(PLAYLIST_FILE)
    if index < 0 or index >= len(playlist.songs):
        return
    song = playlist.songs[index]
    if refresh_norm:
        # Remove stale normalized video so loudness is re-computed from the newly downloaded file
        stale_norm = BASE_PATH / "processed" / f"{slug(song.title, song.artist)}_norm.mp4"
        if stale_norm.is_file():
            try:
                stale_norm.unlink()
            except OSError:
                pass
    preprocess_song(song, BASE_PATH, force=False, log_fn=log_task)
    save_playlist_model(playlist, PLAYLIST_FILE)


def _make_song_key(song) -> tuple[str, str, str]:
    """Build a stable (netease_id, title, artist) identifier for queued jobs."""
    if isinstance(song, dict):
        return (
            str(song.get("netease_id", "") or "").strip(),
            str(song.get("title", "") or ""),
            str(song.get("artist", "") or ""),
        )
    return (
        str(getattr(song, "netease_id", "") or "").strip(),
        str(getattr(song, "title", "") or ""),
        str(getattr(song, "artist", "") or ""),
    )


def _resolve_song_index(
    songs: list,
    fallback_index: int,
    song_key: tuple[str, str, str] | None,
) -> Optional[int]:
    """Resolve current song index even if the playlist was reordered while queued."""
    if song_key is None:
        return fallback_index if 0 <= fallback_index < len(songs) else None

    if 0 <= fallback_index < len(songs) and _make_song_key(songs[fallback_index]) == song_key:
        return fallback_index

    target_nid, target_title, target_artist = song_key
    if target_nid:
        for idx, s in enumerate(songs):
            if _make_song_key(s)[0] == target_nid:
                return idx

    for idx, s in enumerate(songs):
        _, s_title, s_artist = _make_song_key(s)
        if s_title == target_title and s_artist == target_artist:
            return idx

    return None


def _worker_download_single(
    index: int,
    force: bool,
    quality: str,
    song_key: tuple[str, str, str] | None = None,
):
    """Background worker for downloading a single song."""
    with task_lock:
        tasks_state["is_downloading"] = True
    try:
        data = load_playlist()
        songs = data.get("songs", [])
        resolved_index = _resolve_song_index(songs, index, song_key)
        if resolved_index is None:
            log_task("歌曲已从歌单移除或序号无效，跳过下载")
            return

        song = songs[resolved_index]
        title, artist = song.get("title", ""), song.get("artist", "")
        url = song.get("youtube_url", "").strip()

        with task_lock:
            tasks_state["current_song"] = f"{artist} - {title}"

        out_path = os.path.join(RAW_DIR, slug(title, artist) + ".mp4")

        if force and os.path.isfile(out_path):
            try:
                os.remove(out_path)
            except Exception:
                pass

        if not url:
            log_task(f"未指定 URL，自动搜索: {title}")
            clean_title = title.split("(")[0].split("（")[0].strip()[:40]
            query = f"{clean_title} {artist} official MV"
            with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "remote_components": ["ejs:github"]}) as ydl:
                info = ydl.extract_info(f"ytsearch1:{query}", download=False)
                entries = info.get("entries", [])
                if entries:
                    url = entries[0].get("url") or entries[0].get("webpage_url")
                    song["youtube_url"] = url

        if not url:
            log_task(f"未找到可用的下载链接: {title}")
            return

        log_task(f"开始下载 {title} ({quality}p)...")
        success = download_mv(url, out_path, quality=quality, log_fn=log_task)
        if success:
            song["file_path"] = to_relative_path(out_path)
            save_playlist(data)
            log_task(f"✓ 下载成功: {title}")
            _preprocess_after_download(resolved_index, refresh_norm=True)
        else:
            log_task(f"✗ 下载失败: {title}")
    except Exception as e:
        log_task(f"下载异常: {e}")


@app.post("/api/download_single")
def download_single_api(req: DownloadSingleRequest):
    """Enqueue download for a single song (supports queuing multiple songs)."""
    data = load_playlist()
    songs = data.get("songs", [])
    if not (0 <= req.index < len(songs)):
        raise HTTPException(status_code=400, detail="无效的歌曲序号")
    target_song = songs[req.index]
    title = target_song.get("title", f"#{req.index + 1}")
    song_key = _make_song_key(target_song)
    enqueue_download_job(
        f"下载 MV - {title}",
        _worker_download_single,
        req.index,
        req.force,
        req.quality,
        song_key,
    )
    return {"status": "queued", "message": f"已加入下载队列: {title}", "queue_count": tasks_state["queue_count"]}


def _worker_download_all(force: bool, quality: str):
    """Background worker for batch downloading all songs in playlist."""
    with task_lock:
        tasks_state["is_downloading"] = True
    try:
        data = load_playlist()
        songs = data.get("songs", [])
        total = len(songs)

        bili_downloads = 0
        netease_downloads = 0
        for i, song in enumerate(songs):
            title, artist = song.get("title", ""), song.get("artist", "")
            with task_lock:
                tasks_state["current_song"] = f"[{i+1}/{total}] {artist} - {title}"
                tasks_state["progress_percent"] = int((i / total) * 100)

            out_path = os.path.join(RAW_DIR, slug(title, artist) + ".mp4")
            existing_path = resolve_file_path(song.get("file_path", ""))
            source_mode = song.get("media_source") or "auto"
            if source_mode == "auto":
                if existing_path and "_local." in os.path.basename(existing_path):
                    source_mode = "local"
                elif song.get("youtube_url", "").strip():
                    source_mode = "video_url"

            # Check if file exists (unless forced)
            if not force and existing_path and os.path.isfile(existing_path):
                log_task(f"跳过已存在: {title}")
                _preprocess_after_download(i, refresh_norm=False)
                continue

            if source_mode == "local":
                if existing_path and os.path.isfile(existing_path):
                    _preprocess_after_download(i, refresh_norm=False)
                else:
                    log_task(f"⚠️ [{title}] 设为本地视频但尚未上传文件，跳过")
                continue

            if source_mode == "netease_cover":
                if netease_downloads > 0:
                    time.sleep(1.5)
                try:
                    pl_model = load_playlist_model(PLAYLIST_FILE)
                    s_model = pl_model.songs[i]
                    res = download_netease_for_song(
                        song=s_model,
                        base_dir=BASE_PATH,
                        mode="video",
                        quality=None,
                        force=force,
                        width=pl_model.resolution.width,
                        height=pl_model.resolution.height,
                        fps=min(pl_model.fps, 30),
                        log_fn=log_task,
                    )
                    netease_downloads += 1
                    save_playlist_model(pl_model, PLAYLIST_FILE)
                    _preprocess_after_download(i, refresh_norm=True)
                    log_task(f"✓ 网易云合成MV [{i+1}/{total}] {title} ({res['quality']})")
                except Exception as ne_err:
                    netease_downloads += 1
                    log_task(f"✗ 网易云合成MV失败 ({title}): {ne_err}")
                continue

            if force and os.path.isfile(out_path):
                try:
                    os.remove(out_path)
                except Exception:
                    pass

            url = song.get("youtube_url", "").strip()
            if not url:
                clean_title = title.split("(")[0].split("（")[0].strip()[:40]
                query = f"{clean_title} {artist} official MV"
                with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "remote_components": ["ejs:github"]}) as ydl:
                    info = ydl.extract_info(f"ytsearch1:{query}", download=False)
                    entries = info.get("entries", [])
                    if entries:
                        url = entries[0].get("url") or entries[0].get("webpage_url")
                        song["youtube_url"] = url

            if not url:
                log_task(f"未找到链接: {title}，跳过")
                continue

            # Throttle consecutive Bilibili downloads to avoid HTTP 412 risk control
            if is_bilibili_url(url) and bili_downloads > 0:
                log_task("[B站] 节流等待 2 秒以防风控...")
                time.sleep(2.0)

            log_task(f"下载 [{i+1}/{total}] {title}...")
            try:
                if download_mv(url, out_path, quality=quality, log_fn=log_task):
                    if is_bilibili_url(url):
                        bili_downloads += 1
                    song["file_path"] = to_relative_path(out_path)
                    save_playlist(data)
                    log_task(f"✓ 成功: {title}")
                    _preprocess_after_download(i, refresh_norm=True)
                else:
                    log_task(f"✗ 失败: {title}")
            except Exception as song_err:
                log_task(f"✗ 下载异常 ({title}): {song_err}")

        with task_lock:
            tasks_state["progress_percent"] = 100
        log_task("🎉 全部下载流程结束！")
    except Exception as e:
        log_task(f"批量下载中断: {e}")
    finally:
        with task_lock:
            tasks_state["is_downloading"] = False
            tasks_state["current_song"] = ""


class DownloadAllRequest(BaseModel):
    force: bool = False
    quality: str = "1080"


@app.post("/api/download_all")
def download_all_api(req: DownloadAllRequest):
    """Trigger batch download of all songs in playlist."""
    if tasks_state["is_downloading"]:
        return JSONResponse(status_code=400, content={"message": "当前已有下载任务在进行中"})

    t = threading.Thread(
        target=_worker_download_all,
        args=(req.force, req.quality),
        daemon=True,
    )
    t.start()
    return {"status": "started", "message": "已在后台启动全量下载"}


class NeteaseAudioConfigRequest(BaseModel):
    api_url: Optional[str] = None
    api_key: Optional[str] = None
    default_quality: Optional[str] = None
    script_text: Optional[str] = None


@app.get("/api/netease_audio/config")
def get_netease_audio_config_api():
    """Return NetEase custom audio source status and non-sensitive config."""
    return get_music_source_status()


@app.post("/api/netease_audio/config")
def update_netease_audio_config_api(req: NeteaseAudioConfigRequest):
    """Update NetEase custom audio source config directly or by parsing an LX Music JS script."""
    api_url = req.api_url
    api_key = req.api_key
    if req.script_text and req.script_text.strip():
        parsed = parse_lx_script_text(req.script_text)
        if not parsed.get("api_url") and not parsed.get("api_key"):
            raise HTTPException(status_code=400, detail="未能从脚本文本中解析出 API_URL 或 API_KEY")
        api_url = parsed.get("api_url") or api_url
        api_key = parsed.get("api_key") or api_key

    save_music_source_config(
        api_url=api_url,
        api_key=api_key,
        default_quality=req.default_quality,
    )
    log_task("✅ 已更新网易云音源配置")
    return get_music_source_status()


class NeteaseAudioSingleRequest(BaseModel):
    index: int
    mode: str = "video"  # "audio" | "video"
    quality: Optional[str] = None
    force: bool = True


def _worker_netease_audio_single(
    index: int,
    mode: str,
    quality: Optional[str],
    force: bool,
    song_key: tuple[str, str, str] | None = None,
):
    """Background worker to download NetEase audio (and optionally compose cover MP4) for one song."""
    with task_lock:
        tasks_state["is_downloading"] = True
        tasks_state["progress_percent"] = 10
    try:
        playlist = load_playlist_model(PLAYLIST_FILE)
        resolved_index = _resolve_song_index(playlist.songs, index, song_key)
        if resolved_index is None:
            log_task("歌曲已从歌单移除或序号无效，跳过网易云音源下载")
            return
        song = playlist.songs[resolved_index]
        mode_label = "封面合成 1080p MP4" if mode == "video" else "纯音频"
        with task_lock:
            tasks_state["current_song"] = f"网易云({mode_label}): {song.artist} - {song.title}"

        log_task(f"🎵 开始下载网易云音源 ({mode_label}): {song.artist} - {song.title}")
        res = download_netease_for_song(
            song=song,
            base_dir=BASE_PATH,
            mode=mode,
            quality=quality,
            force=force,
            width=playlist.resolution.width,
            height=playlist.resolution.height,
            fps=min(playlist.fps, 30),
            log_fn=log_task,
        )
        save_playlist_model(playlist, PLAYLIST_FILE)
        with task_lock:
            tasks_state["progress_percent"] = 80

        if mode == "video":
            song.media_source = "netease_cover"
            save_playlist_model(playlist, PLAYLIST_FILE)
            _preprocess_after_download(resolved_index, refresh_norm=True)
            log_task(f"✅ 网易云音源 + 封面合成完成: {song.title} ({res['quality']})")
        else:
            log_task(f"✅ 网易云纯音频下载完成: {song.title} ({res['quality']} -> {res['audio_path']})")

        with task_lock:
            tasks_state["progress_percent"] = 100
    except Exception as e:
        log_task(f"❌ 网易云音源下载失败: {e}")


@app.post("/api/netease_audio/download_single")
def netease_audio_download_single_api(req: NeteaseAudioSingleRequest):
    """Enqueue single-song NetEase audio download (supports queuing multiple songs)."""
    mode = "audio" if req.mode == "audio" else "video"
    playlist = load_playlist_model(PLAYLIST_FILE)
    if not (0 <= req.index < len(playlist.songs)):
        raise HTTPException(status_code=400, detail="无效的歌曲序号")
    target_song = playlist.songs[req.index]
    title = target_song.title
    song_key = _make_song_key(target_song)
    label = f"网易云{'纯音频' if mode == 'audio' else '合成MV'} - {title}"
    enqueue_download_job(
        label,
        _worker_netease_audio_single,
        req.index,
        mode,
        req.quality,
        req.force,
        song_key,
    )
    return {"status": "queued", "message": f"已加入队列: {label}", "queue_count": tasks_state["queue_count"]}


class NeteaseAudioBatchRequest(BaseModel):
    mode: str = "video"  # "audio" | "video"
    quality: Optional[str] = None
    force: bool = False
    missing_only: bool = False


def _worker_netease_audio_batch(mode: str, quality: Optional[str], force: bool, missing_only: bool):
    """Background worker for batch NetEase audio download / cover-video composition."""
    with task_lock:
        tasks_state["is_downloading"] = True
        tasks_state["progress_percent"] = 0
    try:
        playlist = load_playlist_model(PLAYLIST_FILE)
        total = max(1, len(playlist.songs))
        processed_requests = 0

        for i, song in enumerate(playlist.songs):
            with task_lock:
                tasks_state["current_song"] = f"网易云 [{i+1}/{len(playlist.songs)}] {song.title}"
                tasks_state["progress_percent"] = int((i / total) * 100)

            if missing_only:
                if mode == "video":
                    existing_video = resolve_file_path(song.file_path)
                    if existing_video and os.path.isfile(existing_video):
                        log_task(f"[跳过] 已有视频素材: {song.title}")
                        continue
                else:
                    existing_audio = resolve_file_path(song.audio_path)
                    if existing_audio and os.path.isfile(existing_audio):
                        log_task(f"[跳过] 已有纯音频: {song.title}")
                        continue

            # Throttle consecutive API calls to avoid HTTP 429 rate limiting
            if processed_requests > 0:
                time.sleep(1.5)

            try:
                res = download_netease_for_song(
                    song=song,
                    base_dir=BASE_PATH,
                    mode=mode,
                    quality=quality,
                    force=force,
                    width=playlist.resolution.width,
                    height=playlist.resolution.height,
                    fps=min(playlist.fps, 30),
                    log_fn=log_task,
                )
                processed_requests += 1
                save_playlist_model(playlist, PLAYLIST_FILE)
                if mode == "video":
                    _preprocess_after_download(i, refresh_norm=True)
                log_task(f"✓ [{i+1}/{len(playlist.songs)}] {song.title} ({res['quality']})")
            except Exception as song_err:
                processed_requests += 1
                log_task(f"✗ 网易云下载异常 ({song.title}): {song_err}")

        with task_lock:
            tasks_state["progress_percent"] = 100
        log_task("🎉 网易云音源批量任务完成！")
    except Exception as e:
        log_task(f"❌ 网易云批量任务中断: {e}")
    finally:
        with task_lock:
            tasks_state["is_downloading"] = False
            tasks_state["current_song"] = ""


@app.post("/api/netease_audio/download_all")
def netease_audio_download_all_api(req: NeteaseAudioBatchRequest):
    """Trigger batch NetEase audio download or cover-video composition."""
    if tasks_state["is_downloading"]:
        return JSONResponse(status_code=400, content={"message": "当前已有后台任务在进行中"})
    mode = "audio" if req.mode == "audio" else "video"
    t = threading.Thread(
        target=_worker_netease_audio_batch,
        args=(mode, req.quality, req.force, req.missing_only),
        daemon=True,
    )
    t.start()
    return {"status": "started", "message": "已在后台启动网易云批量下载"}


@app.get("/api/status")
def get_status_api():
    """Get the current download task status and logs."""
    with task_lock:
        return dict(tasks_state)


def _worker_preprocess(force: bool):
    with task_lock:
        tasks_state["is_downloading"] = True
        tasks_state["progress_percent"] = 0
    try:
        playlist = load_playlist_model(PLAYLIST_FILE)
        total = len(playlist.songs)
        for i, song in enumerate(playlist.songs):
            with task_lock:
                tasks_state["current_song"] = f"预处理 [{i+1}/{total}] {song.title}"
                tasks_state["progress_percent"] = int((i / max(1, total)) * 100)
            preprocess_song(song, BASE_PATH, force=force, log_fn=log_task)
            save_playlist_model(playlist, PLAYLIST_FILE)
        with task_lock:
            tasks_state["progress_percent"] = 100
        log_task("🎉 全部素材预处理（1:1 封面 + -14 LUFS 响度统一）完成！")
    except Exception as e:
        log_task(f"预处理异常: {e}")
    finally:
        with task_lock:
            tasks_state["is_downloading"] = False
            tasks_state["current_song"] = ""


class PreprocessRequest(BaseModel):
    force: bool = False


@app.post("/api/preprocess")
def preprocess_api(req: PreprocessRequest):
    """Trigger background cover extraction and -14 LUFS audio normalization."""
    if tasks_state["is_downloading"]:
        return JSONResponse(status_code=400, content={"message": "当前已有后台任务在进行中"})
    t = threading.Thread(target=_worker_preprocess, args=(req.force,), daemon=True)
    t.start()
    return {"status": "started", "message": "已在后台启动预处理"}


# ---------------------------------------------------------------------------
# Remotion Studio & Full-Video Render Integration
# ---------------------------------------------------------------------------
_remotion_studio_proc: Optional[subprocess.Popen] = None


def _remotion_env() -> dict[str, str]:
    env = os.environ.copy()
    extra_paths = ["/opt/homebrew/bin", "/usr/local/bin"]
    current_path = env.get("PATH", "")
    missing = [p for p in extra_paths if p not in current_path.split(os.pathsep)]
    if missing:
        env["PATH"] = os.pathsep.join(missing + [current_path])
    return env


def _npx_cmd() -> str:
    cmd = "npx.cmd" if os.name == "nt" else "npx"
    return shutil.which(cmd, path=_remotion_env().get("PATH", "")) or cmd


def _is_port_open(port: int) -> bool:
    import socket

    for host in ("127.0.0.1", "::1"):
        try:
            with socket.create_connection((host, port), timeout=0.4):
                return True
        except OSError:
            continue
    return False


def _ensure_remotion_public_links() -> None:
    """Ensure remotion/public links to project media directories across macOS/Linux/Windows."""
    remotion_dir = BASE_PATH / "remotion"
    if not remotion_dir.exists():
        return
    public_dir = remotion_dir / "public"
    public_dir.mkdir(parents=True, exist_ok=True)
    is_junction = getattr(os.path, "isjunction", lambda _p: False)

    for name in ("processed", "covers", "lyrics", "raw", "audio"):
        target = (BASE_PATH / name).resolve()
        target.mkdir(parents=True, exist_ok=True)
        link = public_dir / name

        if os.path.lexists(link):
            try:
                if link.exists() and link.resolve() == target:
                    continue
            except OSError:
                pass

            # Remove stale/broken symlink or Windows junction before recreating
            if link.is_symlink():
                link.unlink()
            elif os.name == "nt" and is_junction(link):
                os.rmdir(link)
            else:
                # Keep user-created real directories intact
                continue

        if os.name == "nt":
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(target)],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            os.symlink(target, link)


@app.post("/api/remotion/studio")
def start_remotion_studio():
    """Start Remotion Studio on port 3000 for 1:1 live preview."""
    global _remotion_studio_proc
    remotion_dir = BASE_PATH / "remotion"
    if not remotion_dir.exists():
        return JSONResponse(status_code=404, content={"message": "remotion/ 目录不存在"})

    _ensure_remotion_public_links()

    if _is_port_open(3000):
        return {"status": "running", "url": "http://localhost:3000"}

    if _remotion_studio_proc is None or _remotion_studio_proc.poll() is not None:
        log_file = BASE_PATH / "remotion" / "studio.log"
        lf = open(log_file, "w", encoding="utf-8")
        _remotion_studio_proc = subprocess.Popen(
            [_npx_cmd(), "remotion", "studio", "src/index.ts", "--port", "3000"],
            cwd=str(remotion_dir),
            env=_remotion_env(),
            stdin=subprocess.DEVNULL,
            stdout=lf,
            stderr=subprocess.STDOUT,
        )

    # Wait up to 15s for Remotion Studio to bind port 3000 before opening browser tab
    for _ in range(30):
        if _is_port_open(3000):
            return {"status": "started", "url": "http://localhost:3000"}
        if _remotion_studio_proc.poll() is not None:
            return JSONResponse(
                status_code=500,
                content={"message": "Remotion Studio 启动失败，请查看 remotion/studio.log"},
            )
        time.sleep(0.5)

    return JSONResponse(
        status_code=504,
        content={"message": "Remotion Studio 启动超时，请查看 remotion/studio.log"},
    )


_remotion_render_proc: Optional[subprocess.Popen] = None
_remotion_render_cancelled: bool = False


def _worker_remotion_render(output_name: Optional[str]):
    global _remotion_render_proc, _remotion_render_cancelled
    _remotion_render_cancelled = False
    with task_lock:
        tasks_state["is_rendering"] = True
        tasks_state["progress_percent"] = 0
        tasks_state["current_song"] = "Remotion 全片渲染中..."
    try:
        _ensure_remotion_public_links()
        playlist = load_playlist_model(PLAYLIST_FILE)
        remotion_dir = BASE_PATH / "remotion"
        out_dir = BASE_PATH / "output"
        out_dir.mkdir(parents=True, exist_ok=True)
        safe_name = slug(output_name or playlist.output_sequence_name or "music-rec-video", "")
        out_file = out_dir / f"{safe_name}.mp4"

        cmd = [
            _npx_cmd(),
            "remotion",
            "render",
            "src/index.ts",
            "MusicRecVideo",
            str(out_file),
            "--overwrite",
        ]
        log_task(f"🎬 启动 Remotion 渲染: {out_file.name}")
        proc = subprocess.Popen(
            cmd,
            cwd=str(remotion_dir),
            env=_remotion_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            start_new_session=(os.name != "nt"),
        )
        _remotion_render_proc = proc
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            log_task(line)
            frame_m = re.search(r"Rendered\s+(\d+)/(\d+)", line)
            if frame_m:
                cur_f, tot_f = int(frame_m.group(1)), max(1, int(frame_m.group(2)))
                with task_lock:
                    tasks_state["progress_percent"] = min(99, int((cur_f / tot_f) * 100))
                continue
            m = re.search(r"(\d{1,3})%", line)
            if m:
                with task_lock:
                    tasks_state["progress_percent"] = min(99, int(m.group(1)))

        ret = proc.wait()
        if _remotion_render_cancelled:
            log_task("⏹ Remotion 渲染已手动停止")
        elif ret == 0 and out_file.exists():
            with task_lock:
                tasks_state["progress_percent"] = 100
            log_task(f"🎉 Remotion 成片导出成功: {out_file}")
        else:
            log_task(f"✗ Remotion 渲染退出码: {ret}")
    except Exception as e:
        log_task(f"Remotion 渲染异常: {e}")
    finally:
        _remotion_render_proc = None
        with task_lock:
            tasks_state["is_rendering"] = False
            tasks_state["current_song"] = ""


@app.post("/api/remotion/cancel")
def cancel_remotion_render():
    """Terminate an active Remotion render process group cleanly."""
    global _remotion_render_proc, _remotion_render_cancelled
    proc = _remotion_render_proc
    if proc is None or proc.poll() is not None:
        return {"status": "idle", "message": "当前没有正在运行的 Remotion 渲染任务"}
    _remotion_render_cancelled = True
    try:
        if os.name != "nt":
            os.killpg(proc.pid, signal.SIGTERM)
        else:
            proc.terminate()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    return {"status": "cancelled", "message": "已发送停止渲染信号"}


class RemotionRenderRequest(BaseModel):
    output_name: Optional[str] = None


@app.post("/api/remotion/render")
def remotion_render_api(req: RemotionRenderRequest):
    """Render full playlist video via Remotion CLI into output/*.mp4."""
    if tasks_state["is_rendering"] or tasks_state["is_downloading"]:
        return JSONResponse(status_code=400, content={"message": "当前已有任务在进行中，请稍候"})
    t = threading.Thread(target=_worker_remotion_render, args=(req.output_name,), daemon=True)
    t.start()
    return {"status": "started", "message": "已在后台启动 Remotion 全片渲染"}


if __name__ == "__main__":
    _ensure_remotion_public_links()
    print("=======================================================")
    print(" 🎵 音乐推荐视频制作工作台 (Web Studio)")
    print(" 本地服务已启动: http://localhost:8000")
    print("=======================================================")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
