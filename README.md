# 🐣 Nino — mascote-assistente flutuante

Um mascote que fica **flutuando sobre as janelas**, conversa por **texto e voz**,
**ouve pelo microfone** e aprende com os **seus documentos e livros**.

Tudo roda **localmente**: a conversa, a voz, a transcrição e a base de
conhecimento ficam na sua máquina. Nada é enviado para a nuvem.

---

## O que ele faz

| Recurso | Como funciona |
|---|---|
| 🪟 Mascote flutuante | Janela transparente, sem borda, sempre no topo, arrastável |
| 💬 Conversa | Ollama local (`qwen3.5:2b` por padrão) com streaming de tokens |
| 🔊 Fala | Piper neural em português do Brasil, com streaming direto para o áudio |
| 🎤 Escuta | Gravação pelo PulseAudio + transcrição com Whisper local |
| 📚 Base de conhecimento | PDF, EPUB, DOCX, ODT, TXT, MD, HTML, RTF, CSV… com busca semântica (RAG) |
| 📎 Arrastar e soltar | Jogue arquivos em cima do mascote para indexá-los |

---

## Três modos de uso

O mesmo assistente roda de três formas, com o **mesmo cérebro** (base de
conhecimento, RAG, vozes e transcrição):

### 🪟 Modo Windows nativo — recomendado no WSL

A janela roda **no Windows** (onde janelas funcionam de verdade) e o cérebro
fica **no WSL**:

```
Windows                              WSL
┌──────────────────────┐   HTTP     ┌───────────────────┐
│ janela do mascote    │ ─────────► │ Ollama, base de   │
│ transparente, no topo│   :3081    │ conhecimento,     │
│ áudio e microfone    │            │ Piper e Whisper   │
└──────────────────────┘            └───────────────────┘
```

```bat
:: duplo clique em Nino.bat (na Área de Trabalho)
```

O shell sobe o servidor no WSL sozinho se ele não estiver no ar. Instalação
(uma vez): veja [`windows-shell/`](windows-shell/).

**Por que assim:** o WSLg desta máquina não desenha janelas (não há `/dev/dri`
e o Weston cai para software), então o mascote nunca aparecia — só sobrava uma
casca vazia na barra de tarefas. Rodando a janela no Windows, tudo funciona.

### 🌐 Modo web — funciona em qualquer lugar

```bash
./nino-web.sh          # sobe em http://127.0.0.1:3081
```

Abra no **Chrome ou Edge** e clique em **🪟** para o mascote ir para uma janela
**flutuante, sempre no topo** (via *Document Picture-in-Picture*).

> O microfone só funciona em `http://127.0.0.1` ou `https://`. Acessando por IP
> de rede em HTTP, o navegador bloqueia a gravação — a conversa por texto continua.

### 🐧 Modo desktop Linux — janela nativa no Linux

```bash
./mascote.sh           # ou: npm start
```

Precisa que o ambiente **exiba janelas gráficas**. Inclui um resgate automático
de janela para o WSL, mas se o WSLg estiver quebrado, use o modo Windows.

---

## Instalação

```bash
./scripts/setup.sh     # dependências, Piper, Whisper e modelos do Ollama
npm start              # abre o mascote
```

Se preferir por partes:

```bash
npm install                    # Node + Electron
./scripts/setup-stt.sh         # ambiente Python com faster-whisper
node scripts/make-icons.js     # ícones do app
```

Requisitos: Node 20+, `python3-venv`, `pulseaudio-utils` (`paplay`, `parec`,
`pactl`) e o [Ollama](https://ollama.com) rodando (`ollama serve`).

---

## Como usar

- **Clique no mascote** para abrir o painel de conversa.
- **Arraste o mascote** para movê-lo pela tela (ele lembra a posição enquanto está aberto).
- **Arraste arquivos** sobre ele para adicionar à base de conhecimento.
- **🎤** grava sua voz; ele para sozinho quando você fica em silêncio e já responde.
- **📚** abre a base: lista os documentos, mostra o progresso da indexação e permite remover.
- **⚙️** ajusta modelo, voz, velocidade da fala e a personalidade do mascote.

### Atalhos globais

| Atalho | Ação |
|---|---|
| `Ctrl+Alt+N` | Mostrar / esconder o mascote |
| `Ctrl+Alt+T` | Modo clique-através (o mascote deixa os cliques passarem) |
| `Ctrl+Alt+S` | Parar de falar |

A bandeja do sistema tem as mesmas opções, mais "abrir pasta de dados" e "sair".

---

## Como funciona por dentro

```
src/
  main/                     processo principal (Node)
    main.js                 janela overlay, bandeja, IPC, orquestração do chat
    ollama.js               cliente da API do Ollama (chat em streaming + embeddings)
    kb.js                   base de conhecimento: chunking, índice vetorial, busca
    tts.js                  fala: Piper em streaming -> PulseAudio (fallback spd-say)
    stt.js                  escuta: gravação com VAD + worker do Whisper
    ingest/extract.js       extração de texto de cada formato
    python/transcribe.py    worker persistente do faster-whisper
    preload.js              ponte segura (contextBridge) para a interface
  renderer/                 interface (HTML/CSS/JS puro)
```

O fluxo de uma pergunta com a base ligada:

1. A pergunta vira um vetor pelo `bge-m3`.
2. Os trechos mais parecidos são recuperados do índice local (`data/kb/index.json`).
3. Os trechos entram no prompt como contexto.
4. A resposta chega em streaming; **cada frase completa já é enviada para a voz**,
   então o mascote começa a falar antes de terminar de escrever.

### Onde ficam os dados

```
data/
  kb/index.json           índice da base (vetores em base64)
  settings.json           seus ajustes
  audio/                  gravações temporárias do microfone
  models/whisper/         modelo de transcrição
vendor/
  piper/                  binário do Piper + bibliotecas
  voices/                 vozes neurais PT-BR (.onnx)
  sttenv/                 ambiente Python do Whisper
```

---

## Desempenho medido

Números reais desta máquina (WSL2, 14 núcleos virtuais, **sem GPU**):

| Etapa | Medida |
|---|---|
| Primeira palavra de uma resposta com RAG | ~28 s |
| Resposta completa (47 tokens, com RAG) | ~41 s |
| Geração de texto `qwen3.5:2b`, 7 threads | ~8–10 tokens/s |
| Geração de texto `qwen3.5:0.8b`, 4 threads | ~17 tokens/s |
| Prompt eval (o gargalo real) | ~25 tokens/s |
| Embedding `bge-m3` | ~0,4 trechos/s |
| Embedding `nomic-embed-text` | ~0,96 trechos/s (2,4× mais rápido, focado em inglês) |
| Fala Piper | tempo real (sintetiza mais rápido do que reproduz) |
| Transcrição Whisper `small` (modelo já carregado) | ~4× o tempo do áudio (5 s ≈ 19 s) |

### Por que a primeira palavra demora

Em CPU, o custo dominante **não** é gerar a resposta: é **processar o prompt**
(~25 tokens/s). Por isso o app:

- usa trechos de **700 caracteres** na indexação e corta cada trecho em 550
  caracteres ao montar o contexto;
- recupera apenas **3 trechos** por pergunta (ajustável);
- envia no máximo **6 mensagens** de histórico, truncadas em 400 caracteres.

Só essas medidas derrubaram a primeira palavra de **107 s para ~28 s**. Aumentar
`topK` ou afrouxar esses limites melhora o contexto, mas deixa a resposta mais lenta.

### O truque das threads

O Ollama **escolhe mal o número de threads em VMs**. Medido aqui:

| Modelo | threads automáticas | melhor configuração |
|---|---|---|
| `qwen3.5:2b` | 9,0 tok/s | **7 threads → 9,9 tok/s** |
| `qwen3.5:0.8b` | 10,0 tok/s | **4 threads → 17,2 tok/s** |
| `qwen3.5:0.8b` | — | 14 threads → 0,2 tok/s (desastre) |

Por isso o app usa **metade dos núcleos, limitado a 8**, por padrão — ajustável
em ⚙️ → *Núcleos para a IA* (0 = automático).

### Latência percebida

- O modelo de conversa é **pré-carregado** na inicialização (sem isso, a
  primeira pergunta esperava ~60 s a mais só para o modelo subir).
- O modelo de transcrição é **pré-carregado em paralelo** quando você aperta
  o microfone — enquanto você ainda está falando.
- A resposta é falada **frase por frase conforme chega**: o mascote começa a
  falar antes de terminar de escrever.
- O painel mostra o **tempo decorrido** enquanto ele pensa.
- `keep_alive: 30m` mantém o modelo na memória entre as perguntas.

---

## Teste sem interface

```bash
node scripts/smoke-test.js              # corpus pequeno, valida todo o caminho
node scripts/smoke-test.js --full       # indexa o livro de teste inteiro
node scripts/smoke-test.js --clear      # limpa a base antes
```

Ele verifica extração, chunking, embeddings, busca semântica, conversa com RAG,
síntese de voz e transcrição.

Para conferir a interface sem depender do Ollama (útil ao mexer no CSS):

```bash
./node_modules/.bin/electron --no-sandbox scripts/ui-preview.js /tmp/nino-ui
```

Gera capturas PNG dos 7 estados da interface (ocioso, conversa, base,
indexando, ajustes, ouvindo, falando).

---

## Problemas comuns

**Não ouço o mascote falar.** Duas causas, nesta ordem:

1. **Fones Bluetooth trocam de perfil.** Quando o microfone é usado, o Windows
   passa do perfil de música (A2DP) para o de chamadas (mãos-livres), e a saída
   deixa de existir. Se o app estiver **fixado** num dispositivo específico, o
   som quebra nessa troca. Deixe em **"Padrão do sistema"** (⚙️ → Saída de
   áudio) — assim ele acompanha a troca sozinho.
2. **A saída padrão é um fone que não está no seu ouvido.** O áudio "toca" nele
   e você não escuta nada. Escolha outra saída no mesmo ajuste; o app toca um
   aviso na saída nova na hora, e o botão **🔊 Testar a voz agora** confirma.

Se ainda assim não sair som, clique uma vez na página antes de perguntar
(navegadores só liberam áudio depois de uma interação).

**O mascote não me ouve.** O nível do microfone aparece ao vivo no cabeçalho
(`ouvindo… ▃▃▃`) — se as barras não se mexem quando você fala, o problema é o
dispositivo de entrada do Windows, não o app. Ajuste em
Configurações → Sistema → Som → Entrada.

**Não vejo o mascote no WSL, mas ele aparece na barra de tarefas.** Causa
conhecida: o WSLg usa um **sistema de coordenadas próprio**, diferente do
Windows (reporta o monitor em `(0, 847)` quando o Windows diz `(0, 0)`), então
as janelas nascem espalhadas ou fora da área visível. O app de Linux tem um
resgate automático, mas se o WSLg estiver quebrado (sem `/dev/dri`), **use o
modo Windows nativo** — é o caso desta máquina.

**A janela aparece preta em vez de transparente.** Alguns compositores não
suportam transparência. Rode com `NINO_DISABLE_GPU=1 npm start`, ou use o modo web.

---

## Limitações conhecidas

- PDFs **digitalizados** (imagens) não têm texto extraível — precisariam de OCR.
- A base é um índice em memória sobre um JSON; confortável até dezenas de
  milhares de trechos, não é um banco vetorial de produção.
- O mascote é um só, com uma conversa por vez.
