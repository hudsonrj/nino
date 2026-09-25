# 🐣 Nino — mascote-assistente flutuante

Um mascote que fica **flutuando sobre as janelas**, conversa por **texto e voz**,
**ouve pelo microfone** e aprende com os **seus documentos e livros**.

Tudo roda **localmente**: a conversa, a voz, a transcrição e a base de
conhecimento ficam na sua máquina. Nada é enviado para a nuvem.

> **A exceção é o JEV** (a visão "Meu dia"): ele roda na nuvem da TypeSafe e é
> **desligado por padrão**. Quando ligado, o texto dos seus e-mails sai da
> máquina — e só depois de você aprovar uma prévia que mostra exatamente o que
> vai sair. Veja [Meu dia](#-meu-dia--jev-decide-o-modelo-local-escreve).

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
| 📷 Visão — câmera | Olha pela câmera: descreve quem está aí, o que a pessoa parece sentir e o ambiente ao redor |
| 🖥️ Visão — tela | Captura a tela e explica o que está acontecendo, o que você está fazendo e o que chama atenção |
| 🌤️ Meu dia | Lê Gmail e Google Agenda, o JEV tria em ~0,3 s e o modelo local escreve o resumo e as respostas |

---

## 🌤️ Meu dia — o JEV decide, o modelo local escreve

O gargalo deste projeto é que o modelo local leva **de 27 a 180 segundos** por
resposta na CPU. Triar 100 e-mails com ele levaria horas.

O **JEV** (TypeSafe) resolve isso: não é um modelo de conversa, é um modelo de
**decisão**. Você entrega o texto e perguntas tipadas, e ele devolve escolhas em
**~0,3 s**, por cerca de **US$ 0,0002** por triagem. Então:

> **O JEV decide o que importa. O modelo local só escreve o que sobra.**

### Por que não pela OpenRouter

O guia do JEV manda usar a OpenRouter (`typesafe/jev-1.13`). Conferimos a lista
de modelos da OpenRouter: **458 modelos, nenhum da TypeSafe**, e o link da
documentação apontada no guia dá 404. A rota que funciona é a **API direta**,
`api.typesafe.ai/v1/systemone`, com o modelo `jev-latest`. Chave em
[console.typesafe.ai/keys](https://console.typesafe.ai/keys).

### Como configurar

1. **JEV** — crie a chave e cole em ⚙️ → *Chave da TypeSafe*. Use **⚡ Testar o
   JEV agora** para ver o JEV responder de verdade, com tempo e custo.
2. **Gmail** — informe seu endereço e uma **senha de app**
   ([myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords),
   exige verificação em duas etapas). Não é a sua senha normal.
3. **Agenda** — no Google Agenda, em *Ajustes → escolha a agenda → Endereço
   secreto no formato iCal*. É uma URL longa, **só de leitura e sem senha**.
4. Ligue a chave **Usar o JEV para triar meu e-mail e minha agenda**.
5. Abra a visão 🌤️ e clique em **Fazer o resumo do dia**.

### Privacidade, em três travas

Ao contrário do resto do Nino, aqui algo **sai da máquina**. Por isso:

- O JEV vem **desligado**, e as credenciais ficam em
  `~/.config/nino/credenciais.json` — **fora do repositório**, com permissão
  `600`. A interface nunca mostra o valor de volta, só uma dica mascarada.
- Antes de qualquer envio, o Nino mostra a **prévia** com o que sairia, o número
  de perguntas, os tokens e o custo estimado. Nada é enviado sem você aprovar.
- Em ⚙️ você escolhe se o **corpo** dos e-mails vai junto. Só o cabeçalho
  (remetente, assunto, data) já dá uma triagem decente; sem ele, ainda menos
  conteúdo sai.

### O que ele pergunta

Tudo numa chamada só — o JEV avalia as perguntas em paralelo e cobra quase nada
por pergunta extra. Para cada mensagem:

| Pergunta | Forma | Por quê |
|---|---|---|
| O que fazer com ela? | escolha | responder hoje / nesta semana / só ler / descartar |
| Quão urgente é? | nota (4 níveis) | ordena a fila |
| Que tipo de remetente? | escolha | cliente, lead, fornecedor, financeiro, propaganda… |
| Precisa de resposta escrita sua? | sim/não | decide se vale gastar o modelo local |
| Parece golpe ou alerta de segurança? | sim/não | tira o phishing do balde "pode apagar sem ler" |

Para cada compromisso: **o que preparar antes** (escolha) e **se não pode
faltar** (sim/não).

Três decisões que valem explicar:

- **A confiança decide quem age sozinho.** Abaixo do limite que você escolher, o
  item vai para a pilha *"o JEV não teve certeza — decida você"*.
- **Só a confiança da ação bloqueia.** O tipo de remetente é rótulo: com oito
  opções, a confiança dele fica baixa mesmo quando a ação está claríssima. Na
  primeira versão eu exigia as duas, e o e-mail mais urgente da caixa ia parar
  na pilha de incerteza enquanto *Responder hoje* ficava vazia.
- **Golpe não é lixo comum.** Um phishing classificado como "descartar" sairia no
  balde *"pode apagar sem ler"* — se fosse um aviso real do banco, você perderia.
  Por isso a pergunta extra: suspeito vai para a sua própria pilha.
- **O JEV não faz contas nem compara datas.** Quem ordena e soma é o código; o
  JEV só dá os julgamentos. E quando ele não tem certeza do preparo de um
  compromisso, o resumo **não afirma** nada em vez de inventar.

### Enviar respostas

O modelo local escreve o rascunho, você edita na tela e o envio exige **dois
toques** — o segundo confirma de verdade. A API também recusa qualquer envio
sem `confirmado: true`. A resposta sai encadeada na conversa original
(`In-Reply-To`/`References`).

### Perguntar no chat

Depois de fazer o resumo do dia, dá para perguntar direto na conversa:
*"o que eu tenho hoje?"*, *"tem algo urgente?"*, *"preciso responder alguém?"*.
O Nino responde a partir da triagem que você **já aprovou**.

Essa é uma decisão de privacidade, não uma limitação técnica: uma pergunta no
chat **nunca** dispara um envio novo de e-mails para a nuvem. Se ainda não
houver triagem na sessão, ele explica como fazer em vez de mandar seus e-mails
para fora sem avisar.

### Testar sem chave

```bash
npm run test:jev
```

Sobe um servidor TypeSafe falso e confere o formato exato da requisição, a
leitura das três formas de resposta, o cálculo de confiança, um lote de 100
perguntas numa chamada e as mensagens de erro. Não gasta nada.

### Testar com a chave de verdade

```bash
npm run test:dia
```

Faz **uma** chamada real (≈ US$ 0,0002) com sete e-mails **inventados** — um
urgente, uma proposta, uma newsletter, um phishing e um vago de propósito — e
mostra como o JEV classificou cada um. Serve para conferir se as perguntas em
inglês produzem decisões sensatas com **conteúdo em português**, que é o idioma
dos seus e-mails. Nenhum dado seu é enviado.

Ele também confere o resultado sozinho e avisa se algo se perdeu: nada marcado
para hoje, suspeito caindo no lixo comum, ou o resumo afirmando um preparo sem
confiança.

---

## Visão (câmera e tela)

Os modelos `qwen3.5` **enxergam**, então o mascote usa o mesmo modelo da conversa
para olhar. Dois botões no campo de mensagem:

- **📷** tira uma foto pela câmera e responde: quem está aí, como a pessoa parece
  se sentir (pelo rosto e postura) e o que há no ambiente.
- **🖥️** captura a tela e explica o que está acontecendo, o que você está fazendo
  e o que chama atenção — com uma sugestão de próximo passo quando faz sentido.

A resposta é falada como qualquer outra, frase por frase.

**Também funciona por texto.** Escrever um pedido que só faz sentido com imagem
liga a captura sozinho — não precisa clicar no botão:

| Você escreve | O que acontece |
|---|---|
| "olhe para mim", "o que você vê?", "como eu estou?" | liga a câmera |
| "olhe minha tela", "o que eu estou fazendo?", "explica o que está acontecendo" | captura a tela |
| "o que é uma tela OLED?" | conversa normal (não captura nada) |

A detecção é por expressões, não por um modelo: é previsível e nunca captura
nada por engano em perguntas comuns. Ajuste em `detectVisionIntent()`
(`src/renderer/mascot.js`) se quiser outros gatilhos.

**Privacidade:** a imagem vai apenas para o **Ollama local** e fica **só na
memória** — nunca é gravada em disco. A câmera é ligada durante a captura e
**desligada em seguida**. Para desligar tudo, use ⚙️ → *Visão*.

**Custo e tempo:** a primeira imagem de uma sessão carrega o projetor visual
(~100 s, uma vez só — o servidor já faz isso em segundo plano ao iniciar).
Depois disso, cada análise leva de **1 a 3 minutos** na CPU. Reduza
`maxImageSide` (padrão 640) nos ajustes para acelerar.

**Como cada ambiente captura a tela:**

| Ambiente | Como |
|---|---|
| Shell Windows | `desktopCapturer` do Electron — direto, sem seletor nem permissão |
| Navegador | `getDisplayMedia` — o navegador mostra o seletor de janela/tela |
| Desktop Linux | igual ao navegador |

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

E, **fora do repositório** (porque são segredos):

```
~/.config/nino/credenciais.json     chave do JEV + senha de app do Gmail
                                    (permissão 600, nunca commitado)
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
node scripts/test-jev.js                # integração com o JEV, sem chave real
node scripts/test-dia.js                # uma chamada real, com e-mails inventados
```

Ele verifica extração, chunking, embeddings, busca semântica, conversa com RAG,
síntese de voz e transcrição.

Para conferir a interface sem depender do Ollama (útil ao mexer no CSS):

```bash
./node_modules/.bin/electron --no-sandbox scripts/ui-preview.js /tmp/nino-ui
```

Gera capturas PNG dos 11 estados da interface (ocioso, conversa, base,
indexando, ajustes, ajustes do JEV, ouvindo, falando, prévia do dia, resultado
da triagem e rascunho de resposta).

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

**"O Gmail recusou o login."** Você usou a senha normal da conta. O Gmail só
aceita **senha de app**, e ela exige verificação em duas etapas ligada. Gere em
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
— o app já remove os espaços automaticamente.

**A agenda não carrega.** O endereço secreto do iCal é longo e fácil de cortar
ao copiar; confira se ele termina em `.ics`. Ele é **só de leitura**: o Nino lê a
agenda, mas não cria nem altera eventos.

**"O JEV está desligado."** É o padrão, de propósito. Ligue a chave em ⚙️ →
*Usar o JEV para triar meu e-mail e minha agenda*.

**A chave do JEV foi recusada.** Copie a chave inteira de
console.typesafe.ai/keys. O guia do JEV sugere a OpenRouter, mas ela **não
oferece** o modelo: use a chave direta da TypeSafe.

**"É preciso aprovar a prévia antes de enviar."** Trava de segurança. Clique em
**Fazer o resumo do dia** (que mostra a prévia) em vez de pular direto para a
triagem.

---

## Limitações conhecidas

- PDFs **digitalizados** (imagens) não têm texto extraível — precisariam de OCR.
- A base é um índice em memória sobre um JSON; confortável até dezenas de
  milhares de trechos, não é um banco vetorial de produção.
- O mascote é um só, com uma conversa por vez.
- **A visão "Meu dia" funciona no modo web/navegador** (🌤️ e ⚙️). O app de
  desktop em Electron ainda não expõe essas rotas pela ponte nativa.
- O JEV **lê** a agenda (pelo iCal); **criar e alterar eventos exigiria CalDAV
  com OAuth**, que não está implementado.
- Só Gmail: outros provedores precisariam de ajuste nos endereços de IMAP/SMTP
  (`src/main/python/mailbox.py`), embora a estrutura já seja genérica.
- Repetições de agenda complexas (regras `RRULE` exóticas) aparecem só na
  primeira ocorrência; diárias e semanais são expandidas corretamente.
