@echo off
chcp 65001 >nul
title Nino - mascote assistente

REM Janela nativa do mascote, rodando no Windows.
REM O cerebro (Ollama, base de conhecimento, voz e transcricao) roda no WSL,
REM e o shell sobe o servidor sozinho se ele nao estiver no ar.

cd /d "%USERPROFILE%\nino-shell"

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   O shell ainda nao foi instalado.
  echo   Rode uma vez:  npm install
  echo.
  pause
  exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
