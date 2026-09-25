'use strict';

/**
 * Cliente do JEV (TypeSafe AI) — o "Sistema 1" do Nino.
 *
 * O JEV não escreve nada. Você entrega um estado (texto ou dados) e perguntas
 * tipadas, e ele devolve decisões em ~0,3 s. As três formas de pergunta:
 *
 *   escolha  -> escolhe uma opção de uma lista fixa (+ confiança)
 *   nota     -> posiciona o estado numa escala ordenada (+ confiança)
 *   noul     -> probabilidade de uma afirmação ser verdadeira (0 a 1)
 *
 * Por que isso importa aqui: o modelo local deste projeto leva 27 a 180 s por
 * resposta na CPU. O JEV decide em 0,3 s o que merece a atenção do modelo
 * caro. A regra do guia — "o Jev decide, você escreve" — vira, no Nino:
 * o JEV decide, o modelo local escreve.
 *
 * O endpoint é o da própria TypeSafe (api.typesafe.ai). O guia sugere a
 * OpenRouter, mas a OpenRouter não lista nenhum modelo da TypeSafe; a rota
 * direta é a que funciona.
 */

const https = require('https');
const http = require('http');
const credentials = require('./credentials');

/**
 * Endereço da API. Configurável por variável de ambiente para permitir
 * apontar para um proxy — e para os testes rodarem contra um servidor falso,
 * sem gastar dinheiro nem exigir chave real.
 */
const URL_BASE = process.env.NINO_TYPESAFE_URL || 'https://api.typesafe.ai';
const CAMINHO = '/v1/systemone';
const MODELO_PADRAO = 'jev-latest';

// Tabela de preços do guia (21/09/2026): US$ 0,042 por 1M tokens de entrada,
// saída gratuita. Preço muda; este número é só para o contador da interface.
const USD_POR_TOKEN_ENTRADA = 0.042 / 1_000_000;

const MODELOS_CONHECIDOS = ['jev-latest', 'jev-1.13'];

let acumulado = { chamadas: 0, tokensEntrada: 0, tokensSaida: 0, custoUSD: 0 };

/* ------------------------------------------------------------------ */
/* Construtores de pergunta                                            */
/* ------------------------------------------------------------------ */

/** Escolha uma opção de uma lista. `opcoes` é {valor: descrição}. */
function escolha(instrucoes, opcoes) {
  return { type: 'choice', instructions: instrucoes, criteria: opcoes };
}

/** Posicione numa escala ordenada. `niveis` é um array, do menor ao maior. */
function nota(instrucoes, niveis) {
  return { type: 'score', instructions: instrucoes, criteria: niveis };
}

/** Probabilidade de ser verdadeiro (0 a 1). */
function noul(instrucoes, criterios) {
  const q = { type: 'noul', instructions: instrucoes };
  if (criterios) q.criteria = criterios;
  return q;
}

/* ------------------------------------------------------------------ */
/* Transporte                                                          */
/* ------------------------------------------------------------------ */

function requisitar(corpo, chave, timeoutMs) {
  return new Promise((resolve, reject) => {
    const dados = Buffer.from(JSON.stringify(corpo), 'utf8');
    const alvo = new URL(CAMINHO, URL_BASE);
    const transporte = alvo.protocol === 'http:' ? http : https;
    const req = transporte.request(
      {
        hostname: alvo.hostname,
        port: alvo.port || (alvo.protocol === 'http:' ? 80 : 443),
        path: alvo.pathname,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${chave}`,
          'Content-Type': 'application/json',
          'Content-Length': dados.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(texto);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, texto });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`a TypeSafe não respondeu em ${timeoutMs / 1000}s`));
    });
    req.on('error', reject);
    req.write(dados);
    req.end();
  });
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Traduz o corpo de erro da TypeSafe numa frase que o usuário entenda. */
function explicarErro(status, json, texto) {
  const detalhe = (json && json.detail) || {};
  const msg = detalhe.message || detalhe.error || (texto || '').slice(0, 300);
  if (status === 401 || status === 403) {
    return 'A chave da TypeSafe foi recusada. Confira se copiou a chave inteira em console.typesafe.ai/keys.';
  }
  if (status === 402) {
    return 'A conta da TypeSafe parece sem créditos. Adicione crédito em console.typesafe.ai.';
  }
  if (status === 422) {
    return `A TypeSafe recusou a pergunta (422): ${msg}`;
  }
  if (status === 429) return 'Limite de uso da TypeSafe atingido (429).';
  if (status === 529) return 'A TypeSafe está sobrecarregada (529).';
  return `Erro ${status} da TypeSafe: ${msg}`;
}

/**
 * Faz uma avaliação. `questions` é um mapa {id: pergunta} — mande TODAS as
 * perguntas que puder precisar numa chamada só: elas rodam em paralelo e
 * custam quase o mesmo.
 */
async function ask({ state, questions, model, timeoutMs = 20000, tentativas = 3 }) {
  const chave = credentials.chaveTypesafe();
  if (!chave) {
    const err = new Error(
      'Sem chave da TypeSafe. Guarde a sua em ~/.config/nino/credenciais.json (veja o painel do Nino).'
    );
    err.codigo = 'SEM_CHAVE';
    throw err;
  }
  if (!questions || !Object.keys(questions).length) {
    throw new Error('Nenhuma pergunta para o JEV.');
  }

  const corpo = { state, model: model || MODELO_PADRAO, questions };
  const inicio = Date.now();
  let ultimo;

  for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
    let r;
    try {
      r = await requisitar(corpo, chave, timeoutMs);
    } catch (err) {
      ultimo = err;
      if (tentativa === tentativas) throw err;
      await espera(400 * 2 ** (tentativa - 1));
      continue;
    }

    if (r.status === 200 && r.json) {
      const uso = r.json.usage || {};
      const custo = (uso.input_tokens || 0) * USD_POR_TOKEN_ENTRADA;
      acumulado = {
        chamadas: acumulado.chamadas + 1,
        tokensEntrada: acumulado.tokensEntrada + (uso.input_tokens || 0),
        tokensSaida: acumulado.tokensSaida + (uso.output_tokens || 0),
        custoUSD: acumulado.custoUSD + custo,
      };
      return {
        ok: true,
        modelo: r.json.model || corpo.model,
        respostas: r.json.answers || {},
        uso: {
          tokensEntrada: uso.input_tokens || 0,
          tokensSaida: uso.output_tokens || 0,
        },
        custoUSD: custo,
        ms: Date.now() - inicio,
      };
    }

    // 429 e 529 valem nova tentativa; o resto não vai melhorar sozinho.
    if ((r.status === 429 || r.status === 529) && tentativa < tentativas) {
      await espera(600 * 2 ** (tentativa - 1));
      continue;
    }
    const err = new Error(explicarErro(r.status, r.json, r.texto));
    err.codigo = `HTTP_${r.status}`;
    err.status = r.status;
    throw err;
  }

  throw ultimo || new Error('Falha ao falar com a TypeSafe.');
}

/* ------------------------------------------------------------------ */
/* Leitura das respostas                                               */
/* ------------------------------------------------------------------ */

/** Texto da escolha, ou null. */
function opcao(resposta) {
  return resposta && resposta.type === 'choice' ? resposta.choice : null;
}

/** Confiança da escolha/nota (null em noul, que não tem esse campo). */
function confianca(resposta) {
  return resposta && typeof resposta.confidence === 'number'
    ? resposta.confidence
    : null;
}

/** Nota numérica de uma pergunta de escala. */
function valor(resposta) {
  return resposta && resposta.type === 'score' ? resposta.score : null;
}

/** Probabilidade de "sim" de uma pergunta noul. */
function probabilidade(resposta) {
  return resposta && resposta.type === 'noul' ? resposta.noul : null;
}

/**
 * Decide o que fazer quando a confiança é baixa. O guia insiste nisso: o JEV
 * diz o quê, a confiança diz se dá para agir sozinho.
 */
function confiavel(resposta, minimo) {
  const c = confianca(resposta);
  if (c === null) {
    // Noul não traz campo de confiança: a incerteza está na distância até
    // 0 ou 1. A confiança de um sim/não é o pico da distribuição, ou seja
    // max(p, 1-p) — o mesmo critério que a TypeSafe usa nas escolhas, onde
    // confiança ≈ probabilidade da opção vencedora.
    const p = probabilidade(resposta);
    if (p === null) return false;
    return Math.max(p, 1 - p) >= minimo;
  }
  return c >= minimo;
}

function estatisticas() {
  return { ...acumulado };
}

function zerarEstatisticas() {
  acumulado = { chamadas: 0, tokensEntrada: 0, tokensSaida: 0, custoUSD: 0 };
  return estatisticas();
}

/**
 * Teste real, como o guia pede: um e-mail de vendas inventado e três
 * perguntas. Serve para o usuário ver o JEV funcionando, com tempo e custo.
 */
async function teste() {
  const email =
    'Oi, a gente tem uma loja de cosméticos online e quer um agente de IA ' +
    'para responder nossos e-mails de pedido. O orçamento já foi aprovado e ' +
    'queremos começar no mês que vem. Dá para marcar uma conversa esta semana?';

  const r = await ask({
    state: email,
    questions: {
      forca_do_lead: nota('Quão forte é este lead?', [
        'não é lead nenhum (spam, fornecedor, newsletter)',
        'frio: interesse vago, sem orçamento nem prazo',
        'morno: necessidade real, mas sem orçamento ou prazo',
        'quente: necessidade clara com orçamento, prazo ou decisor',
      ]),
      tipo: escolha('Que tipo de e-mail é este?', {
        lead_novo: 'um possível cliente novo',
        cliente_atual: 'cliente que já compra',
        fornecedor: 'alguém vendendo algo para nós',
        spam: 'propaganda ou golpe',
        suporte: 'pedido de ajuda com um problema',
      }),
      resposta_pessoal: noul(
        'Este e-mail precisa de uma resposta pessoal escrita por uma pessoa hoje?',
        { true: 'sim, alguém deveria responder hoje', false: 'não precisa' }
      ),
    },
  });

  const a = r.respostas;
  return {
    ok: true,
    email,
    respostas: {
      forca_do_lead: {
        valor: valor(a.forca_do_lead),
        rotulo: legenda(a.forca_do_lead),
        confianca: confianca(a.forca_do_lead),
      },
      tipo: {
        valor: opcao(a.tipo),
        confianca: confianca(a.tipo),
      },
      resposta_pessoal: { probabilidade: probabilidade(a.resposta_pessoal) },
    },
    bruto: a,
    modelo: r.modelo,
    ms: r.ms,
    custoUSD: r.custoUSD,
    uso: r.uso,
  };
}

/** Traduz a nota numérica de volta para o texto do nível escolhido. */
function legenda(resposta) {
  if (!resposta || resposta.type !== 'score' || !resposta.legend) return null;
  // A nota pode cair entre dois níveis; arredonda para o mais próximo.
  const indice = Math.round(resposta.score);
  return resposta.legend[String(indice)] || null;
}

/** Só verifica se a chave existe e se a TypeSafe aceita. */
async function disponivel() {
  if (!credentials.chaveTypesafe()) {
    return { ok: false, motivo: 'sem_chave' };
  }
  try {
    await ask({
      state: 'teste',
      questions: { ok: noul('Esta é uma verificação de conexão?') },
      timeoutMs: 12000,
      tentativas: 1,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: err.codigo || 'erro', erro: err.message };
  }
}

module.exports = {
  MODELO_PADRAO,
  MODELOS_CONHECIDOS,
  escolha,
  nota,
  noul,
  ask,
  teste,
  disponivel,
  opcao,
  valor,
  legenda,
  confianca,
  probabilidade,
  confiavel,
  estatisticas,
  zerarEstatisticas,
};
