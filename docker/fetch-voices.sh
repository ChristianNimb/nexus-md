#!/bin/sh

BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en"
DEST="/opt/piper-voices"
mkdir -p "$DEST"

VOICES="
en_GB-alan-medium|en_GB/alan/medium
en_GB-jenny_dioco-medium|en_GB/jenny_dioco/medium
en_GB-northern_english_male-medium|en_GB/northern_english_male/medium
en_US-amy-medium|en_US/amy/medium
en_US-ryan-high|en_US/ryan/high
"

echo "$VOICES" | while IFS='|' read -r name path; do
  [ -z "$name" ] && continue
  echo "Fetching voice: $name"
  curl -fsSL --retry 4 --retry-delay 2 --retry-connrefused --retry-all-errors -o "$DEST/$name.onnx"      "$BASE/$path/$name.onnx"      || echo "  (skipped $name.onnx)"
  curl -fsSL --retry 4 --retry-delay 2 --retry-connrefused --retry-all-errors -o "$DEST/$name.onnx.json" "$BASE/$path/$name.onnx.json" || echo "  (skipped $name.onnx.json)"
done

echo "Installed voices:"
ls -1 "$DEST"/*.onnx 2>/dev/null || echo "  (none — voice will use web fallback)"
