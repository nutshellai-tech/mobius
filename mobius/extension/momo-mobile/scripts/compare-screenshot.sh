#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <current.png> <baseline.png> <candidate-dir>" >&2
  exit 2
fi

current="$1"
baseline="$2"
candidate_dir="$3"
threshold="${SCREENSHOT_DIFF_THRESHOLD:-0.05}"

if [[ ! -f "$current" ]]; then
  echo "current screenshot is missing: $current" >&2
  exit 2
fi

if [[ ! -f "$baseline" ]]; then
  mkdir -p "$candidate_dir"
  cp "$current" "$candidate_dir/$(basename "$baseline")"
  echo "baseline missing; created candidate $candidate_dir/$(basename "$baseline")"
  exit 0
fi

current_size="$(identify -format '%wx%h' "$current")"
baseline_size="$(identify -format '%wx%h' "$baseline")"
if [[ "$current_size" != "$baseline_size" ]]; then
  echo "screenshot dimensions differ: current=$current_size baseline=$baseline_size" >&2
  exit 1
fi

set +e
different_pixels="$(compare -metric AE "$baseline" "$current" null: 2>&1)"
compare_status=$?
set -e

if [[ $compare_status -gt 1 ]]; then
  echo "ImageMagick compare failed: $different_pixels" >&2
  exit "$compare_status"
fi

total_pixels="$(identify -format '%[fx:w*h]' "$current")"
ratio="$(awk -v diff="$different_pixels" -v total="$total_pixels" 'BEGIN { printf "%.8f", diff / total }')"
percent="$(awk -v ratio="$ratio" 'BEGIN { printf "%.4f", ratio * 100 }')"

echo "different_pixels=$different_pixels total_pixels=$total_pixels ratio=$ratio percent=$percent%"
if awk -v ratio="$ratio" -v threshold="$threshold" 'BEGIN { exit !(ratio > threshold) }'; then
  echo "visual difference $percent% exceeds threshold $(awk -v t="$threshold" 'BEGIN { printf "%.2f", t * 100 }')%" >&2
  exit 1
fi

exit 0
