'use strict';

/**
 * Teste da integração com o JEV — SEM gastar dinheiro e SEM chave real.
 *
 * Sobe um servidor TypeSafe falso na porta local, aponta o cliente para ele
 * e confere: o formato exato da requisição, a leitura das três formas de
 * resposta, o cálculo de confiança, um lote grande de perguntas e as
 * mensagens de erro.
 *
 *   node scripts/test-jev.js
 *
 * É assim que se valida a integração antes de colocar uma chave de verdade.
 * Contra a TypeSafe real, o mesmo código roda trocando NINO_TYPESAFE_URL.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORTA = 39099;
const CONFIG = path.join(os.tmpdir(), 'nino-teste-jev');

let capturado = null;
let falhas = 0;

function conferir(rotulo, condicao, detalhe) {
  const marca = condicao ? '  ok  ' : ' FALHA';
  if (!condicao) falhas += 1;
  console.log(`${marca}  ${rotulo}${detalhe ? ` — ${detalhe}` : ''}`);
}

const CHAVE_BOA = 'chave_de_teste_123';

const servidor = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => (corpo += c));
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${CHAVE_BOA}`) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          detail: { error_type: 'authentication_error', message: 'Must supply an API key!' },
        })
      );
      return;
    }

    let body;
    try {
      body = JSON.parse(corpo);
    } catch {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: { message: 'corpo inválido' } }));
      return;
    }
    capturado = { url: req.url, metodo: req.method, body };

    // Responde no formato da documentação da TypeSafe.
    const answers = {};
    for (const [id, q] of Object.entries(body.questions || {})) {
      if (q.type === 'choice') {
        const opcoes = Object.keys(q.criteria || {});
        const p = {};
        opcoes.forEach((o, i) => {
          p[o] = i === 0 ? 0.93 : 0.07 / Math.max(1, opcoes.length - 1);
        });
        answers[id] = { type: 'choice', choice: opcoes[0], confidence: 0.93, probabilities: p };
      } else if (q.type === 'score') {
        const niveis = q.criteria || [];
        answers[id] = {
          type: 'score',
          score: 2.99,
          confidence: 0.99,
          legend: Object.fromEntries(niveis.map((c, i) => [String(i), c])),
          probabilities: Object.fromEntries(
            niveis.map((c, i) => [String(i), i === niveis.length - 1 ? 0.99 : 0.003])
          ),
        };
      } else {
        answers[id] = { type: 'noul', noul: 0.78 };
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers,
        usage: { input_tokens: 478, output_tokens: 40 },
      })
    );
  });
});

function escreverCredenciais(apiKey) {
  fs.mkdirSync(CONFIG, { recursive: true });
  fs.writeFileSync(
    path.join(CONFIG, 'credenciais.json'),
    JSON.stringify({ typesafe: { apiKey }, google: {} })
  );
}

async function principal() {
  process.env.NINO_CONFIG_DIR = CONFIG;
  process.env.NINO_TYPESAFE_URL = `http://127.0.0.1:${PORTA}`;

  const jev = require('../src/main/jev');

  console.log('\n=== 1. O teste do guia: e-mail de vendas, três perguntas ===');
  escreverCredenciais(CHAVE_BOA);
  const r = await jev.teste();
  console.log(`      modelo ${r.modelo} · ${r.ms} ms · US$ ${r.custoUSD.toFixed(8)}`);
  conferir('respondeu', r.ok);
  conferir(
    'mandou exatamente as 3 perguntas',
    Object.keys(capturado.body.questions).join(',') === 'forca_do_lead,tipo,resposta_pessoal',
    Object.keys(capturado.body.questions).join(',')
  );
  conferir('state foi string', typeof capturado.body.state === 'string');
  conferir('model = jev-latest', capturado.body.model === 'jev-latest');
  conferir('rota correta', `${capturado.metodo} ${capturado.url}` === 'POST /v1/systemone');
  conferir('custo bate com a tabela (478 tok)', Math.abs(r.custoUSD - 478 * 0.042 / 1e6) < 1e-12);
  console.log(`      lead: ${r.respostas.forca_do_lead.rotulo} (${r.respostas.forca_do_lead.valor})`);
  console.log(`      tipo: ${r.respostas.tipo.valor}`);
  console.log(`      resposta pessoal: ${r.respostas.resposta_pessoal.probabilidade}`);

  console.log('\n=== 2. As três formas de resposta são lidas corretamente ===');
  conferir('nota numérica', r.respostas.forca_do_lead.valor === 2.99);
  conferir('nota vira rótulo legível', /quente/.test(r.respostas.forca_do_lead.rotulo || ''));
  conferir('escolha', r.respostas.tipo.valor === 'lead_novo');
  conferir('probabilidade sim/não', r.respostas.resposta_pessoal.probabilidade === 0.78);

  console.log('\n=== 3. Confiança decide quem age sozinho ===');
  conferir('escolha 0,93 passa em 0,60', jev.confiavel(r.bruto.tipo, 0.6) === true);
  conferir('escolha 0,93 NÃO passa em 0,99', jev.confiavel(r.bruto.tipo, 0.99) === false);
  conferir('sim/não 0,78 passa em 0,60', jev.confiavel(r.bruto.resposta_pessoal, 0.6) === true);
  conferir('sim/não 0,50 não passa', jev.confiavel({ type: 'noul', noul: 0.5 }, 0.6) === false);
  conferir('sim/não 0,05 passa (é um não forte)', jev.confiavel({ type: 'noul', noul: 0.05 }, 0.6) === true);

  console.log('\n=== 4. Lote grande: 100 perguntas numa chamada só ===');
  const perguntas = {};
  for (let i = 0; i < 25; i += 1) {
    perguntas[`acao_${i}`] = jev.escolha(`What should I do with \`inbox[${i}]\`?`, { a: 'x', b: 'y', c: 'z' });
    perguntas[`urg_${i}`] = jev.nota(`How urgent is \`inbox[${i}]\`?`, ['baixo', 'médio', 'alto']);
    perguntas[`escrever_${i}`] = jev.noul(`Does \`inbox[${i}]\` need a reply?`);
    perguntas[`tipo_${i}`] = jev.escolha(`What kind is \`inbox[${i}]\`?`, { p: 'p', q: 'q' });
  }
  const r2 = await jev.ask({ state: { inbox: [] }, questions: perguntas });
  conferir('100 perguntas enviadas', Object.keys(capturado.body.questions).length === 100);
  conferir('100 respostas devolvidas', Object.keys(r2.respostas).length === 100);
  conferir('acumulou o custo', jev.estatisticas().chamadas === 2);

  console.log('\n=== 5. Erros falam a língua do usuário ===');
  escreverCredenciais('chave_errada');
  try {
    await jev.teste();
    conferir('chave errada deveria falhar', false);
  } catch (e) {
    conferir('chave errada dá mensagem clara', /recusada/.test(e.message), e.message.slice(0, 60));
  }

  escreverCredenciais('');
  try {
    await jev.teste();
    conferir('sem chave deveria falhar', false);
  } catch (e) {
    conferir('sem chave explica onde guardar', /credenciais\.json/.test(e.message));
  }
  conferir('disponivel() sem chave', (await jev.disponivel()).motivo === 'sem_chave');

  console.log(
    falhas === 0
      ? '\nTudo certo: a integração com o JEV está correta.\n'
      : `\n${falhas} verificação(ões) falharam.\n`
  );
  return falhas === 0 ? 0 : 1;
}

servidor.listen(PORTA, async () => {
  let codigo = 1;
  try {
    codigo = await principal();
  } catch (err) {
    console.error('\nErro inesperado:', err);
  } finally {
    servidor.close();
    fs.rmSync(CONFIG, { recursive: true, force: true });
    process.exit(codigo);
  }
});
