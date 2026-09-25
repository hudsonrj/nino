# 🪟 Shell nativo para Windows

Esta é a **casca**: uma janela Electron transparente, sem borda e sempre no topo
que roda **no Windows**, mostrando a interface servida pelo WSL.

## Por que existe

O WSLg desta máquina não consegue desenhar janelas:

```
/dev/dri            → não existe (nenhum dispositivo de GPU exposto)
glamor: 'wl_drm' not supported
Failed to initialize glamor, falling back to sw
```

Resultado: a janela do mascote até era criada, aparecia na barra de tarefas,
mas o conteúdo nunca chegava à tela. Rodando a janela no lado do Windows, o
problema desaparece — e o trabalho pesado continua no WSL.

## Como funciona

```
Windows                              WSL (kali-linux)
┌──────────────────────┐   HTTP     ┌───────────────────┐
│ main.js (Electron)   │ ─────────► │ src/server/web.js │
│ preload.js           │   :3081    │  ├ kb (RAG)       │
│ janela + bandeja     │            │  ├ ollama         │
└──────────────────────┘            │  ├ tts (Piper)    │
                                    │  └ stt (Whisper)  │
                                    └───────────────────┘
```

Se o servidor não estiver no ar, o shell **sobe ele sozinho** pelo `wsl.exe` e
espera até 45 s pela resposta.

## Instalação (uma vez)

No Windows, dentro desta pasta:

```bat
npm install
node node_modules\electron\install.js
```

O segundo comando baixa o binário do Electron (~250 MB); o `npm install` às
vezes pula esse passo.

Depois copie `Nino.bat` para a Área de Trabalho. Duplo clique e pronto.

## Configuração por variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `NINO_URL` | `http://127.0.0.1:3081` | Endereço do servidor |
| `NINO_WSL_DISTRO` | `kali-linux` | Distribuição a iniciar |
| `NINO_WSL_USER` | `hudson` | Usuário dentro do WSL |
| `NINO_WSL_DIR` | `/home/hudson/clone/mascote` | Pasta do projeto |
| `NINO_PORT` | `3081` | Porta do servidor |
| `NINO_NO_AUTOSTART` | — | `1` impede subir o servidor sozinho |

## Detalhes que já mordemos

- **`ready-to-show` não é confiável com `transparent: true`** — a janela ficava
  invisível (só na barra de tarefas). O shell exibe por três caminhos:
  `ready-to-show`, `did-finish-load` e um tempo limite de 7 s.
- **`alwaysOnTop` pode ser rebaixado** quando outro programa pede foco. Um
  vigia reafirma o topo a cada 8 s. Há também "Trazer para a frente" na bandeja.
- **`resizable: false` pode fazer o `setBounds` ser ignorado** — a janela é sem
  borda, então fica `resizable: true`.

## Ferramentas de diagnóstico

Rodam no **Node do Windows** (o WSL não alcança o `127.0.0.1` de lá):

```bat
:: com o shell iniciado com --remote-debugging-port=9333
node cdp-check.js 9333
node cdp-eval.js 9333 "setOpen(false)"
```
