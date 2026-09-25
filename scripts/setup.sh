#!/usr/bin/env bash
#
# Instalação completa do Nino — mascote-assistente flutuante.
#
#   ./scripts/setup.sh
#
# Faz, de forma idempotente:
#   1. dependências Node + Electron
#   2. binário do Piper e as vozes PT-BR
#   3. ambiente Python com faster-whisper (Whisper local)
#   4. download dos modelos do Ollama (conversa + embeddings)
#   5. ícones do app
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHAT_MODEL="${CHAT_MODEL:-qwen3.5:2b}"
EMBED_MODEL="${EMBED_MODEL:-bge-m3}"
WHISPER_MODEL="${WHISPER_MODEL:-small}"
VOICES=("pt_BR-faber-medium" "pt_BR-edresson-low")

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m aviso: %s\033[0m\n' "$1"; }

# ------------------------------------------------------------------ #
step "1/5  Dependências Node"
# ------------------------------------------------------------------ #
if [ ! -d node_modules ] || [ ! -d node_modules/electron ]; then
  npm install --no-audit --no-fund
else
  echo "já instaladas"
fi

# ------------------------------------------------------------------ #
step "2/5  Piper (voz neural PT-BR)"
# ------------------------------------------------------------------ #
mkdir -p vendor/voices
if [ ! -x vendor/piper/piper ]; then
  echo "baixando binário do Piper…"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/piper.tar.gz" \
    https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
  tar xzf "$tmp/piper.tar.gz" -C vendor
  rm -rf "$tmp"
else
  echo "binário já presente: $(vendor/piper/piper --version 2>/dev/null || echo '?')"
fi

for voice in "${VOICES[@]}"; do
  if [ -f "vendor/voices/${voice}.onnx" ]; then
    echo "voz já presente: ${voice}"
    continue
  fi
  case "$voice" in
    pt_BR-faber-medium) rel="faber/medium" ;;
    pt_BR-edresson-low) rel="edresson/low" ;;
    *) warn "sem URL conhecida para ${voice}"; continue ;;
  esac
  base="https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/${rel}/${voice}"
  echo "baixando voz ${voice}…"
  curl -fsSL -o "vendor/voices/${voice}.onnx" "${base}.onnx"
  curl -fsSL -o "vendor/voices/${voice}.onnx.json" "${base}.onnx.json"
done

# ------------------------------------------------------------------ #
step "3/5  Whisper local (transcrição)"
# ------------------------------------------------------------------ #
bash "$ROOT/scripts/setup-stt.sh"

# ------------------------------------------------------------------ #
step "4/5  Modelos do Ollama"
# ------------------------------------------------------------------ #
if command -v ollama >/dev/null 2>&1; then
  if curl -sf -m 4 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    for model in "$CHAT_MODEL" "$EMBED_MODEL"; do
      echo "baixando modelo ${model}…"
      ollama pull "$model"
    done
  else
    warn "Ollama não está respondendo em 127.0.0.1:11434."
    warn "Rode 'ollama serve' e depois: ollama pull ${CHAT_MODEL} && ollama pull ${EMBED_MODEL}"
  fi
else
  warn "Ollama não encontrado. Instale em https://ollama.com e rode:"
  warn "  ollama pull ${CHAT_MODEL} && ollama pull ${EMBED_MODEL}"
fi

# ------------------------------------------------------------------ #
step "5/5  Ícones"
# ------------------------------------------------------------------ #
node scripts/make-icons.js

step "Pronto!"
cat <<EOF
Inicie o mascote com:

    npm start

Atalhos globais:
    Ctrl+Alt+N   mostrar / esconder o mascote
    Ctrl+Alt+T   modo clique-através (o mascote deixa passar os cliques)
    Ctrl+Alt+S   parar de falar
EOF
