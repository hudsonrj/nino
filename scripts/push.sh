#!/usr/bin/env bash
#
# Envia o código para o GitHub.
#
#   ./scripts/push.sh
#
# O token é digitado na hora e NÃO fica salvo em lugar nenhum (nem no
# .git/config, nem no histórico do shell). Para gerar um:
#   GitHub → Settings → Developer settings → Personal access tokens
#   → Tokens (classic) → Generate new token → marque o escopo "repo"
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REPO="${NINO_REPO:-github.com/hudsonrj/nino.git}"
BRANCH="${NINO_BRANCH:-main}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Esta pasta não é um repositório git."
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Existem mudanças não commitadas:"
  git status --short
  echo
  read -rp "Commitar tudo antes de enviar? [s/N] " resp
  if [[ "$resp" =~ ^[sS]$ ]]; then
    git add -A
    read -rp "Mensagem do commit: " msg
    git commit -q -m "${msg:-ajustes}"
  fi
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
  read -rsp "Cole o token do GitHub (não aparece na tela): " GITHUB_TOKEN
  echo
fi

if [ -z "$GITHUB_TOKEN" ]; then
  echo "Nenhum token informado."
  exit 1
fi

echo "Enviando para ${REPO} (${BRANCH})…"
git push "https://${GITHUB_TOKEN}@${REPO}" "$BRANCH"
STATUS=$?

unset GITHUB_TOKEN
exit $STATUS
