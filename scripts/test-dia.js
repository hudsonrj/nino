'use strict';

/**
 * Teste do dia inteiro contra o JEV DE VERDADE.
 *
 * Diferente do test-jev.js (que usa um servidor falso), este aqui faz uma
 * chamada real à TypeSafe, com e-mails INVENTADOS. Serve para conferir se as
 * perguntas em inglês do Nino produzem decisões sensatas com conteúdo em
 * português — que é o idioma dos seus e-mails de verdade.
 *
 *   node scripts/test-dia.js
 *
 * Custa cerca de US$ 0,0002 (uma chamada). Nenhum dado seu é enviado: tudo
 * abaixo é fictício.
 */

const P = `${__dirname}/../src/main/`;
const mailbox = require(`${P}mailbox`);
const credentials = require(`${P}credentials`);

const fakes = [
  {
    uid: '1',
    nomeDe: 'Ana Souza',
    de: 'ana@clientex.com.br',
    assunto: 'URGENTE: contrato para assinar hoje',
    data: 'Fri, 25 Sep 2026 09:12:00 -0300',
    texto:
      'Hudson, preciso da sua assinatura no contrato ainda hoje. O prazo da ' +
      'licitação encerra às 18h e sem isso perdemos a concorrência.',
  },
  {
    uid: '2',
    nomeDe: 'Substack',
    de: 'news@substack.com',
    assunto: 'As 5 leituras da semana',
    data: 'Fri, 25 Sep 2026 06:00:00 -0300',
    texto: 'Veja os textos mais lidos desta semana. Aproveite 20% de desconto.',
  },
  {
    uid: '3',
    nomeDe: 'Marcos Lima',
    de: 'marcos@parceiro.com',
    assunto: 'Proposta revisada — precisamos de um retorno',
    data: 'Thu, 24 Sep 2026 15:40:00 -0300',
    texto:
      'Segue a proposta com os ajustes que combinamos. Consegue avaliar até o ' +
      'fim da semana? Não é urgente, mas queria fechar esse ciclo.',
  },
  {
    uid: '4',
    nomeDe: 'Rafael Prado',
    de: 'rafael@startup.io',
    assunto: 'Sobre aquilo que conversamos',
    data: 'Thu, 24 Sep 2026 21:15:00 -0300',
    texto:
      'Oi! Fiquei de te mandar os números, mas antes queria entender uma coisa. ' +
      'Você comentou que talvez fizesse sentido a gente conversar mais.',
  },
  {
    uid: '5',
    nomeDe: 'Suporte Banco',
    de: 'seguranca@banco-digital-alerta.com',
    assunto: 'Sua conta será bloqueada em 24 horas',
    data: 'Fri, 25 Sep 2026 03:22:00 -0300',
    texto:
      'Detectamos um acesso suspeito. Clique no link e confirme seus dados e ' +
      'senha para evitar o bloqueio imediato da sua conta.',
  },
  {
    uid: '6',
    nomeDe: 'Fatura',
    de: 'naoresponda@banco.com',
    assunto: 'Sua fatura de setembro fechou',
    data: 'Thu, 24 Sep 2026 06:00:00 -0300',
    texto: 'Sua fatura já está disponível para consulta. Vencimento em 5 de outubro.',
  },
  {
    uid: '7',
    nomeDe: 'Carla Nogueira',
    de: 'carla@empresa.com',
    assunto: 'Podemos remarcar a reunião de quinta?',
    data: 'Thu, 24 Sep 2026 18:02:00 -0300',
    texto:
      'Tive um imprevisto e não vou conseguir na quinta. Alguma chance de passar ' +
      'para a semana que vem?',
  },
];

const EVENTOS = [
  {
    inicio: '2026-09-25T17:00:00Z',
    chaveDia: '2026-09-25',
    hora: '14:00',
    horaFim: '15:00',
    titulo: 'Reunião de alinhamento com o cliente',
    local: 'Sala 3',
    descricao: 'Revisar os números do trimestre',
    organizador: 'ana@clientex.com.br',
    convidados: ['Ana Souza', 'Marcos Lima'],
    diaInteiro: false,
    repete: false,
  },
  {
    inicio: '2026-09-25T20:00:00Z',
    chaveDia: '2026-09-25',
    hora: '17:00',
    horaFim: '17:30',
    titulo: 'Revisão semanal',
    local: '',
    descricao: '',
    organizador: '',
    convidados: [],
    diaInteiro: false,
    repete: true,
  },
];

/** Substitui o acesso real ao Gmail por dados inventados. */
function fingirCaixaDeEntrada() {
  mailbox.eventos = async () => ({
    ok: true,
    eventos: EVENTOS,
    porDia: [{ chave: '2026-09-25', rotulo: 'sex 25/09', eventos: [] }],
  });
  mailbox.listar = async () => ({
    ok: true,
    pasta: 'INBOX',
    mensagens: fakes.map((f) => ({
      uid: f.uid,
      de: f.de,
      nomeDe: f.nomeDe,
      assunto: f.assunto,
      data: f.data,
      messageId: `<${f.uid}@exemplo>`,
      naoLido: true,
    })),
  });
  mailbox.ler = async (uid) => {
    const f = fakes.find((x) => x.uid === uid);
    return { ok: true, mensagem: { ...f, para: 'eu@exemplo.com', referencias: '', anexos: [] } };
  };
}

const linha = (c = '─') => console.log(c.repeat(64));

function mostrar(rotulo, lista, campos) {
  console.log(`\n--- ${rotulo} (${lista.length}) ---`);
  if (!lista.length) {
    console.log('  (nenhum)');
    return;
  }
  for (const m of lista) {
    console.log(`  • ${m.de} — "${m.assunto}"`);
    console.log(`      ${campos(m)}`);
  }
}

async function principal() {
  if (!credentials.chaveTypesafe()) {
    console.error(
      '\nSem chave da TypeSafe. Salve a sua em ~/.config/nino/credenciais.json\n' +
        '(o painel do Nino, em Ajustes, tem o campo).\n'
    );
    return 1;
  }
  if (process.env.NINO_TYPESAFE_URL) {
    console.log(`\nAtenção: NINO_TYPESAFE_URL=${process.env.NINO_TYPESAFE_URL}`);
  }

  fingirCaixaDeEntrada();
  const agenda = require(`${P}agenda`);

  console.log('\nE-mails e agenda FICTÍCIOS. Nenhum dado seu sai da máquina.\n');

  const p = await agenda.previa({ dias: 2 });
  console.log(`${p.quantidadePerguntas} perguntas · ~${p.tokensAproximados} tokens`);
  console.log(`custo estimado: US$ ${p.custoEstimadoUSD.toFixed(6)}`);

  linha();
  console.log('TRIAGEM REAL');
  linha();
  const t = await agenda.triar({ dias: 2 });
  console.log(
    `${t.ms} ms · US$ ${t.custoUSD.toFixed(8)} · ${t.uso.tokensEntrada} tokens de entrada`
  );

  const campos = (m) =>
    `ação=${m.acaoRotulo} | urgência=${m.urgenciaRotulo} | tipo=${m.tipoRotulo}` +
    `${m.tipoConfiavel === false ? ' (incerto)' : ''} | ` +
    `escrever=${m.precisaEscrever} | suspeito=${Boolean(m.suspeito)} | ` +
    `confiança=${(m.confianca ?? 0).toFixed(2)}`;

  mostrar('RESPONDER HOJE', t.filaDoDia, campos);
  mostrar('RESPONDER NESTA SEMANA', t.daSemana, campos);
  mostrar('INCERTO', t.revisar, campos);
  mostrar('SUSPEITO', t.suspeitos, campos);
  mostrar('RUÍDO (pode apagar sem ler)', t.ruido, campos);

  console.log('\n--- AGENDA ---');
  for (const e of t.eventos) {
    console.log(
      `  • ${e.day} ${e.time} ${e.title}\n` +
        `      preparo=${e.preparoRotulo}${e.preparoConfiavel ? '' : ' (incerto)'} | ` +
        `essencial=${e.essencial} | confiança=${(e.confianca ?? 0).toFixed(2)}`
    );
  }

  console.log('\n--- O QUE ACONTECE SE ALGO DER ERRADO ---');
  const alertas = [];
  if (!t.filaDoDia.length) alertas.push('nada marcado para hoje (o e-mail urgente se perdeu)');
  if (t.suspeitos.some((m) => t.ruido.includes(m))) alertas.push('suspeito caiu no lixo comum');
  if (t.eventos.some((e) => !e.preparoConfiavel && /preparar/.test(t.resumo))) {
    alertas.push('resumo afirma preparo sem confiança');
  }
  if (alertas.length) {
    for (const a of alertas) console.log(`  ATENÇÃO: ${a}`);
  } else {
    console.log('  nenhum problema detectado nas respostas desta rodada.');
  }

  linha();
  console.log('RESUMO QUE VAI PARA O MODELO LOCAL');
  linha();
  console.log(t.resumo);
  console.log('');

  return alertas.length ? 1 : 0;
}

principal()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error('\nFalhou:', err.message);
    process.exit(1);
  });
