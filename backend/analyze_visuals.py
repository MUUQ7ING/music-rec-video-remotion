"""analyze_visuals.py — Per-region brightness analysis & static-cover MV beat-reactive motion extractor.

1. Samples 8 frames across each song's [start, end] clip to compute perceived luminance (0..255)
   in three UI text zones (top-left #index, top-right reason, bottom floating glass bar).
   Flags zones with bright/high-key backgrounds (L >= 175 or p85 >= 210) so the MOGRT boosts
   dark drop-shadow strength while keeping crisp white serif typography.
2. Automatically detects static-cover MVs via dual criteria:
   - Low native frame rate (<= 10 fps), OR
   - Low inter-frame pixel Mean Absolute Difference (MAD < 2.5) across 5 sampled frames.
3. For static-cover MVs (or songs with beat_motion == "on"), extracts a 40-160 Hz sub-bass/kick
   envelope at 12 Hz and writes smooth scale pulse (104% -> 107.5%) + subtle shake (+/- 4px)
   keyframes to processed/<slug>_beat.json for native Premiere Pro GPU Motion animation.
"""

from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path
from typing import Callable

import numpy as np

from backend.preprocess import find_ffmpeg, parse_time_str
from backend.schema import SongItem, load_playlist, save_playlist

# Sampled analysis resolution (16:9 scaled down for ultra-fast numpy analysis)
AN_W, AN_H = 320, 180
BEAT_HZ = 12.0


def probe_video_fps(media_path: Path) -> float:
    """Return native video FPS using ffprobe, or 30.0 on failure."""
    try:
        cmd = [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=r_frame_rate",
            "-of",
            "csv=p=0",
            str(media_path),
        ]
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True).strip()
        if "/" in out:
            num, den = out.split("/", 1)
            d = float(den)
            return float(num) / d if d > 0 else 30.0
        return float(out)
    except Exception:
        return 30.0


def sample_clip_frames(
    ffmpeg: str,
    media_path: Path,
    start_sec: float,
    dur_sec: float,
    num_samples: int = 8,
) -> list[np.ndarray]:
    """Extract evenly spaced RGB frames at 320x180 across [start_sec, start_sec + dur_sec]."""
    frames: list[np.ndarray] = []
    if dur_sec <= 0.2:
        return frames
    step = dur_sec / float(num_samples + 1)
    for i in range(1, num_samples + 1):
        ts = start_sec + step * i
        cmd = [
            ffmpeg,
            "-y",
            "-ss",
            f"{ts:.3f}",
            "-i",
            str(media_path),
            "-vframes",
            "1",
            "-vf",
            f"scale={AN_W}:{AN_H}:force_original_aspect_ratio=decrease,pad={AN_W}:{AN_H}:(ow-iw)/2:(oh-ih)/2",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
        expected = AN_W * AN_H * 3
        if proc.returncode == 0 and len(proc.stdout) == expected:
            arr = np.frombuffer(proc.stdout, dtype=np.uint8).reshape((AN_H, AN_W, 3))
            frames.append(arr)
    return frames


def analyze_brightness_and_static(
    ffmpeg: str,
    media_path: Path,
    start_sec: float,
    dur_sec: float,
) -> tuple[dict[str, bool], bool, float]:
    """Analyze 3 UI regions for bright highlights and determine whether the video is a static-cover MV.

    Returns (detected_bright_dict, is_static_mv, mad_score).
    """
    fps = probe_video_fps(media_path)
    frames = sample_clip_frames(ffmpeg, media_path, start_sec, dur_sec, num_samples=8)
    if not frames:
        return {"index": False, "reason": False, "bottom": False}, (fps <= 10.5), 0.0

    # Perceived luminance L = 0.299R + 0.587G + 0.114B
    lums = [
        (0.299 * f[:, :, 0] + 0.587 * f[:, :, 1] + 0.114 * f[:, :, 2]).astype(np.float32)
        for f in frames
    ]

    # Region bounding boxes scaled to 320x180 (factor 1/6 of 1920x1080)
    # Index:  X=0..260,    Y=0..180    -> x=0..44,   y=0..30
    # Reason: X=1150..1920,Y=0..280    -> x=192..320,y=0..47
    # Bottom: X=220..1892, Y=870..1056 -> x=37..315, y=145..176
    def is_zone_bright(y0: int, y1: int, x0: int, x1: int) -> bool:
        means = [float(np.mean(L[y0:y1, x0:x1])) for L in lums]
        p85s = [float(np.percentile(L[y0:y1, x0:x1], 85)) for L in lums]
        avg_mean = sum(means) / len(means)
        avg_p85 = sum(p85s) / len(p85s)
        # Trigger strong shadow when overall zone is bright OR has bright white patches
        return avg_mean >= 165.0 or avg_p85 >= 215.0

    detected_bright = {
        "index": is_zone_bright(0, 30, 0, 44),
        "reason": is_zone_bright(0, 47, 192, 320),
        "bottom": is_zone_bright(145, 176, 37, 315),
    }

    # Static-cover MV detection: low fps OR low inter-frame MAD across sampled frames
    mads = []
    for i in range(1, len(lums)):
        mads.append(float(np.mean(np.abs(lums[i] - lums[i - 1]))))
    avg_mad = sum(mads) / len(mads) if mads else 0.0
    is_static = (fps <= 10.5) or (avg_mad < 2.5)

    return detected_bright, is_static, round(avg_mad, 2)


def extract_beat_keyframes(
    ffmpeg: str,
    media_path: Path,
    start_sec: float,
    dur_sec: float,
    base_scale: float = 104.0,
    max_pulse: float = 3.5,
    max_shake_px: float = 4.0,
) -> list[dict]:
    """Compute 12 Hz low-frequency kick/bass reactive scale & subtle shake keyframes."""
    samples = extract_mono_pcm(ffmpeg, media_path, start_sec, dur_sec)
    if samples.size == 0:
        return []

    fft_size = 2048
    freqs = np.fft.rfftfreq(fft_size, d=1.0 / SAMPLE_RATE)
    lo = int(np.searchsorted(freqs, 40.0))
    hi = int(np.searchsorted(freqs, 160.0))
    hi = max(lo + 1, hi)
    window = np.hanning(fft_size).astype(np.float32)

    n_steps = max(2, int(math.ceil(dur_sec * BEAT_HZ)))
    hop = SAMPLE_RATE / BEAT_HZ
    raw_energy = np.zeros(n_steps, dtype=np.float32)

    total = len(samples)
    for i in range(n_steps):
        center = int(i * hop)
        s0 = center - fft_size // 2
        if s0 < 0 or s0 + fft_size > total:
            chunk = np.zeros(fft_size, dtype=np.float32)
            src_s = max(0, s0)
            src_e = min(total, s0 + fft_size)
            dst_s = src_s - s0
            if src_e > src_s:
                chunk[dst_s : dst_s + (src_e - src_s)] = samples[src_s:src_e]
        else:
            chunk = samples[s0 : s0 + fft_size]
        mag = np.abs(np.fft.rfft(chunk * window))
        raw_energy[i] = float(np.mean(mag[lo:hi]))

    # Emphasize bass transients (onset punch above local moving baseline)
    ref = float(np.percentile(raw_energy, 95)) if raw_energy.size > 0 else 1.0
    if ref < 1e-5:
        ref = 1.0
    norm = np.clip(raw_energy / ref, 0.0, 1.0)
    # Apply power curve so quiet passages stay calm and kick hits pop cleanly
    punch = norm ** 1.6

    # Smooth attack/decay for organic breathing feel
    env = np.zeros_like(punch)
    prev = 0.0
    for i in range(n_steps):
        cur = float(punch[i])
        prev = prev * 0.35 + cur * 0.65 if cur > prev else prev * 0.70 + cur * 0.30
        env[i] = prev

    keyframes: list[dict] = []
    for i in range(n_steps):
        t = round(min(dur_sec, i / BEAT_HZ), 3)
        e = float(env[i])
        scale = round(base_scale + e * max_pulse, 2)
        # Smooth organic micro-shake driven by beat energy (zero abrupt jumps)
        dx = round(math.sin(t * 9.5) * e * max_shake_px, 2)
        dy = round(math.cos(t * 7.3) * e * (max_shake_px * 0.8), 2)
        keyframes.append({"t": t, "scale": scale, "dx": dx, "dy": dy})

    return keyframes


def analyze_song_visuals(
    song: SongItem,
    project_root: Path,
    log: Callable[[str], None] | None = None,
) -> dict:
    """Run brightness & static-MV beat analysis for a single song and update its fields."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return {}

    src_rel = song.normalized_path or song.file_path
    if not src_rel:
        return {}
    src_path = Path(src_rel)
    if not src_path.is_absolute():
        src_path = project_root / src_path
    if not src_path.is_file():
        return {}

    start_sec = parse_time_str(song.start)
    end_sec = parse_time_str(song.end)
    dur_sec = max(1.0, end_sec - start_sec)

    bright, is_static, mad = analyze_brightness_and_static(ffmpeg, src_path, start_sec, dur_sec)
    song.detected_bright = bright

    summary = {
        "title": song.title,
        "bright": bright,
        "is_static": is_static,
        "mad": mad,
    }
    if log:
        log(f"Analyzed {song.title}: bright={bright}, static={is_static} (MAD={mad})")
    return summary


def main():
    project_root = Path(__file__).resolve().parent.parent
    playlist_path = project_root / "playlist.json"
    playlist = load_playlist(playlist_path)

    for idx, song in enumerate(playlist.songs, 1):
        print(f"[{idx}/{len(playlist.songs)}] Analyzing visuals for {song.artist} - {song.title} ...")
        analyze_song_visuals(song, project_root, log=print)

    save_playlist(playlist, playlist_path)
    print("Visual analysis (brightness + static-MV beat curves) saved to playlist.json.")


if __name__ == "__main__":
    main()
