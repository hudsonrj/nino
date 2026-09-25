#!/usr/bin/env bash
#
# Abre o mascote Nino.
#
#   ./mascote.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [ ! -d node_modules/electron ]; then
  echo "Dependências ausentes. Rode primeiro: ./scripts/setup.sh"
  exit 1
fi

# O Ollama precisa estar no ar.
if ! curl -sf -m 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Ollama não está respondendo — iniciando em segundo plano…"
  nohup ollama serve >/tmp/nino-ollama.log 2>&1 &
  sleep 3
fi

exec ./node_modules/.bin/electron . --no-sandbox "$@"
