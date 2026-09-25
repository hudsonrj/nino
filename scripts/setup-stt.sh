#!/usr/bin/env bash
#
# Cria o ambiente Python isolado com faster-whisper (transcrição local).
# O Kali/Debian bloqueiam "pip install" global (PEP 668), por isso o venv.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VENV="vendor/sttenv"
WHISPER_MODEL="${WHISPER_MODEL:-small}"

if [ ! -x "$VENV/bin/python" ]; then
  echo "criando ambiente virtual em ${VENV}…"
  python3 -m venv "$VENV"
fi

echo "instalando faster-whisper…"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet faster-whisper

echo "pré-baixando o modelo '${WHISPER_MODEL}'…"
WHISPER_CACHE="$ROOT/data/models/whisper" \
WHISPER_MODEL="$WHISPER_MODEL" \
"$VENV/bin/python" - <<'PY'
import os
from faster_whisper import WhisperModel
cache = os.environ["WHISPER_CACHE"]
os.makedirs(cache, exist_ok=True)
WhisperModel(os.environ["WHISPER_MODEL"], device="cpu", compute_type="int8", download_root=cache)
print("modelo pronto")
PY

echo "transcrição local pronta."
