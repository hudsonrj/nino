'use strict';

/**
 * O dia do usuário, decidido pelo JEV.
 *
 * O desenho: o JEV lê a caixa de entrada e a agenda e responde, em ~0,3 s,
 * o que merece atenção. Só depois o modelo local escreve — e só sobre o que
 * sobrou. Sem isso, triar 100 e-mails no modelo local levaria horas.
 *
 * Privacidade: o e-mail do usuário sai da máquina quando vai para o JEV
 * (nuvem da TypeSafe), ao contrário do resto do Nino, que é 100% local.
 * Por isso `previa()` monta exatamente o que sairia, e nada é enviado antes
 * de o usuário aprovar aquela prévia.
 *
 * Sobre o idioma: o guia do JEV diz que inglês funciona melhor. As perguntas
 * e as opções vão em inglês; o conteúdo (seus e-mails) vai no idioma em que
 * estiver. Os rótulos em português para a tela ficam nos mapas daqui.
 */

const jev = require('./jev');
const mailbox = require('./mailbox');
const credentials = require('./credentials');

/* ------------------------------------------------------------------ */
/* Rótulos em português para as respostas do JEV                       */
/* ------------------------------------------------------------------ */

const ROTULOS = {
  acao: {
    responder_agora: 'responder hoje',
    responder_semana: 'responder nesta semana',
    so_ler: 'só ler, sem resposta',
    descartar: 'descartar',
  },
  urgencia: ['ruído', 'pode esperar', 'importante', 'urgente hoje'],
  tipo: {
    cliente: 'cliente',
    lead: 'cliente em potencial',
    fornecedor: 'fornecedor',
    trabalho: 'trabalho',
    pessoal: 'pessoal',
    financeiro: 'financeiro',
    propaganda: 'propaganda',
    sistema: 'aviso automático',
  },
  preparo: {
    nada: 'nada a preparar',
    ler_antes: 'ler algo antes',
    preparar_material: 'preparar material',
    confirmar: 'confirmar presença',
    remarcar: 'remarcar ou recusar',
  },
};

/** Perguntas fixas, em inglês (o guia do JEV recomenda inglês). */
const CRITERIOS = {
  acao: {
    responder_agora: 'A reply from me is needed today; it is time-sensitive or from someone important.',
    responder_semana: 'A reply is warranted but it can wait a few days.',
    so_ler: 'Worth reading, but no reply from me is expected.',
    descartar: 'Bulk mail, newsletter, promotion, automated notice or spam. No action.',
  },
  urgencia: [
    'Noise or bulk mail with no personal relevance.',
    'Can wait. Low stakes, no deadline.',
    'Important. Should be handled within a few days.',
    'Urgent. Needs my attention today.',
  ],
  tipo: {
    cliente: 'An existing customer or client.',
    lead: 'A potential new customer or business enquiry.',
    fornecedor: 'A vendor, supplier or service provider.',
    trabalho: 'A colleague, employer, partner or work matter.',
    pessoal: 'Personal, family or social.',
    financeiro: 'Bank, invoice, payment, tax or billing.',
    propaganda: 'Newsletter, marketing, promotion or spam.',
    sistema: 'Automated notification, receipt or system alert.',
  },
  preparo: {
    nada: 'Nothing to prepare; just show up.',
    ler_antes: 'I should read something beforehand.',
    preparar_material: 'I need to produce something (document, numbers, slides).',
    confirmar: 'I need to confirm or decline my attendance.',
    remarcar: 'This needs to be rescheduled or refused.',
  },
};

/* ------------------------------------------------------------------ */
/* Coleta do estado                                                    */
/* ------------------------------------------------------------------ */

/** Corta o texto para caber no orçamento de tokens da chamada. */
function enxugar(texto, limite) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > limite ? `${t.slice(0, limite)}…` : t;
}

/**
 * Junta agenda + caixa de entrada num estado só, que é o que o JEV avalia.
 * `incluirCorpo` decide se o corpo dos e-mails entra (mais preciso, mais
 * dados saindo da máquina) ou só o cabeçalho.
 */
async function coletar(opcoes = {}) {
  const dias = Math.min(14, Math.max(1, Number(opcoes.dias) || 2));
  const limite = Math.min(40, Math.max(1, Number(opcoes.limiteMensagens) || 12));
  const somenteNaoLidos = opcoes.somenteNaoLidos !== false;
  const incluirCorpo = opcoes.incluirCorpo !== false;

  const avisos = [];

  const agenda = await mailbox.eventos({ dias, max: 40 });
  if (!agenda.ok) avisos.push(`Agenda: ${agenda.erro}`);

  const caixa = await mailbox.listar({ limite, somenteNaoLidos });
  if (!caixa.ok) avisos.push(`E-mail: ${caixa.erro}`);

  const mensagens = (caixa.mensagens || []).map((m) => ({
    uid: m.uid,
    de: m.nomeDe || m.de,
    enderecoDe: m.de,
    assunto: m.assunto,
    data: m.data,
    messageId: m.messageId,
    naoLido: m.naoLido,
    trecho: '',
  }));

  // Buscar o corpo é uma conexão por mensagem; fazemos em série, com calma,
  // porque o Gmail limita conexões simultâneas.
  if (incluirCorpo) {
    for (const m of mensagens) {
      const r = await mailbox.ler(m.uid);
      if (r.ok && r.mensagem) {
        m.trecho = enxugar(r.mensagem.texto, 1400);
        m.para = r.mensagem.para;
        m.referencias = r.mensagem.referencias;
        m.anexos = r.mensagem.anexos;
      } else if (r.erro) {
        avisos.push(`Mensagem ${m.uid}: ${r.erro}`);
        break; // se uma falhou, as outras provavelmente também
      }
    }
  }

  return {
    agora: new Date().toISOString(),
    agendaOk: Boolean(agenda.ok),
    eventos: (agenda.eventos || []).map((e) => ({
      inicio: e.inicio,
      hora: e.hora,
      horaFim: e.horaFim,
      titulo: e.titulo,
      local: e.local,
      descricao: enxugar(e.descricao, 300),
      organizador: e.organizador,
      convidados: e.convidados,
      diaInteiro: e.diaInteiro,
      repete: e.repete,
    })),
    porDia: agenda.porDia || [],
    mensagens,
    avisos,
  };
}

/** Limpa o estado para virar o `state` da chamada: só o que o JEV precisa. */
function estadoParaJev(dados) {
  return {
    now: dados.agora,
    calendar_today_and_next_days: dados.porDia.map((d) => ({
      day: d.rotulo,
      events: d.eventos.map((e) => ({
        time: e.diaInteiro ? 'all day' : `${e.hora}${e.horaFim ? `-${e.horaFim}` : ''}`,
        title: e.titulo,
        location: e.local || undefined,
        organizer: e.organizador || undefined,
        repeats: e.repete || undefined,
      })),
    })),
    inbox: dados.mensagens.map((m) => ({
      from: m.de,
      from_email: m.enderecoDe,
      subject: m.assunto,
      date: m.data,
      unread: m.naoLido,
      body: m.trecho || undefined,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* As perguntas                                                        */
/* ------------------------------------------------------------------ */

/**
 * Monta as perguntas para um lote de mensagens. Cada mensagem recebe três
 * perguntas independentes; o código combina as respostas depois.
 * Todas vão numa chamada só — o JEV avalia em paralelo e cobra quase nada
 * por pergunta extra.
 */
function perguntasMensagens(deslocamento, quantidade) {
  const q = {};
  for (let i = 0; i < quantidade; i += 1) {
    const indice = deslocamento + i;
    const alvo = `inbox[${indice}]`;
    q[`acao_${indice}`] = jev.escolha(
      `What should I do with the message in \`${alvo}\`? Judge only that message.`,
      CRITERIOS.acao
    );
    q[`urgencia_${indice}`] = jev.nota(
      `How urgent is \`${alvo}\` to me?`,
      CRITERIOS.urgencia
    );
    q[`tipo_${indice}`] = jev.escolha(`What kind of sender wrote \`${alvo}\`?`, CRITERIOS.tipo);
    q[`precisa_escrever_${indice}`] = jev.noul(
      `Does \`${alvo}\` need a considered written reply from me, rather than a one-line acknowledgement or no reply at all?`
    );
  }
  return q;
}

function perguntasEventos(quantidade) {
  const q = {};
  for (let i = 0; i < quantidade; i += 1) {
    const alvo = `calendar_flat[${i}]`;
    q[`preparo_${i}`] = jev.escolha(
      `What do I need to do before \`${alvo}\`?`,
      CRITERIOS.preparo
    );
    q[`essencial_${i}`] = jev.noul(
      `Is \`${alvo}\` something I should not miss or move?`
    );
  }
  return q;
}

/** Rótulo do dia (ex.: "sex 25/09") a que um evento pertence. */
function rotuloDoDia(dados, evento) {
  const d = new Date(evento.inicio);
  const chave = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
  const dia = dados.porDia.find((x) => x.chave === chave);
  return dia ? dia.rotulo : '';
}

/** Lista plana de eventos, para as perguntas poderem apontar por índice. */
function eventosPlanos(dados) {
  return dados.eventos.map((e, i) => ({
    index: i,
    day: rotuloDoDia(dados, e),
    time: e.diaInteiro ? 'all day' : `${e.hora}${e.horaFim ? `-${e.horaFim}` : ''}`,
    title: e.titulo,
    location: e.local || undefined,
    organizer: e.organizador || undefined,
    description: e.descricao || undefined,
    attendees: e.convidados.length ? e.convidados : undefined,
  }));
}

/* ------------------------------------------------------------------ */
/* Prévia: o que sairia da máquina                                     */
/* ------------------------------------------------------------------ */

/**
 * Monta tudo (estado + perguntas) sem enviar nada. A interface mostra isto
 * ao usuário e só prossegue com a aprovação dele.
 */
async function previa(opcoes = {}) {
  const dados = await coletar(opcoes);
  const planos = eventosPlanos(dados);
  const estado = estadoParaJev(dados);
  estado.calendar_flat = planos;

  const perguntas = {};
  Object.assign(perguntas, perguntasEventos(planos.length));
  Object.assign(perguntas, perguntasMensagens(0, dados.mensagens.length));

  const linhas = [];
  linhas.push(`${dados.mensagens.length} mensagem(ns) da caixa de entrada`);
  for (const m of dados.mensagens) {
    linhas.push(
      `  • ${m.de} — "${m.assunto}"${m.trecho ? ` (corpo: ${m.trecho.length} caracteres)` : ' (só o cabeçalho)'}`
    );
  }
  linhas.push(`${planos.length} compromisso(s) na agenda`);
  for (const e of planos.slice(0, 20)) {
    linhas.push(`  • ${e.day} ${e.time} — ${e.title}`);
  }
  linhas.push(
    `${Object.keys(perguntas).length} pergunta(s) tipada(s) — nenhuma resposta é texto livre`
  );

  const texto = JSON.stringify(estado, null, 2);
  return {
    ok: dados.mensagens.length > 0 || planos.length > 0,
    estado,
    perguntas,
    quantidadePerguntas: Object.keys(perguntas).length,
    resumo: linhas.join('\n'),
    // O tamanho aproximado do que sairia, em tokens (1 token ≈ 4 caracteres).
    caracteres: texto.length,
    tokensAproximados: Math.round(texto.length / 4),
    custoEstimadoUSD: (Math.round(texto.length / 4) * 0.042) / 1_000_000,
    avisos: dados.avisos,
    dados,
    planos,
  };
}

/**
 * Guarda a última coleta por dois minutos.
 *
 * Motivo prático: buscar o corpo de cada mensagem é uma conexão IMAP por
 * e-mail. Sem este cache, o usuário veria a prévia (que baixa tudo), clicaria
 * em "enviar ao JEV" e tudo seria baixado de novo — o dobro do tempo e duas
 * vezes mais acesso à caixa dele.
 */
let cache = { chave: null, quando: 0, valor: null };

async function previaComCache(opcoes = {}, forcar = false) {
  const chave = JSON.stringify(opcoes);
  const idade = Date.now() - cache.quando;
  if (!forcar && cache.valor && cache.chave === chave && idade < 120000) {
    return { ...cache.valor, doCache: true };
  }
  const p = await previa(opcoes);
  cache = { chave, quando: Date.now(), valor: p };
  return p;
}

/** Descarta o cache. Chamado depois de enviar uma resposta. */
function limparCache() {
  cache = { chave: null, quando: 0, valor: null };
}

/* ------------------------------------------------------------------ */
/* Triagem                                                             */
/* ------------------------------------------------------------------ */

/**
 * Roda a triagem de verdade: manda o estado ao JEV, junta as respostas e
 * separa o que é confiável do que precisa de olho humano.
 */
async function triar(opcoes = {}) {
  const minimo = Number(opcoes.confiancaMinima) || 0.6;
  const p = await previaComCache(opcoes, opcoes.forcar);
  if (!p.ok) {
    return {
      ok: false,
      erro:
        p.avisos[0] ||
        'Não há nada para triar: caixa de entrada e agenda vazias ou não configuradas.',
      avisos: p.avisos,
    };
  }

  const r = await jev.ask({ state: p.estado, questions: p.perguntas });

  const mensagens = [];
  p.dados.mensagens.forEach((m, i) => {
    const acao = r.respostas[`acao_${i}`];
    const urgencia = r.respostas[`urgencia_${i}`];
    const tipo = r.respostas[`tipo_${i}`];
    const escrever = r.respostas[`precisa_escrever_${i}`];
    const confiancaAcao = jev.confianca(acao);
    const seguro = jev.confiavel(acao, minimo) && jev.confiavel(tipo, minimo);
    mensagens.push({
      indice: i,
      uid: m.uid,
      de: m.de,
      enderecoDe: m.enderecoDe,
      assunto: m.assunto,
      data: m.data,
      naoLido: m.naoLido,
      messageId: m.messageId,
      referencias: m.referencias,
      anexos: m.anexos || [],
      trecho: m.trecho,
      acao: jev.opcao(acao),
      acaoRotulo: ROTULOS.acao[jev.opcao(acao)] || jev.opcao(acao) || '?',
      urgencia: jev.valor(urgencia),
      urgenciaRotulo: ROTULOS.urgencia[Math.round(jev.valor(urgencia) ?? 0)] || '?',
      tipo: jev.opcao(tipo),
      tipoRotulo: ROTULOS.tipo[jev.opcao(tipo)] || jev.opcao(tipo) || '?',
      precisaEscrever: (jev.probabilidade(escrever) ?? 0) >= 0.5,
      probabilidadeEscrever: jev.probabilidade(escrever),
      confianca: confiancaAcao,
      confiavel: seguro,
      probabilidades: (acao && acao.probabilities) || null,
    });
  });

  const eventos = p.planos.map((e, i) => {
    const preparo = r.respostas[`preparo_${i}`];
    const essencial = r.respostas[`essencial_${i}`];
    return {
      ...e,
      preparo: jev.opcao(preparo),
      preparoRotulo: ROTULOS.preparo[jev.opcao(preparo)] || jev.opcao(preparo) || '?',
      essencial: (jev.probabilidade(essencial) ?? 0) >= 0.5,
      probabilidadeEssencial: jev.probabilidade(essencial),
      confianca: jev.confianca(preparo),
      confiavel: jev.confiavel(preparo, minimo),
    };
  });

  // O código — não o JEV — faz a ordenação e as somas. O guia é explícito:
  // o JEV é fraco em matemática e em datas.
  const peso = (m) => (m.urgencia || 0) * 10 + (m.precisaEscrever ? 3 : 0);
  const ordenadas = [...mensagens].sort((a, b) => peso(b) - peso(a));

  const filaDoDia = ordenadas.filter(
    (m) => m.confiavel && (m.acao === 'responder_agora' || m.urgencia >= 3)
  );
  const revisar = ordenadas.filter((m) => !m.confiavel);
  const daSemana = ordenadas.filter(
    (m) => m.confiavel && m.acao === 'responder_semana' && !filaDoDia.includes(m)
  );
  const ruido = ordenadas.filter((m) => m.confiavel && m.acao === 'descartar');

  const eventosRelevantes = eventos.filter((e) => e.essencial || e.preparo !== 'nada');

  return {
    ok: true,
    quando: new Date().toISOString(),
    modelo: r.modelo,
    ms: r.ms,
    custoUSD: r.custoUSD,
    uso: r.uso,
    acumulado: jev.estatisticas(),
    confiancaMinima: minimo,
    mensagens,
    ordenadas,
    filaDoDia,
    revisar,
    daSemana,
    ruido,
    eventos,
    eventosRelevantes,
    porDia: p.dados.porDia,
    avisos: p.dados.avisos,
    resumo: montarResumo({ filaDoDia, daSemana, revisar, eventosRelevantes, ruido }),
  };
}

/**
 * Texto curto e factual para o modelo local ler e transformar em fala.
 * Nada aqui é escrito pelo JEV: são os fatos que ele classificou.
 */
function montarResumo({ filaDoDia, daSemana, revisar, eventosRelevantes, ruido }) {
  const l = [];
  if (eventosRelevantes.length) {
    l.push('AGENDA:');
    for (const e of eventosRelevantes.slice(0, 8)) {
      l.push(
        `- ${e.day} ${e.time}: ${e.title}` +
          (e.location ? ` (${e.location})` : '') +
          ` [${e.preparoRotulo}]`
      );
    }
  }
  if (filaDoDia.length) {
    l.push('RESPONDER HOJE:');
    for (const m of filaDoDia.slice(0, 8)) {
      l.push(`- ${m.de}: ${m.assunto} [${m.tipoRotulo}, ${m.urgenciaRotulo}]`);
    }
  }
  if (daSemana.length) {
    l.push('RESPONDER NESTA SEMANA:');
    for (const m of daSemana.slice(0, 8)) l.push(`- ${m.de}: ${m.assunto}`);
  }
  if (revisar.length) {
    l.push('INCERTO (o JEV não teve certeza, precisa do seu olho):');
    for (const m of revisar.slice(0, 8)) {
      l.push(`- ${m.de}: ${m.assunto} (ação sugerida: ${m.acaoRotulo})`);
    }
  }
  if (ruido.length) {
    l.push(`RUÍDO: ${ruido.length} mensagem(ns) que podem ser descartadas sem ler.`);
  }
  return l.join('\n');
}

module.exports = {
  ROTULOS,
  CRITERIOS,
  coletar,
  estadoParaJev,
  eventosPlanos,
  previa,
  previaComCache,
  limparCache,
  triar,
  montarResumo,
};
