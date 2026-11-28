"""
download.py — Phase 1: 下载 MV / 视频素材（最高高清画质 1080p+），自动写回 playlist.json

借鉴与整合了 video-downloader 项目的最高画质策略：
  - 自动调用 deno/ejs 求解 YouTube JS 校验，解锁完整 1080p/4K 码率与格式
  - 优先下载 H.264(AVC) + AAC 最佳轨并无损混流封装为标准 MP4，Premiere Pro 剪辑最流畅
  - 自动备选 VP9/AV1 + Opus 高清轨，由 FFmpeg 后台自动封装

用法：
    python download.py                                    # 下载未完成的歌曲
    python download.py --force                            # 强制重新下载（覆盖之前的低画质）
    python download.py --quality 1080                     # 指定画质（默认 1080，可选 720, 1080, best）
    python download.py --only "Our Love Is Alive"         # 针对指定单曲下载
    python download.py --netease "https://music.163.com/..." # 一键解析网易云并下载
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
from typing import Callable
import yt_dlp
from backend.netease import import_netease_playlist

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAYLIST = os.path.join(BASE_DIR, "playlist.json")
RAW_DIR = os.path.join(BASE_DIR, "raw")
os.makedirs(RAW_DIR, exist_ok=True)

# Cache the first working browser for Bilibili cookies during this process
_CACHED_BILI_BROWSER: str | None = None
YOUTUBE_COOKIES_FILENAME = "youtube_cookies.txt"
_BILI_COOKIE_CANDIDATE_FILES = ("cookies.txt", "bilibili_cookies.txt")
_BILI_DEFAULT_BROWSERS = ("edge", "chrome", "firefox")


def is_bilibili_url(url: str) -> bool:
    """Return True if the URL points to Bilibili."""
    lower = (url or "").lower()
    return "bilibili.com" in lower or "b23.tv" in lower


def _is_cookie_load_error(err: Exception) -> bool:
    """Detect browser cookie extraction failures (locked DB, DPAPI, missing profile)."""
    msg = str(err).lower()
    keywords = (
        "could not copy",
        "cookie",
        "dpapi",
        "failed to decrypt",
        "cannot find",
        "database is locked",
        "permission denied",
        "app-bound",
    )
    return any(k in msg for k in keywords)


def _is_risk_control_error(err: Exception) -> bool:
    """Detect Bilibili HTTP 412 risk-control errors."""
    msg = str(err).lower()
    return "412" in msg or "precondition failed" in msg


def _find_local_cookie_file(explicit_file: str | None = None) -> str | None:
    """Locate a Netscape cookies.txt file from explicit arg, env var, or project root."""
    candidates = []
    if explicit_file:
        candidates.append(explicit_file)
    env_file = os.environ.get("BILI_COOKIES_FILE", "").strip()
    if env_file:
        candidates.append(env_file)
    for name in _BILI_COOKIE_CANDIDATE_FILES:
        candidates.append(os.path.join(BASE_DIR, name))

    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def to_relative_path(path: str, base_dir: str = BASE_DIR) -> str:
    """Convert a path inside base_dir to a portable forward-slash relative path."""
    if not path:
        return ""
    norm_path = os.path.abspath(path)
    norm_base = os.path.abspath(base_dir)
    try:
        rel = os.path.relpath(norm_path, norm_base)
        if not rel.startswith(".."):
            return rel.replace("\\", "/")
    except ValueError:
        pass
    return path.replace("\\", "/")


def resolve_file_path(file_path: str, base_dir: str = BASE_DIR, raw_dir: str = RAW_DIR) -> str:
    """Resolve relative, current-OS absolute, or cross-OS legacy file_path to an existing local path."""
    if not file_path:
        return ""
    if os.path.isabs(file_path) and os.path.isfile(file_path):
        return file_path
    normalized = file_path.replace("\\", "/")
    if not os.path.isabs(file_path) and not re.match(r"^[A-Za-z]:/", normalized):
        candidate = os.path.normpath(os.path.join(base_dir, *normalized.split("/")))
        if os.path.isfile(candidate):
            return candidate
        return candidate
    basename = normalized.rsplit("/", 1)[-1]
    if basename:
        raw_candidate = os.path.join(raw_dir, basename)
        if os.path.isfile(raw_candidate):
            return raw_candidate
    return file_path


def slug(title: str, artist: str) -> str:
    """Generate safe filename slug from artist and title."""
    return re.sub(r"[^\w\-]", "_", f"{artist}_{title}")


def search_youtube(query: str) -> str | None:
    """Search YouTube and return the top matching video URL."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch1:{query}", download=False)
        entries = info.get("entries", [])
        if entries:
            return entries[0].get("url") or entries[0].get("webpage_url")
    return None


def get_format_selector(quality: str = "1080", prefer_sdr: bool = True) -> str:
    """
    Build yt-dlp format selector string.
    Excludes AV1 in the primary branch so H.264(AVC) and HEVC compete by resolution & 60fps
    (both have hardware decode in Premiere Pro). When prefer_sdr is True, prefers SDR streams
    first to prevent HDR/Dolby Vision color washout in Rec.709 Premiere sequences.
    """
    if quality == "best":
        height_filter = ""
    elif quality == "720":
        height_filter = "[height<=720]"
    else:  # default 1080
        height_filter = "[height<=1080]"

    branches: list[str] = []
    if prefer_sdr:
        # 1. SDR + non-AV1 (AVC/HEVC compete together so 60fps HEVC beats 30fps AVC)
        branches.append(
            f"bestvideo{height_filter}[dynamic_range=SDR][vcodec!^=av01]+bestaudio[acodec^=mp4a]"
        )
        branches.append(
            f"bestvideo{height_filter}[dynamic_range=SDR][vcodec!^=av01]+bestaudio"
        )
    # 2. Fallback when extractor omits dynamic_range metadata (format_sort still prefers SDR)
    branches.append(f"bestvideo{height_filter}[vcodec!^=av01]+bestaudio[acodec^=mp4a]")
    branches.append(f"bestvideo{height_filter}[vcodec!^=av01]+bestaudio")
    # 3. Final fallbacks including any codec / progressive stream
    branches.append(f"bestvideo{height_filter}+bestaudio")
    if height_filter:
        branches.append(f"best{height_filter}")
    branches.append("best")
    return "/".join(branches)


def get_format_sort(quality: str = "1080", prefer_sdr: bool = True) -> list[str]:
    """
    Build yt-dlp format_sort priority list:
    SDR first (when prefer_sdr=True) -> target resolution -> highest fps (60fps over 30fps)
    -> H.264 tie-breaker -> higher bitrate -> AAC audio.
    """
    sort_keys: list[str] = []
    if prefer_sdr:
        # In yt-dlp format_sort, '+' sorts ascending (SDR before HDR)
        sort_keys.append("+hdr")
    if quality == "best":
        sort_keys.append("res")
    elif quality == "720":
        sort_keys.append("res:720")
    else:
        sort_keys.append("res:1080")
    sort_keys.extend(["fps", "vcodec:h264", "tbr", "acodec:aac"])
    return sort_keys


def _run_yt_dlp_with_retry(
    url: str,
    base_opts: dict,
    max_attempts: int = 2,
    log_fn: Callable[[str], None] | None = None,
) -> None:
    """
    Execute yt-dlp download. On transient network/403/412 failures, re-creates YoutubeDL
    after a short backoff so Bilibili playurl and signed CDN URLs are freshly resolved.
    """
    log = log_fn or print
    last_err: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            with yt_dlp.YoutubeDL(dict(base_opts)) as ydl:
                ydl.download([url])
            return
        except Exception as err:
            last_err = err
            # Propagate cookie extraction errors immediately so caller can fall back
            if _is_cookie_load_error(err):
                raise
            if _is_risk_control_error(err):
                log("[B站风控] 触发 HTTP 412 风控，请稍等 1-2 分钟后重试或检查登录 Cookie")
                if attempt < max_attempts:
                    time.sleep(5)
                    continue
                raise RuntimeError(
                    "触发 B 站 412 风控，请稍等 1-2 分钟后重试或检查 Cookie"
                ) from err
            if attempt < max_attempts:
                log(f"[重试 {attempt}/{max_attempts - 1}] 重新解析播放地址并重试: {err}")
                time.sleep(3)
                continue
            raise
    if last_err:
        raise last_err


def download_mv(
    url: str,
    out_path: str,
    quality: str = "1080",
    cookies_browser: str | None = None,
    cookies_file: str | None = None,
    prefer_sdr: bool = True,
    log_fn: Callable[[str], None] | None = None,
) -> bool:
    """
    Download video with high quality (60fps & SDR preferred for Premiere Pro) and merge into MP4.
    For Bilibili URLs, automatically uses cookies.txt or browser cookies when available
    to unlock 1080p60/4K streams, falling back gracefully to guest mode if cookies cannot be read.
    """
    global _CACHED_BILI_BROWSER
    log = log_fn or print

    fmt = get_format_selector(quality, prefer_sdr=prefer_sdr)
    fmt_sort = get_format_sort(quality, prefer_sdr=prefer_sdr)
    node_path = shutil.which("node") or shutil.which(
        "node", path="/opt/homebrew/bin:/usr/local/bin"
    )
    opts: dict = {
        "format": fmt,
        "format_sort": fmt_sort,
        "outtmpl": out_path,
        "merge_output_format": "mp4",
        "remote_components": ["ejs:github"],
        "quiet": False,
        "retries": 3,
    }
    if node_path:
        opts["js_runtimes"] = {"node": {"path": node_path}}

    if not is_bilibili_url(url):
        resolved_yt_cookie = next((
            candidate for candidate in (
                cookies_file,
                os.path.join(BASE_DIR, YOUTUBE_COOKIES_FILENAME),
                os.path.join(BASE_DIR, "cookies.txt"),
            )
            if candidate and os.path.isfile(candidate)
        ), None)
        if resolved_yt_cookie:
            log(f"[YouTube] 使用本地 Cookie 文件: {os.path.basename(resolved_yt_cookie)}")
            opts["cookiefile"] = resolved_yt_cookie
        elif cookies_browser and cookies_browser.lower() not in ("none", "off", "false", "0"):
            opts["cookiesfrombrowser"] = (cookies_browser.lower(),)
        try:
            _run_yt_dlp_with_retry(url, opts, max_attempts=2, log_fn=log)
            return os.path.isfile(out_path)
        except Exception as yt_err:
            err_lower = str(yt_err).lower()
            if "sign in to confirm" in err_lower or "not a bot" in err_lower:
                log(
                    "[YouTube] 当前网络 IP 触发了 YouTube 人机验证。"
                    "如已在浏览器登录，可通过 Batch 导入 YouTube cookies.txt 后重试。"
                )
            raise

    # Bilibili-specific headers to prevent CDN 403
    opts["http_headers"] = {"Referer": "https://www.bilibili.com/"}

    # 1. Prefer explicit or local cookies.txt if present
    resolved_file = _find_local_cookie_file(cookies_file)
    if resolved_file:
        log(f"[B站] 使用本地 Cookie 文件: {os.path.basename(resolved_file)}")
        file_opts = dict(opts, cookiefile=resolved_file)
        _run_yt_dlp_with_retry(url, file_opts, max_attempts=2, log_fn=log)
        return os.path.isfile(out_path)

    # 2. Otherwise try browser cookies unless explicitly disabled
    browser_pref = (
        cookies_browser
        if cookies_browser is not None
        else os.environ.get("BILI_COOKIES_BROWSER", "").strip()
    )
    if browser_pref.lower() in ("none", "off", "false", "0"):
        _run_yt_dlp_with_retry(url, opts, max_attempts=2, log_fn=log)
        return os.path.isfile(out_path)

    if browser_pref:
        browsers_to_try = [browser_pref.lower()]
    elif _CACHED_BILI_BROWSER:
        browsers_to_try = [_CACHED_BILI_BROWSER]
    else:
        browsers_to_try = list(_BILI_DEFAULT_BROWSERS)

    for browser in browsers_to_try:
        try:
            browser_opts = dict(opts, cookiesfrombrowser=(browser,))
            log(f"[B站] 尝试读取 {browser} 浏览器 Cookie 解锁高清/60帧...")
            _run_yt_dlp_with_retry(url, browser_opts, max_attempts=2, log_fn=log)
            _CACHED_BILI_BROWSER = browser
            return os.path.isfile(out_path)
        except Exception as err:
            if _is_cookie_load_error(err):
                log(f"[B站] 读取 {browser} Cookie 失败（可能浏览器正在运行或加密限制），尝试下一方式...")
                continue
            raise

    # 3. Graceful fallback to guest mode when browser cookies are unavailable
    log(
        "[B站] 未能读取浏览器 Cookie，已回退为游客下载（画质可能受限于 480P/30fps；"
        "如需 1080P60 请关闭浏览器重试，或导出 cookies.txt 放到项目根目录）"
    )
    _run_yt_dlp_with_retry(url, opts, max_attempts=2, log_fn=log)
    return os.path.isfile(out_path)


def main():
    parser = argparse.ArgumentParser(description="高清 MV 素材下载工具")
    parser.add_argument("--only", default="", help="只下载包含此歌名的歌曲")
    parser.add_argument("--netease", default="", help="网易云歌单链接，先解析再下载")
    parser.add_argument("--limit", type=int, default=10, help="网易云歌单歌曲数量上限")
    parser.add_argument("--quality", default="1080", choices=["720", "1080", "best"], help="视频画质 (默认 1080)")
    parser.add_argument("--force", action="store_true", help="强制重新下载（覆盖已有文件）")
    parser.add_argument(
        "--cookies-browser",
        default=None,
        help="B站 Cookie 来源浏览器 (如 edge, chrome, firefox；传 none 禁用)",
    )
    parser.add_argument(
        "--cookies-file",
        default=None,
        help="Netscape 格式 cookies.txt 路径（默认自动检测项目根目录下的 cookies.txt）",
    )
    parser.add_argument(
        "--allow-hdr",
        action="store_true",
        help="允许下载 HDR 流（默认优先 SDR 以防 Premiere Pro Rec.709 序列偏色）",
    )
    parser.add_argument(
        "--netease-fallback",
        action="store_true",
        help="当 YouTube/B站 搜索或下载 MV 失败时，自动使用网易云音源 + 专辑封面合成 1080p MP4",
    )
    parser.add_argument(
        "--netease-quality",
        default="flac",
        help="网易云兜底音源期望音质 (如 flac, 320k, 128k，默认 flac 自动降级)",
    )
    args = parser.parse_args()

    if args.netease:
        print(f"[网易云] 正在从链接解析歌单: {args.netease}")
        try:
            count, name = import_netease_playlist(args.netease, limit=args.limit, output_path=PLAYLIST)
            print(f"[网易云] 成功解析《{name}》，已导入 {count} 首歌曲。\n")
        except Exception as e:
            print(f"[ERROR] 解析网易云歌单失败: {e}")
            sys.exit(1)

    with open(PLAYLIST, encoding="utf-8") as f:
        data = json.load(f)

    changed = False
    bili_downloads = 0
    for song in data["songs"]:
        title, artist = song["title"], song["artist"]
        if args.only and args.only.lower() not in title.lower():
            continue

        out_path = os.path.join(RAW_DIR, slug(title, artist) + ".mp4")

        # Skip existing file unless --force is specified
        existing_path = resolve_file_path(song.get("file_path", ""))
        if existing_path and os.path.isfile(existing_path):
            if not args.force:
                print(f"[SKIP] 已存在: {title} (使用 --force 可重新以 1080p 高清覆盖)")
                continue
            else:
                try:
                    os.remove(existing_path)
                except Exception:
                    pass

        url = song.get("youtube_url") or ""
        if not url:
            # Trim long titles for cleaner YouTube search matching
            clean_title = title.split("(")[0].split("（")[0].strip()[:40]
            query = f"{clean_title} {artist} official MV"
            print(f"[搜索] {query} ...")
            url = search_youtube(query)

        if not url:
            if args.netease_fallback:
                print(f"[兜底] 未找到 MV，尝试用网易云音源 + 封面合成: {title}")
                try:
                    from pathlib import Path
                    from backend.netease_audio import download_netease_for_song
                    from backend.schema import SongItem

                    song_model = SongItem.model_validate(song)
                    res = download_netease_for_song(
                        song_model,
                        base_dir=Path(BASE_DIR),
                        mode="video",
                        quality=args.netease_quality,
                        force=args.force,
                    )
                    song["netease_id"] = song_model.netease_id
                    song["audio_path"] = res["audio_path"]
                    song["file_path"] = res["video_path"]
                    if song_model.cover_path:
                        song["cover_path"] = song_model.cover_path
                    changed = True
                    print(f"[OK] 网易云合成完成: {res['video_path']}")
                except Exception as ne:
                    print(f"[ERROR] 网易云兜底失败 ({title}): {ne}")
            else:
                print(f"[WARN] 找不到: {title}，跳过")
            continue

        # Throttle consecutive Bilibili requests to avoid HTTP 412 risk control
        if is_bilibili_url(url) and bili_downloads > 0:
            time.sleep(2.0)

        print(f"[下载高清 {args.quality}p] {title} → {out_path}")
        try:
            if download_mv(
                url,
                out_path,
                quality=args.quality,
                cookies_browser=args.cookies_browser,
                cookies_file=args.cookies_file,
                prefer_sdr=not args.allow_hdr,
            ):
                if is_bilibili_url(url):
                    bili_downloads += 1
                song["file_path"] = to_relative_path(out_path)
                changed = True
                print(f"[OK] {out_path}")
        except Exception as e:
            print(f"[ERROR] {title}: {e}")

    if changed:
        with open(PLAYLIST, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("\n[完成] playlist.json 已更新，可在 Remotion Studio 预览或导出成片。")


if __name__ == "__main__":
    main()
