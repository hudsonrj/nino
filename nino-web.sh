#!/usr/bin/env bash
#
# Abre o Nino em modo web (funciona em qualquer navegador, sem depender
# de janelas nativas — útil no WSLg, em servidores remotos e em containers).
#
#   ./nino-web.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${NINO_PORT:-3081}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js não encontrado."
  exit 1
fi

if [ ! -d vendor/voices ] || [ -z "$(ls -A vendor/voices 2>/dev/null)" ]; then
  echo "Vozes do Piper ausentes. Rode primeiro: ./scripts/setup.sh"
  exit 1
fi

# O Ollama precisa estar no ar.
if ! curl -sf -m 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Ollama não está respondendo — iniciando em segundo plano…"
  nohup ollama serve >/tmp/nino-ollama.log 2>&1 &
  sleep 3
fi

URL="http://127.0.0.1:${PORT}"

echo ""
echo "  Abrindo o Nino em ${URL}"
echo "  (no WSL, use o navegador do Windows: Chrome ou Edge)"
echo ""

# Tenta abrir o navegador do lado do Windows, se existir.
if command -v cmd.exe >/dev/null 2>&1; then
  cmd.exe /c start "" "$URL" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
fi

exec node src/server/web.js --port "$PORT"
