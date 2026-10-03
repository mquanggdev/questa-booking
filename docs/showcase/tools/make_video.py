"""Builds a narrated Vietnamese explainer video from an HTML slide deck.

Each <section class="slide" data-narration="..."> in the deck becomes one
still frame, read aloud by a Vietnamese neural voice. Output: MP4 (H.264/AAC)
plus .vtt and .srt subtitles next to it.

    pnpm showcase:video docs/showcase/phase-01/video/slides.html

Runs through `uv`, so nothing is installed system-wide:
  - edge-tts: Microsoft Edge neural voices (narration text is sent to the
    Edge read-aloud service; it contains only the project explanation)
  - imageio-ffmpeg: a bundled ffmpeg binary
  - playwright: drives the installed Microsoft Edge to screenshot the slides
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import hashlib
import http.server
import re
import subprocess
import tempfile
import threading
from pathlib import Path

import edge_tts
import imageio_ffmpeg
from playwright.async_api import async_playwright

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
WIDTH, HEIGHT = 1280, 720
LEAD_IN = 0.4  # seconds of silence before each slide's narration
TAIL = 0.9  # seconds the slide stays on screen after the narration


def run(args: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {' '.join(args)}\n{result.stderr[-2000:]}")
    return result


def duration_of(media: Path) -> float:
    result = subprocess.run([FFMPEG, "-hide_banner", "-i", str(media)], capture_output=True, text=True, errors="replace")
    match = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", result.stderr)
    if not match:
        raise RuntimeError(f"Cannot read duration of {media}")
    h, m, s = match.groups()
    return int(h) * 3600 + int(m) * 60 + float(s)


def serve(directory: Path) -> tuple[http.server.ThreadingHTTPServer, int]:
    """Browsers refuse ES modules from file://, so the deck is served over HTTP."""
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass


async def capture_slides(deck: Path, out_dir: Path) -> list[tuple[Path, str]]:
    showcase_root = Path(__file__).resolve().parent.parent
    server, port = serve(showcase_root)
    url = f"http://127.0.0.1:{port}/{deck.resolve().relative_to(showcase_root).as_posix()}"
    try:
        return await _capture(url, out_dir)
    finally:
        server.shutdown()


async def _capture(url: str, out_dir: Path) -> list[tuple[Path, str]]:
    async with async_playwright() as p:
        try:
            browser = await p.chromium.launch(channel="msedge")
        except Exception:
            browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=1)
        await page.goto(url)
        await page.wait_for_function("window.slidesReady === true", timeout=60_000)
        narrations: list[str] = await page.evaluate(
            "[...document.querySelectorAll('.slide')].map(s => s.dataset.narration.trim().replace(/\\s+/g, ' '))"
        )
        frames = []
        for i, text in enumerate(narrations):
            await page.evaluate(f"window.showSlide({i})")
            await page.wait_for_timeout(250)
            png = out_dir / f"slide-{i:02d}.png"
            await page.screenshot(path=str(png))
            frames.append((png, text))
        await browser.close()
        return frames


async def synthesize(text: str, voice: str, rate: str, cache: Path) -> Path:
    key = hashlib.sha256(f"{voice}|{rate}|{text}".encode()).hexdigest()[:16]
    mp3 = cache / f"{key}.mp3"
    if not mp3.exists():
        await edge_tts.Communicate(text, voice, rate=rate).save(str(mp3))
    return mp3


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?…])\s+", text)
    return [p for p in parts if p.strip()]


def timestamp(seconds: float, sep: str) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def write_subtitles(cues: list[tuple[float, float, str]], vtt: Path, srt: Path) -> None:
    vtt_lines = ["WEBVTT", ""]
    srt_lines = []
    for n, (start, end, text) in enumerate(cues, 1):
        vtt_lines += [f"{timestamp(start, '.')} --> {timestamp(end, '.')}", text, ""]
        srt_lines += [str(n), f"{timestamp(start, ',')} --> {timestamp(end, ',')}", text, ""]
    vtt.write_text("\n".join(vtt_lines), encoding="utf-8")
    srt.write_text("\n".join(srt_lines), encoding="utf-8")


async def build(deck: Path, output: Path, voice: str, rate: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    cache = Path(tempfile.gettempdir()) / "questa-tts-cache"
    cache.mkdir(exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        frames = await capture_slides(deck, tmp)
        print(f"Captured {len(frames)} slides")

        segments: list[Path] = []
        cues: list[tuple[float, float, str]] = []
        clock = 0.0
        for i, (png, text) in enumerate(frames):
            mp3 = await synthesize(text, voice, rate, cache)
            speech = duration_of(mp3)
            total = LEAD_IN + speech + TAIL
            segment = tmp / f"segment-{i:02d}.mp4"
            run([
                FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                "-loop", "1", "-framerate", "30", "-i", str(png),
                "-i", str(mp3),
                "-filter_complex",
                f"[1:a]adelay={int(LEAD_IN * 1000)}:all=1,apad=whole_dur={total:.3f},aresample=48000[a]",
                "-map", "0:v", "-map", "[a]",
                "-t", f"{total:.3f}",
                "-c:v", "libx264", "-tune", "stillimage", "-preset", "medium", "-crf", "28",
                "-pix_fmt", "yuv420p", "-r", "30",
                "-c:a", "aac", "-b:a", "96k", "-ac", "1",
                str(segment),
            ])
            segments.append(segment)

            # Subtitles: split the slide's speech time across its sentences by length.
            sentences = split_sentences(text)
            chars = sum(len(s) for s in sentences) or 1
            t = clock + LEAD_IN
            for sentence in sentences:
                d = speech * len(sentence) / chars
                cues.append((t, t + d, sentence))
                t += d
            clock += total
            print(f"  slide {i + 1}/{len(frames)}: {speech:.1f}s")

        concat = tmp / "concat.txt"
        concat.write_text("".join(f"file '{s.as_posix()}'\n" for s in segments), encoding="utf-8")
        run([
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(concat),
            "-c", "copy", "-movflags", "+faststart", str(output),
        ])

    write_subtitles(cues, output.with_suffix(".vtt"), output.with_suffix(".srt"))
    size = output.stat().st_size / 1024 / 1024
    print(f"Wrote {output} ({clock / 60:.1f} min, {size:.1f} MB) and subtitles")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("deck", type=Path, help="slides.html")
    parser.add_argument("--out", type=Path, help="output .mp4 (default: <phase>.mp4 next to the deck)")
    parser.add_argument("--voice", default="vi-VN-HoaiMyNeural")
    parser.add_argument("--rate", default="+0%")
    args = parser.parse_args()
    phase = args.deck.resolve().parent.parent.name
    output = args.out or args.deck.resolve().parent / f"{phase}.mp4"
    asyncio.run(build(args.deck, output, args.voice, args.rate))


if __name__ == "__main__":
    main()
