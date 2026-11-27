import json
import os
import queue
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Optional
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError
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
from backend.waveform import get_waveform
from backend.lyrics import fetch_and_save_lyrics
from backend.analyze_visuals import analyze_song_visuals
from backend.schema import (
    PlaylistConfig,
    load_playlist as load_playlist_model,
    save_playlist as save_playlist_model,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_PATH = Path(BASE_DIR)
WEB_PORT = int(os.environ.get("MRV_WEB_PORT", "8022"))
STUDIO_PORT = int(os.environ.get("MRV_STUDIO_PORT", "3022"))
PLAYLIST_FILE = os.path.join(BASE_DIR, "playlist.json")
BILI_COOKIES_FILE = os.path.join(BASE_DIR, "cookies.txt")
WEB_DIR = os.path.join(BASE_DIR, "web")
COVERS_DIR = os.path.join(BASE_DIR, "covers")
os.makedirs(COVERS_DIR, exist_ok=True)
os.makedirs(WEB_DIR, exist_ok=True)

app = FastAPI(title="Music Rec Video Remotion Studio")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
def _resolve_web_dir() -> str:
    dist_dir = os.path.join(WEB_DIR, "dist")
    if os.path.isfile(os.path.join(dist_dir, "index.html")):
        return dist_dir
    return WEB_DIR


class NoCacheStaticFiles(StaticFiles):
    def lookup_path(self, path: str) -> tuple[str, Optional[os.stat_result]]:
        if path.startswith(("/", "\\")):
            return "", None
        directory = _resolve_web_dir()
        joined_path = os.path.join(directory, path)
        if self.follow_symlink:
            full_path = os.path.abspath(joined_path)
            resolved_dir = os.path.abspath(directory)
        else:
            full_path = os.path.realpath(joined_path)
            resolved_dir = os.path.realpath(directory)
        try:
            if os.path.commonpath([full_path, resolved_dir]) != str(resolved_dir):
                return "", None
            return full_path, os.stat(full_path)
        except (FileNotFoundError, NotADirectoryError, ValueError):
            return "", None

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response


app.mount("/covers", StaticFiles(directory=COVERS_DIR), name="covers")
app.mount("/static", NoCacheStaticFiles(directory=WEB_DIR), name="static")

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
_remotion_studio_proc: Optional[subprocess.Popen] = None
_remotion_render_proc: Optional[subprocess.Popen] = None
_remotion_render_cancelled: bool = False


def log_task(msg: str):
    timestamp = time.strftime("%H:%M:%S")
    entry = f"[{timestamp}] {msg}"
    print(entry)
    with task_lock:
        tasks_state["logs"].append(entry)
        if len(tasks_state["logs"]) > 120:
            tasks_state["logs"].pop(0)


def _set_task_progress(current_song: Optional[str] = None, progress_percent: Optional[int] = None):
    with task_lock:
        if current_song is not None:
            tasks_state["current_song"] = current_song
        if progress_percent is not None:
            tasks_state["progress_percent"] = max(0, min(100, int(progress_percent)))


def _error_response(status_code: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": message, "message": message})


def _start_exclusive_task(
    target: Callable,
    args: tuple = (),
    label: str = "",
    flag: str = "is_downloading",
) -> bool:
    with task_lock:
        if tasks_state["is_downloading"] or tasks_state["is_rendering"] or tasks_state["queue_count"] > 0:
            return False
        tasks_state[flag] = True
        tasks_state["current_song"] = label
        tasks_state["progress_percent"] = 0

    def _wrapper():
        try:
            target(*args)
        except Exception as e:
            log_task(f"后台任务异常 ({label}): {e}")
        finally:
            with task_lock:
                tasks_state[flag] = False
                if not tasks_state["is_downloading"] and not tasks_state["is_rendering"]:
                    tasks_state["current_song"] = ""

    threading.Thread(target=_wrapper, daemon=True).start()
    return True


def _queue_worker_loop():
    while True:
        label, fn, args = _job_queue.get()
        try:
            fn(*args)
        except Exception as e:
            log_task(f"队列任务异常 ({label}): {e}")
        finally:
            with task_lock:
                tasks_state["queue_count"] = max(0, tasks_state["queue_count"] - 1)
                if tasks_state["queue_count"] == 0:
                    tasks_state["is_downloading"] = False
                    if not tasks_state["is_rendering"]:
                        tasks_state["current_song"] = ""
            _job_queue.task_done()


threading.Thread(target=_queue_worker_loop, daemon=True).start()


def enqueue_download_job(label: str, fn, *args) -> int:
    with task_lock:
        tasks_state["queue_count"] += 1
        tasks_state["is_downloading"] = True
        q_pos = tasks_state["queue_count"]
    if q_pos > 1:
        log_task(f"已加入下载队列 (排队第 {q_pos} 个): {label}")
    _job_queue.put((label, fn, args))
    return q_pos


def load_playlist() -> dict:
    return load_playlist_model(PLAYLIST_FILE).model_dump()


def save_playlist(data: dict):
    model = PlaylistConfig.model_validate(data)
    for song in model.songs:
        fp = song.file_path
        if fp:
            resolved = resolve_file_path(fp, base_dir=BASE_DIR, raw_dir=RAW_DIR)
            if os.path.isabs(resolved) and os.path.isfile(resolved):
                song.file_path = to_relative_path(resolved, base_dir=BASE_DIR)
            elif os.path.isabs(fp):
                song.file_path = to_relative_path(fp, base_dir=BASE_DIR)
    save_playlist_model(model, PLAYLIST_FILE)


def _resolve_path(rel_or_abs: str) -> str:
    return resolve_file_path(rel_or_abs, base_dir=BASE_DIR, raw_dir=RAW_DIR)


def _file_exists(rel_or_abs: str) -> bool:
    p = _resolve_path(rel_or_abs)
    return bool(p and os.path.isfile(p))


def _file_size_mb(rel_or_abs: str) -> float:
    p = _resolve_path(rel_or_abs)
    if not p or not os.path.isfile(p):
        return 0.0
    try:
        return round(os.path.getsize(p) / 1024 / 1024, 2)
    except Exception:
        return 0.0


@app.get("/")
def serve_index():
    index_file = os.path.join(_resolve_web_dir(), "index.html")
    if not os.path.isfile(index_file):
        raise HTTPException(status_code=404, detail="index.html not found")
    return FileResponse(index_file, headers={"Cache-Control": "no-store"})


def _preview_media_path(index: int) -> str:
    songs = load_playlist().get("songs", [])
    if index < 0 or index >= len(songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = songs[index]
    for key in ("normalized_path", "file_path"):
        fp = _resolve_path(song.get(key, ""))
        if fp and os.path.isfile(fp):
            return fp
    return ""


@app.get("/api/media/{index}")
def stream_song_media(index: int):
    path = _preview_media_path(index)
    if not path:
        raise HTTPException(status_code=404, detail="Local media file not found")
    return FileResponse(path, media_type="video/mp4")


@app.get("/api/waveform/{index}")
def song_waveform(index: int):
    try:
        path = _preview_media_path(index)
    except HTTPException:
        path = ""
    duration, peaks = get_waveform(path) if path else (0, ())
    return {"duration": duration, "peaks": peaks}


@app.post("/api/upload_media/{index}")
async def upload_local_song_media(index: int, file: UploadFile = File(...)):
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
    log_task(f"已导入本地视频 [{song.title}]: {song.file_path}")
    return {"status": "ok", "file_path": song.file_path}


@app.get("/api/audio/{index}")
def download_song_audio_file(index: int):
    data = load_playlist()
    songs = data.get("songs", [])
    if index < 0 or index >= len(songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = songs[index]
    ap = _resolve_path(song.get("audio_path", ""))
    if ap and os.path.isfile(ap):
        return FileResponse(ap, filename=os.path.basename(ap))
    raise HTTPException(status_code=404, detail="Local audio file not found")


@app.get("/api/composition-media/{folder}/{filename:path}")
def composition_media(folder: str, filename: str):
    if folder not in {"raw", "processed", "audio", "covers", "lyrics"}:
        raise HTTPException(status_code=404)
    directory = (BASE_PATH / folder).resolve()
    target = (directory / filename).resolve()
    if not target.is_relative_to(directory) or not target.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(target)


@app.get("/api/lyrics/{index}")
def get_song_lyrics(index: int):
    playlist = load_playlist_model(PLAYLIST_FILE)
    if index < 0 or index >= len(playlist.songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = playlist.songs[index]
    lp = _resolve_path(song.lyrics_path)
    if lp and os.path.isfile(lp):
        try:
            with open(lp, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"lines": [], "has_translation": False}


@app.post("/api/lyrics/{index}")
def fetch_single_lyrics(index: int):
    playlist = load_playlist_model(PLAYLIST_FILE)
    if index < 0 or index >= len(playlist.songs):
        raise HTTPException(status_code=404, detail="Song index out of range")
    song = playlist.songs[index]
    out = fetch_and_save_lyrics(song, BASE_PATH, force=True, log=log_task)
    if out and out.is_file():
        save_playlist_model(playlist, PLAYLIST_FILE)
        return json.loads(out.read_text(encoding="utf-8"))
    return {"lines": [], "has_translation": False}


def _worker_analyze_visuals():
    try:
        playlist = load_playlist_model(PLAYLIST_FILE)
        total = max(1, len(playlist.songs))
        for i, song in enumerate(playlist.songs):
            _set_task_progress(f"分析 {song.title}", int((i / total) * 100))
            fetch_and_save_lyrics(song, BASE_PATH, force=False, log=log_task)
            analyze_song_visuals(song, BASE_PATH, log=log_task)
        save_playlist_model(playlist, PLAYLIST_FILE)
        _set_task_progress(progress_percent=100)
        log_task("视觉亮度与双语歌词分析完成")
    except Exception as e:
        log_task(f"视觉分析异常: {e}")


@app.post("/api/analyze_visuals")
def analyze_all_visuals_api():
    if not _start_exclusive_task(_worker_analyze_visuals, label="视觉分析 & 双语歌词"):
        return _error_response(409, "当前已有后台任务在进行中")
    return {"status": "started"}


@app.get("/api/playlist")
def get_playlist_api():
    data = load_playlist()
    for song in data.get("songs", []):
        fp = song.get("file_path", "")
        song["has_file"] = _file_exists(fp)
        song["file_size_mb"] = _file_size_mb(fp) if song["has_file"] else 0
        song["has_cover"] = _file_exists(song.get("cover_path", ""))
        song["has_normalized"] = _file_exists(song.get("normalized_path", ""))
        song["has_lyrics"] = _file_exists(song.get("lyrics_path", ""))
        ap = song.get("audio_path", "")
        song["has_audio"] = _file_exists(ap)
        song["audio_size_mb"] = _file_size_mb(ap) if song["has_audio"] else 0
    return data


class PlaylistUpdateRequest(BaseModel):
    data: dict


@app.post("/api/playlist")
def update_playlist_api(req: PlaylistUpdateRequest):
    try:
        save_playlist(req.data)
    except ValidationError as e:
        errs = e.errors()
        msg = f"歌单数据校验失败: {errs[0].get('msg', str(e))}" if errs else f"歌单数据校验失败: {e}"
        return _error_response(422, msg)
    except Exception as e:
        msg = f"保存歌单失败: {e}"
        log_task(msg)
        return _error_response(500, msg)
    return {"status": "ok", "message": "歌单已保存"}


class NeteaseImportRequest(BaseModel):
    url: str
    limit: int = 10
    append: bool = False


@app.post("/api/netease")
def import_netease_api(req: NeteaseImportRequest):
    try:
        count, name = import_netease_playlist(
            input_str=req.url,
            limit=req.limit,
            append=req.append,
            output_path=PLAYLIST_FILE,
        )
        _start_exclusive_task(_worker_preprocess, args=(False,), label="导入后自动预处理")
        return {"status": "ok", "count": count, "playlist_name": name}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/bilibili/status")
def bilibili_login_status_api():
    return get_bilibili_login_status(BILI_COOKIES_FILE)


@app.post("/api/bilibili/qr/generate")
def bilibili_qr_generate_api():
    try:
        return generate_bilibili_qr()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/bilibili/qr/poll")
def bilibili_qr_poll_api(qrcode_key: str = Query(...)):
    try:
        result = poll_bilibili_qr(qrcode_key, BILI_COOKIES_FILE)
        if result.get("status") == "success":
            u = result.get("user") or {}
            vip_tag = f" ({u.get('vip_label') or '大会员'})" if u.get("is_vip") else ""
            log_task(f"B站扫码登录成功: {u.get('uname', '')}{vip_tag}")
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/bilibili/logout")
def bilibili_logout_api():
    clear_bilibili_cookies(BILI_COOKIES_FILE)
    log_task("已退出 B 站登录并删除本地 cookies.txt")
    return {"status": "ok"}


@app.get("/api/candidates")
def search_candidates_api(
    query: str = Query(...),
    platform: str = Query("all"),
    limit: int = Query(12, ge=1, le=20),
):
    results = []
    log_task(f"检索候选方案 ({platform}): {query}")

    if platform in ("all", "bilibili"):
        try:
            bili_limit = limit if platform == "bilibili" else max(4, limit // 2)
            results.extend(search_bilibili(query, limit=bili_limit))
        except Exception as e:
            log_task(f"[B站] 检索异常: {e}")

    if platform in ("all", "youtube"):
        try:
            yt_limit = limit if platform == "youtube" else max(4, limit // 2)
            opts = {
                "quiet": True,
                "no_warnings": True,
                "extract_flat": True,
                "remote_components": ["ejs:github"],
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                res = ydl.extract_info(f"ytsearch{yt_limit}:{query}", download=False)
                for e in res.get("entries", []):
                    vid = e.get("id") or ""
                    dur = e.get("duration")
                    dur_str = f"{int(dur) // 60}:{int(dur) % 60:02d}" if dur else "--:--"
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
    playlist = load_playlist_model(PLAYLIST_FILE)
    if index < 0 or index >= len(playlist.songs):
        return
    song = playlist.songs[index]
    if refresh_norm:
        stale_norm = BASE_PATH / "processed" / f"{slug(song.title, song.artist)}_norm.mp4"
        if stale_norm.is_file():
            try:
                stale_norm.unlink()
            except OSError:
                pass
    preprocess_song(song, BASE_PATH, force=False, log_fn=log_task)
    save_playlist_model(playlist, PLAYLIST_FILE)


def _make_song_key(song) -> tuple[str, str, str]:
    if isinstance(song, dict):
        return (
            str(song.get("netease_id") or "").strip(),
            str(song.get("title") or "").strip(),
            str(song.get("artist") or "").strip(),
        )
    return (
        str(getattr(song, "netease_id", "") or "").strip(),
        str(getattr(song, "title", "") or "").strip(),
        str(getattr(song, "artist", "") or "").strip(),
    )


def _resolve_song_index(songs: list, fallback_index: int, song_key: Optional[tuple[str, str, str]]) -> Optional[int]:
    if not songs:
        return None
    if song_key is None:
        return fallback_index if 0 <= fallback_index < len(songs) else None
    target_nid, target_title, target_artist = song_key
    if 0 <= fallback_index < len(songs) and _make_song_key(songs[fallback_index]) == song_key:
        return fallback_index
    if target_nid:
        for idx, s in enumerate(songs):
            if _make_song_key(s)[0] == target_nid:
                return idx
    for idx, s in enumerate(songs):
        _, s_title, s_artist = _make_song_key(s)
        if s_title == target_title and s_artist == target_artist:
            return idx
    return None


def _auto_search_yt_url(title: str, artist: str) -> str:
    clean_title = title.split("(")[0].split("（")[0].strip()[:40]
    query = f"{clean_title} {artist} official MV"
    with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "remote_components": ["ejs:github"]}) as ydl:
        info = ydl.extract_info(f"ytsearch1:{query}", download=False)
        entries = info.get("entries", [])
        if entries:
            return entries[0].get("url") or entries[0].get("webpage_url") or ""
    return ""


def _worker_download_single(
    index: int,
    force: bool,
    quality: str,
    song_key: Optional[tuple[str, str, str]] = None,
):
    try:
        data = load_playlist()
        songs = data.get("songs", [])
        resolved_index = _resolve_song_index(songs, index, song_key)
        if resolved_index is None:
            log_task("歌曲已移除或序号无效，跳过下载")
            return

        song = songs[resolved_index]
        title, artist = song.get("title", ""), song.get("artist", "")
        url = song.get("youtube_url", "").strip()
        _set_task_progress(f"{artist} - {title}", 15)

        out_path = os.path.join(RAW_DIR, slug(title, artist) + ".mp4")
        if force and os.path.isfile(out_path):
            try:
                os.remove(out_path)
            except Exception:
                pass

        if not url:
            log_task(f"未指定 URL，自动搜索: {title}")
            url = _auto_search_yt_url(title, artist)
            if url:
                song["youtube_url"] = url

        if not url:
            log_task(f"未找到可用的下载链接: {title}")
            return

        log_task(f"开始下载 {title} ({quality}p)...")
        if download_mv(url, out_path, quality=quality, log_fn=log_task):
            song["file_path"] = to_relative_path(out_path)
            save_playlist(data)
            _set_task_progress(progress_percent=75)
            log_task(f"下载成功: {title}")
            _preprocess_after_download(resolved_index, refresh_norm=True)
            _set_task_progress(progress_percent=100)
        else:
            log_task(f"下载失败: {title}")
    except Exception as e:
        log_task(f"下载异常: {e}")


@app.post("/api/download_single")
def download_single_api(req: DownloadSingleRequest):
    data = load_playlist()
    songs = data.get("songs", [])
    if not (0 <= req.index < len(songs)):
        raise HTTPException(status_code=400, detail="无效的歌曲序号")
    target_song = songs[req.index]
    title = target_song.get("title", f"#{req.index + 1}")
    q_count = enqueue_download_job(
        f"下载 MV - {title}",
        _worker_download_single,
        req.index,
        req.force,
        req.quality,
        _make_song_key(target_song),
    )
    return {"status": "queued", "message": f"已加入下载队列: {title}", "queue_count": q_count}


def _worker_download_all(force: bool, quality: str):
    try:
        data = load_playlist()
        songs = data.get("songs", [])
        total = max(1, len(songs))
        bili_downloads = 0
        netease_downloads = 0

        for i, song in enumerate(songs):
            title, artist = song.get("title", ""), song.get("artist", "")
            _set_task_progress(f"[{i+1}/{len(songs)}] {artist} - {title}", int((i / total) * 100))

            out_path = os.path.join(RAW_DIR, slug(title, artist) + ".mp4")
            existing_path = resolve_file_path(song.get("file_path", ""))
            source_mode = song.get("media_source") or "auto"
            if source_mode == "auto":
                if existing_path and "_local." in os.path.basename(existing_path):
                    source_mode = "local"
                elif song.get("youtube_url", "").strip():
                    source_mode = "video_url"

            if not force and existing_path and os.path.isfile(existing_path):
                log_task(f"跳过已存在: {title}")
                _preprocess_after_download(i, refresh_norm=False)
                continue

            if source_mode == "local":
                if existing_path and os.path.isfile(existing_path):
                    _preprocess_after_download(i, refresh_norm=False)
                else:
                    log_task(f"[{title}] 设为本地视频但尚未上传文件，跳过")
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
                    log_task(f"网易云合成MV [{i+1}/{len(songs)}] {title} ({res['quality']})")
                except Exception as ne_err:
                    netease_downloads += 1
                    log_task(f"网易云合成MV失败 ({title}): {ne_err}")
                continue

            if force and os.path.isfile(out_path):
                try:
                    os.remove(out_path)
                except Exception:
                    pass

            url = song.get("youtube_url", "").strip()
            if not url:
                url = _auto_search_yt_url(title, artist)
                if url:
                    song["youtube_url"] = url

            if not url:
                log_task(f"未找到链接: {title}，跳过")
                continue

            if is_bilibili_url(url) and bili_downloads > 0:
                log_task("[B站] 节流等待 2 秒以防风控...")
                time.sleep(2.0)

            log_task(f"下载 [{i+1}/{len(songs)}] {title}...")
            try:
                if download_mv(url, out_path, quality=quality, log_fn=log_task):
                    if is_bilibili_url(url):
                        bili_downloads += 1
                    song["file_path"] = to_relative_path(out_path)
                    save_playlist(data)
                    log_task(f"下载成功: {title}")
                    _preprocess_after_download(i, refresh_norm=True)
                else:
                    log_task(f"下载失败: {title}")
            except Exception as song_err:
                log_task(f"下载异常 ({title}): {song_err}")

        _set_task_progress(progress_percent=100)
        log_task("全部下载流程结束")
    except Exception as e:
        log_task(f"批量下载中断: {e}")


class DownloadAllRequest(BaseModel):
    force: bool = False
    quality: str = "1080"


@app.post("/api/download_all")
def download_all_api(req: DownloadAllRequest):
    if not _start_exclusive_task(_worker_download_all, args=(req.force, req.quality), label="全量下载"):
        return _error_response(400, "当前已有任务在进行中")
    return {"status": "started", "message": "已在后台启动全量下载"}


class NeteaseAudioConfigRequest(BaseModel):
    api_url: Optional[str] = None
    api_key: Optional[str] = None
    default_quality: Optional[str] = None
    script_text: Optional[str] = None


@app.get("/api/netease_audio/config")
def get_netease_audio_config_api():
    return get_music_source_status()


@app.post("/api/netease_audio/config")
def update_netease_audio_config_api(req: NeteaseAudioConfigRequest):
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
    log_task("已更新网易云音源配置")
    return get_music_source_status()


class NeteaseAudioSingleRequest(BaseModel):
    index: int
    mode: str = "video"
    quality: Optional[str] = None
    force: bool = True


def _worker_netease_audio_single(
    index: int,
    mode: str,
    quality: Optional[str],
    force: bool,
    song_key: Optional[tuple[str, str, str]] = None,
):
    try:
        playlist = load_playlist_model(PLAYLIST_FILE)
        resolved_index = _resolve_song_index(playlist.songs, index, song_key)
        if resolved_index is None:
            log_task("歌曲已移除或序号无效，跳过下载")
            return
        song = playlist.songs[resolved_index]
        mode_label = "封面合成 1080p MP4" if mode == "video" else "纯音频"
        _set_task_progress(f"网易云({mode_label}): {song.artist} - {song.title}", 15)

        log_task(f"开始下载网易云音源 ({mode_label}): {song.artist} - {song.title}")
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
        _set_task_progress(progress_percent=80)

        if mode == "video":
            _preprocess_after_download(resolved_index, refresh_norm=True)
            log_task(f"网易云音源 + 封面合成完成: {song.title} ({res['quality']})")
        else:
            log_task(f"网易云纯音频下载完成: {song.title} ({res['quality']})")
        _set_task_progress(progress_percent=100)
    except Exception as e:
        log_task(f"网易云音源下载失败: {e}")


@app.post("/api/netease_audio/download_single")
def netease_audio_download_single_api(req: NeteaseAudioSingleRequest):
    playlist = load_playlist_model(PLAYLIST_FILE)
    if not (0 <= req.index < len(playlist.songs)):
        raise HTTPException(status_code=400, detail="无效的歌曲序号")
    mode = "audio" if req.mode == "audio" else "video"
    target_song = playlist.songs[req.index]
    label = f"网易云{'纯音频' if mode == 'audio' else '封面合成'} - {target_song.title}"
    q_count = enqueue_download_job(
        label,
        _worker_netease_audio_single,
        req.index,
        mode,
        req.quality,
        req.force,
        _make_song_key(target_song),
    )
    return {"status": "queued", "message": f"已加入队列: {label}", "queue_count": q_count}


class NeteaseAudioBatchRequest(BaseModel):
    mode: str = "video"
    quality: Optional[str] = None
    force: bool = False
    missing_only: bool = False


def _worker_netease_audio_batch(mode: str, quality: Optional[str], force: bool, missing_only: bool):
    try:
        playlist = load_playlist_model(PLAYLIST_FILE)
        total = max(1, len(playlist.songs))
        processed_requests = 0

        for i, song in enumerate(playlist.songs):
            _set_task_progress(f"网易云 [{i+1}/{len(playlist.songs)}] {song.title}", int((i / total) * 100))

            if missing_only:
                if mode == "video" and _file_exists(song.file_path):
                    log_task(f"[跳过] 已有视频素材: {song.title}")
                    continue
                if mode == "audio" and _file_exists(song.audio_path):
                    log_task(f"[跳过] 已有纯音频: {song.title}")
                    continue

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
                log_task(f"[{i+1}/{len(playlist.songs)}] {song.title} ({res['quality']})")
            except Exception as song_err:
                processed_requests += 1
                log_task(f"网易云下载异常 ({song.title}): {song_err}")

        _set_task_progress(progress_percent=100)
        log_task("网易云音源批量任务完成")
    except Exception as e:
        log_task(f"网易云批量任务中断: {e}")


@app.post("/api/netease_audio/download_all")
def netease_audio_download_all_api(req: NeteaseAudioBatchRequest):
    mode = "audio" if req.mode == "audio" else "video"
    if not _start_exclusive_task(
        _worker_netease_audio_batch,
        args=(mode, req.quality, req.force, req.missing_only),
        label="网易云批量任务",
    ):
        return _error_response(400, "当前已有任务在进行中")
    return {"status": "started", "message": "已在后台启动网易云批量下载"}


@app.get("/api/status")
def get_status_api():
    with task_lock:
        return dict(tasks_state)


@app.post("/api/logs/clear")
def clear_logs_api():
    with task_lock:
        tasks_state["logs"].clear()
    return {"status": "ok"}


def _worker_preprocess(force: bool):
    try:
        playlist = load_playlist_model(PLAYLIST_FILE)
        total = max(1, len(playlist.songs))
        for i, song in enumerate(playlist.songs):
            _set_task_progress(f"预处理 [{i+1}/{len(playlist.songs)}] {song.title}", int((i / total) * 100))
            preprocess_song(song, BASE_PATH, force=force, log_fn=log_task)
            save_playlist_model(playlist, PLAYLIST_FILE)
        _set_task_progress(progress_percent=100)
        log_task("全部素材预处理 (1:1 封面 + -14 LUFS 响度统一) 完成")
    except Exception as e:
        log_task(f"预处理异常: {e}")


class PreprocessRequest(BaseModel):
    force: bool = False


@app.post("/api/preprocess")
def preprocess_api(req: PreprocessRequest):
    if not _start_exclusive_task(_worker_preprocess, args=(req.force,), label="素材预处理"):
        return _error_response(400, "当前已有任务在进行中")
    return {"status": "started", "message": "已在后台启动预处理"}


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
    for host in ("127.0.0.1", "::1"):
        try:
            with socket.create_connection((host, port), timeout=0.4):
                return True
        except OSError:
            continue
    return False


def _ensure_remotion_public_links() -> None:
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
            if link.is_symlink():
                link.unlink()
            elif os.name == "nt" and is_junction(link):
                os.rmdir(link)
            else:
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
    global _remotion_studio_proc
    remotion_dir = BASE_PATH / "remotion"
    if not remotion_dir.exists():
        msg = "remotion/ 目录不存在"
        log_task(msg)
        return _error_response(404, msg)

    _ensure_remotion_public_links()

    studio_url = f"http://127.0.0.1:{STUDIO_PORT}"
    if _is_port_open(STUDIO_PORT):
        return {"status": "running", "url": studio_url}

    if _remotion_studio_proc is None or _remotion_studio_proc.poll() is not None:
        log_file = BASE_PATH / "remotion" / "studio.log"
        try:
            with open(log_file, "w", encoding="utf-8") as lf:
                _remotion_studio_proc = subprocess.Popen(
                    [_npx_cmd(), "remotion", "studio", "src/index.ts", "--port", str(STUDIO_PORT), "--no-open"],
                    cwd=str(remotion_dir),
                    env=_remotion_env(),
                    stdin=subprocess.DEVNULL,
                    stdout=lf,
                    stderr=subprocess.STDOUT,
                )
        except Exception as e:
            msg = f"Remotion Studio 启动失败: {e}"
            log_task(msg)
            return _error_response(500, msg)

    for _ in range(30):
        if _is_port_open(STUDIO_PORT):
            log_task(f"Remotion Studio 已启动: {studio_url}")
            return {"status": "started", "url": studio_url}
        if _remotion_studio_proc.poll() is not None:
            msg = "Remotion Studio 启动失败，请查看 remotion/studio.log"
            log_task(msg)
            return _error_response(500, msg)
        time.sleep(0.5)

    msg = "Remotion Studio 启动超时，请查看 remotion/studio.log"
    log_task(msg)
    return _error_response(504, msg)


def _worker_remotion_render(output_name: Optional[str]):
    global _remotion_render_proc, _remotion_render_cancelled
    _remotion_render_cancelled = False
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
        log_task(f"启动 Remotion 渲染: {out_file.name}")
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
                _set_task_progress(progress_percent=min(99, int((cur_f / tot_f) * 100)))
                continue
            m = re.search(r"(\d{1,3})%", line)
            if m:
                _set_task_progress(progress_percent=min(99, int(m.group(1))))

        ret = proc.wait()
        if _remotion_render_cancelled:
            log_task("Remotion 渲染已手动停止")
        elif ret == 0 and out_file.exists():
            _set_task_progress(progress_percent=100)
            log_task(f"Remotion 成片导出成功: {out_file}")
        else:
            log_task(f"Remotion 渲染退出码: {ret}")
    except Exception as e:
        log_task(f"Remotion 渲染异常: {e}")
    finally:
        _remotion_render_proc = None


@app.post("/api/remotion/cancel")
def cancel_remotion_render():
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
    if not _start_exclusive_task(
        _worker_remotion_render,
        args=(req.output_name,),
        label="Remotion 全片渲染中...",
        flag="is_rendering",
    ):
        return _error_response(400, "当前已有任务在进行中，请稍候")
    return {"status": "started", "message": "已在后台启动 Remotion 全片渲染"}


if __name__ == "__main__":
    _ensure_remotion_public_links()
    print(f"MRV-02 Web Studio: http://127.0.0.1:{WEB_PORT}")
    uvicorn.run(app, host="127.0.0.1", port=WEB_PORT, log_level="warning")
