import subprocess
from array import array
from functools import lru_cache
from pathlib import Path
from sys import byteorder

from backend.preprocess import find_ffmpeg


SAMPLE_RATE = 4000
MAX_SECONDS = 1800
PEAK_BINS = 240


@lru_cache(maxsize=48)
def _decode_waveform(path: str, modified_ns: int, size: int) -> tuple[float, tuple[float, ...]]:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return 0, ()
    result = subprocess.run(
        [
            ffmpeg, "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0",
            "-af", f"aresample={SAMPLE_RATE}:first_pts=0",
            "-ac", "2", "-ar", str(SAMPLE_RATE), "-t", str(MAX_SECONDS),
            "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )
    if result.returncode or not result.stdout:
        return 0, ()
    pcm = array("h", result.stdout)
    if byteorder != "little":
        pcm.byteswap()
    frames = len(pcm) // 2
    if frames >= SAMPLE_RATE * MAX_SECONDS:
        return 0, ()

    bin_count = min(PEAK_BINS, frames)
    peaks = []
    for index in range(bin_count):
        start = index * frames // bin_count * 2
        stop = (index + 1) * frames // bin_count * 2
        block = pcm[start:stop]
        peak = max(max(block), -min(block))
        peaks.append(round(peak / 32768, 4))
    return frames / SAMPLE_RATE, tuple(peaks)


def get_waveform(path: str) -> tuple[float, tuple[float, ...]]:
    try:
        metadata = Path(path).stat()
        return _decode_waveform(path, metadata.st_mtime_ns, metadata.st_size)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return 0, ()
