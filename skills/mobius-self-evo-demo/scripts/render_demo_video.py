#!/usr/bin/env python3
"""Render a Mobius self-evolution demo with animated transition title cards."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


WIDTH = 1440
HEIGHT = 900
FPS = 25
XF_DURATION = 0.45
TRANSITION_1_SECONDS = 3.0
TRANSITION_2_SECONDS = 3.8
DEFAULT_TRANSITION_1 = "接下来，我们给小莫提出需求，提出需求"
DEFAULT_TRANSITION_2 = "小莫会处理您的指令……|等待享用一杯咖啡的时间后……"


def run(cmd: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if result.returncode != 0:
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        raise SystemExit(
            "Command failed:\n"
            + " ".join(cmd)
            + ("\n\nstdout:\n" + stdout if stdout else "")
            + ("\n\nstderr:\n" + stderr if stderr else "")
        )
    return result


def video_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path)],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    text = (result.stdout or "") + (result.stderr or "")
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if not match:
        raise SystemExit(f"Could not read duration from {path}")
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def ass_time(seconds: float) -> str:
    total_centis = int(round(seconds * 100))
    hours, rem = divmod(total_centis, 3600 * 100)
    minutes, rem = divmod(rem, 60 * 100)
    secs, centis = divmod(rem, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{centis:02d}"


def ass_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def write_ass(path: Path, lines: list[str], duration: float, *, variant: int) -> None:
    if len(lines) == 1:
        events = [
            (
                "0:00:00.00",
                ass_time(duration),
                "Title",
                r"{\fad(280,340)\move(720,462,720,430,0,720)"
                r"\t(0,720,\fscx106\fscy106)\t(2300,3000,\fscx98\fscy98)}"
                + ass_escape(lines[0]),
            )
        ]
    else:
        events = [
            (
                "0:00:00.00",
                ass_time(duration),
                "Title",
                r"{\fad(280,360)\move(720,420,720,384,0,780)"
                r"\t(0,780,\fscx105\fscy105)\t(3000,3800,\fscx98\fscy98)}"
                + ass_escape(lines[0]),
            ),
            (
                "0:00:00.25",
                ass_time(duration),
                "Subtitle",
                r"{\fad(320,360)\move(720,514,720,478,250,980)"
                r"\t(250,980,\fscx104\fscy104)\t(3000,3800,\fscx98\fscy98)}"
                + ass_escape(lines[1]),
            ),
        ]

    accent = "&H0000E8FF" if variant == 1 else "&H004FD6FF"
    body = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {WIDTH}
PlayResY: {HEIGHT}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Noto Sans CJK SC,58,&H00FFFFFF,&H00FFFFFF,&H8010182C,&H90000000,1,0,0,0,100,100,0,0,1,1.8,3.5,5,80,80,80,1
Style: Subtitle,Noto Sans CJK SC,50,{accent},&H00FFFFFF,&H8010182C,&H90000000,1,0,0,0,100,100,0,0,1,1.6,3,5,80,80,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    for layer, (start, end, style, text) in enumerate(events):
        body += f"Dialogue: {layer},{start},{end},{style},,0,0,0,,{text}\n"
    path.write_text(body, encoding="utf-8")


def render_transition(ass_path: Path, output: Path, duration: float, *, variant: int) -> None:
    if variant == 1:
        gradient = (
            f"gradients=s={WIDTH}x{HEIGHT}:r={FPS}:d={duration}:"
            "c0=0x08111F:c1=0x1D4ED8:c2=0x0F766E:n=3:type=radial:speed=0.08"
        )
    else:
        gradient = (
            f"gradients=s={WIDTH}x{HEIGHT}:r={FPS}:d={duration}:"
            "c0=0x0A1020:c1=0x5B21B6:c2=0x92400E:n=3:type=spiral:speed=0.06"
        )
    video_filter = (
        f"format=yuv420p,ass=filename={ass_path},"
        "fade=t=in:st=0:d=0.28,"
        f"fade=t=out:st={max(duration - 0.36, 0):.2f}:d=0.36"
    )
    run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            gradient,
            "-vf",
            video_filter,
            "-t",
            f"{duration:.2f}",
            "-an",
            "-r",
            str(FPS),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )


def render_final(inputs: list[Path], output: Path) -> None:
    norm = (
        f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,"
        f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2,"
        f"fps={FPS},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS"
    )
    filters: list[str] = []
    for index in range(len(inputs)):
        filters.append(f"[{index}:v]{norm}[v{index}]")

    filters.append(
        "".join(f"[v{index}]" for index in range(len(inputs)))
        + f"concat=n={len(inputs)}:v=1:a=0,format=yuv420p[vout]"
    )
    cmd = ["ffmpeg", "-y"]
    for input_path in inputs:
        cmd.extend(["-i", str(input_path)])
    cmd.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[vout]",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    run(cmd)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", default="/tmp/imac-demo-video")
    parser.add_argument("--part1", default="/tmp/imac-demo-video/part1-before.webm")
    parser.add_argument("--part2", default="/tmp/imac-demo-video/part2-request.webm")
    parser.add_argument("--part3", default="/tmp/imac-demo-video/part3-after.webm")
    parser.add_argument("--output", required=True)
    parser.add_argument("--transition1", default=DEFAULT_TRANSITION_1)
    parser.add_argument("--transition2", default=DEFAULT_TRANSITION_2)
    args = parser.parse_args()

    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    part1 = Path(args.part1)
    part2 = Path(args.part2)
    part3 = Path(args.part3)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    for path in (part1, part2, part3):
        if not path.exists():
            raise SystemExit(f"Missing input clip: {path}")

    transition1_ass = work_dir / "transition1.ass"
    transition2_ass = work_dir / "transition2.ass"
    transition1_video = work_dir / "transition1-animated.mp4"
    transition2_video = work_dir / "transition2-animated.mp4"

    write_ass(transition1_ass, [args.transition1], TRANSITION_1_SECONDS, variant=1)
    write_ass(
        transition2_ass,
        [line for line in args.transition2.split("|") if line],
        TRANSITION_2_SECONDS,
        variant=2,
    )
    render_transition(transition1_ass, transition1_video, TRANSITION_1_SECONDS, variant=1)
    render_transition(transition2_ass, transition2_video, TRANSITION_2_SECONDS, variant=2)

    inputs = [part1, transition1_video, part2, transition2_video, part3]
    render_final(inputs, output)
    print(output)


if __name__ == "__main__":
    main()
