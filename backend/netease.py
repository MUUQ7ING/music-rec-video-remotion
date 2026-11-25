"""
netease.py — Parse NetEase Cloud Music (网易云音乐) playlists into playlist.json

Usage:
    python netease.py "https://music.163.com/playlist?id=3778678"
    python netease.py "3778678" --limit 5
    python netease.py "分享歌单... https://163cn.tv/abc" --duration 45 --append
"""

import argparse
import json
import os
import re
import sys
import requests

PLAYLIST_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "playlist.json"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://music.163.com/",
}


def extract_playlist_id(text_or_url: str) -> str | None:
    """Extract NetEase playlist ID from URL, share text, or pure ID string."""
    text = text_or_url.strip()

    # If already pure digits
    if text.isdigit():
        return text

    # Extract HTTP/HTTPS URL from any surrounding share text
    url_match = re.search(r"https?://[^\s]+", text)
    url = url_match.group(0) if url_match else text

    # Follow redirects if short link or mobile link without ID
    if any(domain in url for domain in ["163cn.tv", "163.lu", "y.music.163.com"]):
        try:
            resp = requests.head(url, headers=HEADERS, allow_redirects=True, timeout=8)
            url = resp.url
        except Exception:
            pass

    # Regex search for id=(\d+)
    m = re.search(r"playlist[/?].*?id=(\d+)", url)
    if m:
        return m.group(1)

    m = re.search(r"id=(\d+)", url)
    if m:
        return m.group(1)

    return None


def fetch_playlist_data(playlist_id: str) -> dict:
    """Fetch playlist metadata and track list from NetEase API."""
    # API 1: traditional endpoint with full track list
    url1 = f"https://music.163.com/api/playlist/detail?id={playlist_id}"
    try:
        resp = requests.get(url1, headers=HEADERS, timeout=10)
        data = resp.json()
        if data.get("code") == 200 and data.get("result"):
            res = data["result"]
            return {
                "name": res.get("name", "网易云歌单"),
                "description": res.get("description", ""),
                "tracks": res.get("tracks", []),
            }
    except Exception as e:
        print(f"[WARN] API 1 failed: {e}")

    # Fallback API 2: v1 endpoint
    url2 = f"https://music.163.com/api/v1/playlist/detail?id={playlist_id}"
    try:
        resp = requests.get(url2, headers=HEADERS, timeout=10)
        data = resp.json()
        if data.get("code") == 200 and data.get("playlist"):
            pl = data["playlist"]
            return {
                "name": pl.get("name", "网易云歌单"),
                "description": pl.get("description", ""),
                "tracks": pl.get("tracks", []),
            }
    except Exception as e:
        print(f"[ERROR] API 2 failed: {e}")

    raise RuntimeError(f"无法获取网易云歌单 (ID: {playlist_id}) 的数据，请检查网络或歌单是否为公开。")


def format_seconds(seconds: float) -> str:
    """Format seconds into MM:SS string."""
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f"{m}:{s:02d}"


def parse_time_str(time_str: str) -> float:
    """Parse MM:SS or seconds string into float seconds."""
    parts = str(time_str).strip().split(":")
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    elif len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    return float(time_str)


def convert_tracks_to_songs(
    tracks: list[dict],
    limit: int = 10,
    default_start: str = "0:45",
    clip_duration: float = 45.0,
) -> list[dict]:
    """Convert NetEase tracks to playlist.json song structures."""
    songs = []
    selected = tracks[:limit] if limit > 0 else tracks

    start_sec = parse_time_str(default_start)

    for t in selected:
        title = t.get("name", "").strip()
        artists_list = [a.get("name", "").strip() for a in t.get("artists", [])]
        artist = " / ".join(filter(None, artists_list)) or "未知艺人"
        album_obj = t.get("album") or {}
        album = album_obj.get("name", "").strip()
        cover_url = album_obj.get("picUrl", "").strip()

        # If track duration is short, adjust start time
        dur_ms = t.get("duration", 0)
        dur_sec = dur_ms / 1000.0 if dur_ms > 0 else 240.0

        cur_start = start_sec
        if cur_start + clip_duration > dur_sec:
            cur_start = max(0.0, dur_sec - clip_duration)
        cur_end = cur_start + clip_duration

        songs.append({
            "title": title,
            "artist": artist,
            "album": album,
            "netease_id": str(t.get("id", "") or ""),
            "cover_url": cover_url,
            "youtube_url": "",
            "start": format_seconds(cur_start),
            "end": format_seconds(cur_end),
            "file_path": "",
            "template": "annual",
            "reason": "",
        })

    return songs


NETEASE_PLACEHOLDER_PIC = "5639395138885805"


def fetch_song_cover_url(song_id: int | str) -> str | None:
    """Fetch official album cover URL for a NetEase song ID via song/detail."""
    try:
        resp = requests.get(
            "https://music.163.com/api/song/detail/",
            params={"id": str(song_id), "ids": f"[{song_id}]"},
            headers=HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        songs = resp.json().get("songs") or []
        if songs:
            pic_url = ((songs[0].get("album") or {}).get("picUrl") or "").strip()
            if pic_url and NETEASE_PLACEHOLDER_PIC not in pic_url:
                return pic_url
    except Exception:
        pass
    return None


def search_netease_cover_url(
    title: str,
    artist: str = "",
    album: str = "",
) -> str | None:
    """Search NetEase Cloud Music by title/artist/album and return official album picUrl."""
    clean_artist = artist.split("/")[0].split(",")[0].strip()
    queries = []
    if title and clean_artist:
        queries.append(f"{title} {clean_artist}")
    if title:
        queries.append(title)

    for q in queries:
        try:
            resp = requests.post(
                "https://music.163.com/api/search/get/web",
                data={"s": q, "type": 1, "limit": 5, "offset": 0},
                headers=HEADERS,
                timeout=10,
            )
            resp.raise_for_status()
            songs = (resp.json().get("result") or {}).get("songs") or []
            if not songs:
                continue

            # Prefer track matching album or artist name if available
            best = songs[0]
            album_lower = album.lower().strip()
            artist_lower = clean_artist.lower()
            for cand in songs:
                c_album = ((cand.get("album") or {}).get("name") or "").lower()
                c_artists = " ".join(
                    a.get("name", "").lower() for a in (cand.get("artists") or [])
                )
                if album_lower and album_lower in c_album:
                    best = cand
                    break
                if artist_lower and artist_lower in c_artists:
                    best = cand
                    break

            pic_url = ((best.get("album") or {}).get("picUrl") or "").strip()
            if pic_url and NETEASE_PLACEHOLDER_PIC not in pic_url:
                return pic_url

            song_id = best.get("id")
            if song_id:
                detail_url = fetch_song_cover_url(song_id)
                if detail_url:
                    return detail_url
        except Exception:
            continue
    return None


def search_netease_song_id(
    title: str,
    artist: str = "",
    album: str = "",
) -> str | None:
    """Search NetEase Cloud Music by title/artist/album and return the best matching song ID."""
    clean_artist = artist.split("/")[0].split(",")[0].strip()
    queries = []
    if title and clean_artist:
        queries.append(f"{title} {clean_artist}")
    if title:
        queries.append(title)

    for q in queries:
        try:
            resp = requests.post(
                "https://music.163.com/api/search/get/web",
                data={"s": q, "type": 1, "limit": 5, "offset": 0},
                headers=HEADERS,
                timeout=10,
            )
            resp.raise_for_status()
            songs = (resp.json().get("result") or {}).get("songs") or []
            if not songs:
                continue

            best = songs[0]
            album_lower = album.lower().strip()
            artist_lower = clean_artist.lower()
            for cand in songs:
                c_album = ((cand.get("album") or {}).get("name") or "").lower()
                c_artists = " ".join(
                    a.get("name", "").lower() for a in (cand.get("artists") or [])
                )
                if album_lower and album_lower in c_album:
                    best = cand
                    break
                if artist_lower and artist_lower in c_artists:
                    best = cand
                    break

            sid = best.get("id")
            if sid:
                return str(sid)
        except Exception:
            continue
    return None


def fetch_netease_lyrics(song_id: int | str) -> tuple[str, str]:
    """Fetch original LRC and Chinese translation LRC from NetEase Cloud Music."""
    try:
        resp = requests.get(
            "https://music.163.com/api/song/lyric",
            params={"id": str(song_id), "lv": 1, "tv": 1, "kv": -1},
            headers=HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        orig_lrc = ((data.get("lrc") or {}).get("lyric") or "").strip()
        trans_lrc = ((data.get("tlyric") or {}).get("lyric") or "").strip()
        return orig_lrc, trans_lrc
    except Exception:
        return "", ""


def import_netease_playlist(
    input_str: str,
    limit: int = 10,
    default_start: str = "0:45",
    clip_duration: float = 45.0,
    append: bool = False,
    output_path: str = PLAYLIST_FILE,
) -> tuple[int, str]:
    """
    Main function to fetch NetEase playlist and save to playlist.json.
    Returns (added_count, playlist_name).
    """
    pid = extract_playlist_id(input_str)
    if not pid:
        raise ValueError(f"无法识别网易云歌单链接或 ID: '{input_str}'")

    print(f"[解析] 正在读取网易云歌单 ID: {pid} ...")
    pl_data = fetch_playlist_data(pid)
    pl_name = pl_data["name"]
    tracks = pl_data["tracks"]

    print(f"[成功] 获取到歌单《{pl_name}》，共 {len(tracks)} 首歌曲。")

    new_songs = convert_tracks_to_songs(
        tracks,
        limit=limit,
        default_start=default_start,
        clip_duration=clip_duration,
    )

    # Load existing playlist.json or create default template
    if os.path.isfile(output_path):
        with open(output_path, "r", encoding="utf-8") as f:
            try:
                config = json.load(f)
            except Exception:
                config = {}
    else:
        config = {}

    config.setdefault("_comment", "音乐推荐视频歌单配置 — 由 download.py 下载素材后自动补全 file_path")
    config.setdefault("output_sequence_name", pl_name)
    config.setdefault("resolution", {"width": 1920, "height": 1080})
    config.setdefault("fps", 30)

    if append and "songs" in config and isinstance(config["songs"], list):
        # Prevent duplicates based on (title, artist)
        existing_keys = {
            (s.get("title", "").strip().lower(), s.get("artist", "").strip().lower())
            for s in config["songs"]
        }
        added = 0
        for song in new_songs:
            key = (song["title"].strip().lower(), song["artist"].strip().lower())
            if key not in existing_keys:
                config["songs"].append(song)
                existing_keys.add(key)
                added += 1
            else:
                print(f"[跳过重复] 《{song['title']}》已存在于配置中")
    else:
        config["output_sequence_name"] = pl_name
        config["songs"] = new_songs
        added = len(new_songs)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

    return added, pl_name


def main():
    parser = argparse.ArgumentParser(description="网易云音乐歌单自动解析与配置生成工具")
    parser.add_argument("url", help="网易云歌单链接、分享文本或歌单ID (例如 https://music.163.com/playlist?id=3778678 或 3778678)")
    parser.add_argument("--limit", type=int, default=10, help="最多导入歌曲数 (默认 10 首；设为 0 则导入全部)")
    parser.add_argument("--start", default="0:45", help="默认片段截取起始时间 (例如 0:45)")
    parser.add_argument("--duration", type=float, default=45.0, help="每个片段默认截取时长 (秒，默认 45)")
    parser.add_argument("--append", action="store_true", help="追加到已有 playlist.json，不覆盖原有歌曲")
    parser.add_argument("--out", default=PLAYLIST_FILE, help="输出文件路径 (默认 playlist.json)")

    args = parser.parse_args()

    try:
        added_count, pl_name = import_netease_playlist(
            input_str=args.url,
            limit=args.limit,
            default_start=args.start,
            clip_duration=args.duration,
            append=args.append,
            output_path=args.out,
        )
        print(f"\n[完成] 成功导入 {added_count} 首歌曲到 {args.out} (歌单: 《{pl_name}》)！")
        print("💡 下一步：你可以打开 playlist.json 调整裁剪时间戳或推荐语，然后运行 python download.py 开始下载素材。")
    except Exception as e:
        print(f"\n[错误] {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
