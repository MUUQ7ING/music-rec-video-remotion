"""lyrics.py — Bilingual LRC lyric fetcher, parser, and structured JSON exporter.

Fetches original + Chinese translation LRC directly from NetEase Cloud Music API
(no audio download required), aligns translations to original timestamps, filters
metadata lines, and saves per-song JSON to lyrics/<slug>.json.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Callable

from backend.download import slug
from backend.netease import fetch_netease_lyrics_full, search_netease_song_id
from backend.preprocess import parse_time_str
from backend.schema import PlaylistConfig, SongItem, load_playlist, save_playlist

TIME_TAG_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]")
YRC_LINE_RE = re.compile(r"^\[(\d+),(\d+)\](.*)$")
YRC_WORD_RE = re.compile(r"\((\d+),(\d+),\d+\)(.*?)(?=\(\d+,\d+,\d+\)|$)")
META_PREFIX_RE = re.compile(
    r"^(作词|作曲|编曲|制作人|混音|母带|录音|和声|吉他|贝斯|鼓|键盘|监制|词|曲|演唱|歌手|Lyrics|Composed|Arranged|Produced|Mixed|Mastered)\s*[:：]",
    re.IGNORECASE,
)


def parse_lrc_lines(lrc_text: str) -> list[tuple[float, str]]:
    """Parse LRC text into sorted list of (time_sec, text)."""
    entries: list[tuple[float, str]] = []
    if not lrc_text:
        return entries

    for raw_line in lrc_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        tags = TIME_TAG_RE.findall(line)
        if not tags:
            continue
        lyric_body = TIME_TAG_RE.sub("", line).strip()
        if not lyric_body or META_PREFIX_RE.match(lyric_body):
            continue
        for mm, ss, frac in tags:
            sec = int(mm) * 60 + int(ss)
            if frac:
                sec += int(frac) / (10 ** len(frac))
            entries.append((round(sec, 3), lyric_body))

    entries.sort(key=lambda x: x[0])
    return entries


def merge_bilingual_lrc(orig_lrc: str, trans_lrc: str, tol_sec: float = 0.25) -> list[dict]:
    """Pair original LRC lines with closest Chinese translation lines within tol_sec."""
    orig_lines = parse_lrc_lines(orig_lrc)
    trans_lines = parse_lrc_lines(trans_lrc)
    if not orig_lines:
        return []

    merged: list[dict] = []
    t_idx = 0
    n_trans = len(trans_lines)

    for o_time, o_text in orig_lines:
        matched_trans = ""
        # Advance pointer to nearest translation timestamp
        while t_idx < n_trans and trans_lines[t_idx][0] < o_time - tol_sec:
            t_idx += 1
        if t_idx < n_trans and abs(trans_lines[t_idx][0] - o_time) <= tol_sec:
            cand = trans_lines[t_idx][1]
            if cand and cand != o_text:
                matched_trans = cand
            t_idx += 1

        merged.append({
            "time": o_time,
            "orig": o_text,
            "trans": matched_trans,
        })
    return merged


def parse_yrc_lines(yrc_text: str) -> list[dict]:
    """Parse NetEase YRC word-level lyric text into sorted line dicts with word timestamps."""
    parsed: list[dict] = []
    if not yrc_text:
        return parsed

    for raw_line in yrc_text.splitlines():
        line = raw_line.strip()
        if not line or not line.startswith("["):
            continue
        m = YRC_LINE_RE.match(line)
        if not m:
            continue
        line_start_ms = int(m.group(1))
        line_dur_ms = int(m.group(2))
        body = m.group(3)

        words: list[dict] = []
        raw_parts: list[str] = []
        for wm in YRC_WORD_RE.finditer(body):
            w_start_ms = int(wm.group(1))
            w_dur_ms = int(wm.group(2))
            w_text = wm.group(3)
            if not w_text:
                continue
            raw_parts.append(w_text)
            words.append({
                "start": round(w_start_ms / 1000.0, 3),
                "end": round((w_start_ms + max(0, w_dur_ms)) / 1000.0, 3),
                "text": w_text,
            })

        orig_text = "".join(raw_parts).strip()
        if not orig_text or META_PREFIX_RE.match(orig_text):
            continue

        parsed.append({
            "time": round(line_start_ms / 1000.0, 3),
            "end": round((line_start_ms + max(0, line_dur_ms)) / 1000.0, 3),
            "orig": orig_text,
            "words": words,
        })

    parsed.sort(key=lambda x: x["time"])
    return parsed


def merge_bilingual_yrc(yrc_text: str, trans_lrc: str, tol_sec: float = 0.35) -> list[dict]:
    """Pair YRC word-level lines with closest Chinese translation lines within tol_sec."""
    yrc_lines = parse_yrc_lines(yrc_text)
    if not yrc_lines:
        return []

    trans_lines = parse_lrc_lines(trans_lrc)
    t_idx = 0
    n_trans = len(trans_lines)
    merged: list[dict] = []

    for item in yrc_lines:
        o_time = item["time"]
        o_text = item["orig"]
        matched_trans = ""
        while t_idx < n_trans and trans_lines[t_idx][0] < o_time - tol_sec:
            t_idx += 1
        if t_idx < n_trans and abs(trans_lines[t_idx][0] - o_time) <= tol_sec:
            cand = trans_lines[t_idx][1]
            if cand and cand != o_text:
                matched_trans = cand
            t_idx += 1

        merged.append({
            "time": o_time,
            "end": item["end"],
            "orig": o_text,
            "trans": matched_trans,
            "words": item["words"],
        })
    return merged


def fetch_and_save_lyrics(
    song: SongItem,
    project_root: Path,
    force: bool = False,
    log: Callable[[str], None] | None = None,
) -> Path | None:
    """Fetch bilingual lyrics (with YRC word-level timing if available) from NetEase."""
    out_dir = project_root / "lyrics"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{slug(song.title, song.artist)}.json"

    if not force and out_path.is_file():
        song.lyrics_path = out_path.relative_to(project_root).as_posix()
        return out_path

    sid = (song.netease_id or "").strip()
    if not sid:
        sid = search_netease_song_id(song.title, song.artist, song.album) or ""
        if sid:
            song.netease_id = sid

    if not sid:
        if log:
            log(f"[WARN] NetEase song ID not found for: {song.artist} - {song.title}")
        return None

    orig_lrc, trans_lrc, yrc_lrc = fetch_netease_lyrics_full(sid)
    lines = merge_bilingual_yrc(yrc_lrc, trans_lrc)
    has_word_timing = bool(lines)
    if not lines:
        lines = merge_bilingual_lrc(orig_lrc, trans_lrc)
    if not lines:
        if log:
            log(f"[INFO] Instrumental or no timed lyrics: {song.title} (id={sid})")
        return None

    payload = {
        "netease_id": sid,
        "title": song.title,
        "artist": song.artist,
        "has_translation": any(bool(item["trans"]) for item in lines),
        "has_word_timing": has_word_timing,
        "lines": lines,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rel = out_path.relative_to(project_root).as_posix()
    song.lyrics_path = rel
    if log:
        log(
            f"Fetched lyrics: {rel} ({len(lines)} lines, "
            f"bilingual={payload['has_translation']}, word_timing={has_word_timing})"
        )
    return out_path


def _fmt_srt_time(sec: float) -> str:
    """Format seconds as SRT timestamp HH:MM:SS,mmm."""
    ms_total = max(0, int(round(sec * 1000)))
    hh = ms_total // 3600000
    mm = (ms_total % 3600000) // 60000
    ss = (ms_total % 60000) // 1000
    ms = ms_total % 1000
    return f"{hh:02d}:{mm:02d}:{ss:02d},{ms:03d}"


def export_timeline_srt(
    playlist: PlaylistConfig,
    project_root: Path,
    out_path: Path | None = None,
) -> tuple[Path, int]:
    """Export all enabled songs' bilingual lyrics aligned to the master sequence timeline as SRT."""
    target = out_path or (project_root / "output" / "lyrics_timeline.srt")
    target.parent.mkdir(parents=True, exist_ok=True)

    cur_sec = float(playlist.intro.duration) if (playlist.intro and playlist.intro.enabled) else 0.0
    srt_blocks: list[str] = []
    cue_idx = 1

    for song in playlist.songs:
        in_sec = parse_time_str(song.start)
        out_sec = parse_time_str(song.end)
        dur = out_sec - in_sec
        if dur <= 0.1:
            dur = 20.0

        if song.lyrics_enabled and song.lyrics_path:
            lp = Path(song.lyrics_path)
            if not lp.is_absolute():
                lp = project_root / lp
            if lp.is_file():
                try:
                    data = json.loads(lp.read_text(encoding="utf-8"))
                    lines = data.get("lines") or []
                except Exception:
                    lines = []

                offset = float(song.lyrics_offset or 0.0)
                for i, ln in enumerate(lines):
                    mv_start = float(ln.get("time", 0.0)) + offset
                    next_mv_start = (
                        float(lines[i + 1].get("time", 0.0)) + offset
                        if (i + 1 < len(lines))
                        else (mv_start + 5.0)
                    )
                    if next_mv_start <= in_sec + 0.1 or mv_start >= out_sec - 0.15:
                        continue
                    vis_start = max(in_sec, mv_start)
                    vis_end = min(out_sec, next_mv_start)
                    if vis_end - vis_start < 0.2:
                        continue

                    seq_s = cur_sec + (vis_start - in_sec)
                    seq_e = cur_sec + (vis_end - in_sec)
                    orig = str(ln.get("orig") or "").strip()
                    trans = str(ln.get("trans") or "").strip()
                    if not orig and not trans:
                        continue
                    body = f"{orig}\n{trans}" if (orig and trans) else (orig or trans)
                    srt_blocks.append(f"{cue_idx}\n{_fmt_srt_time(seq_s)} --> {_fmt_srt_time(seq_e)}\n{body}\n")
                    cue_idx += 1

        cur_sec += dur

    target.write_text("\n".join(srt_blocks), encoding="utf-8")
    return target, (cue_idx - 1)


def main():
    project_root = Path(__file__).resolve().parent.parent
    playlist_path = project_root / "playlist.json"
    playlist = load_playlist(playlist_path)

    hit = 0
    for idx, song in enumerate(playlist.songs, 1):
        print(f"[{idx}/{len(playlist.songs)}] Fetching lyrics for {song.artist} - {song.title} ...")
        res = fetch_and_save_lyrics(song, project_root, force=False, log=print)
        if res:
            hit += 1

    save_playlist(playlist, playlist_path)
    srt_path, cue_count = export_timeline_srt(playlist, project_root)
    print(f"Done: {hit}/{len(playlist.songs)} songs have timed lyrics; exported {cue_count} cues to {srt_path}.")


if __name__ == "__main__":
    main()
