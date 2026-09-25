'use strict';

/**
 * Testes da detecção de intenção do mascote.
 *
 * O campo de texto tem que decidir, antes de qualquer chamada, se o pedido é
 * sobre a câmera, sobre a tela, sobre os dados do usuário (e-mail, agenda,
 * calendário) ou conversa comum. Errar aqui custa caro nos dois sentidos:
 *
 *   falso positivo  liga a câmera ou gasta o modelo local sem necessidade
 *   falso negativo  a pergunta cai no RAG e o modelo INVENTA a resposta —
 *                   foi assim que "tem acesso ao calendário?" virou uma
 *                   resposta sobre "reuniões da fábrica"
 *
 * As funções são extraídas do próprio mascot.js, para o teste não virar uma
 * cópia que envelhece em paralelo.
 *
 *   node scripts/test-intencoes.js
 */

const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, '..', 'src', 'renderer', 'mascot.js');
const fonte = fs.readFileSync(ARQUIVO, 'utf8');

/** Recorta um trecho do mascot.js e o avalia, para testar a função real. */
function extrair(de, ate, rotulo) {
  const i = fonte.indexOf(de);
  const f = fonte.indexOf(ate, i);
  if (i < 0 || f < 0) {
    console.error(`Não encontrei o trecho "${rotulo}" em mascot.js. O teste precisa de ajuste.`);
    process.exit(2);
  }
  return fonte.slice(i, f);
}

/**
 * `eval` não serve aqui: em modo estrito as declarações ficam presas ao
 * escopo do próprio eval. `new Function` devolve o que interessa.
 */
const fabrica = new Function(
  extrair('function dobrarAcentos', 'const PADROES_CAMERA', 'dobra de acentos') +
    '\n' +
    extrair('const TERMOS_DADOS', '/** Responde sobre o dia', 'detecção do dia') +
    '\n' +
    extrair('const PADROES_CAMERA', 'let visionDisponivel', 'detecção de visão') +
    '\nreturn { detectarIntencaoDeDia, detectVisionIntent, dobrarAcentos };'
);
const { detectarIntencaoDeDia, detectVisionIntent, dobrarAcentos } = fabrica();

let falhas = 0;

function bater(nome, funcao, casos) {
  console.log(`\n=== ${nome} ===`);
  let ok = 0;
  const ruins = [];
  for (const [texto, esperado] of casos) {
    const obtido = funcao(texto);
    // Normaliza: a detecção de visão devolve null em vez de false.
    const normalizado = obtido === null || obtido === undefined ? false : obtido;
    const alvo = esperado === null ? false : esperado;
    if (normalizado === alvo) ok += 1;
    else ruins.push({ texto, esperado, obtido });
  }
  console.log(`  ${ok}/${casos.length} corretos`);
  for (const r of ruins) {
    console.log(`   FALHA  "${r.texto}"`);
    console.log(`          esperado=${r.esperado}  obtido=${r.obtido}`);
  }
  falhas += ruins.length;
}

/* ------------------------------------------------------------------ */

bater('Dados do usuário: e-mail, agenda, calendário', detectarIntencaoDeDia, [
  // --- o caso que motivou o teste
  ['tem acesso ao calendario de hudsonrj@gmail.com?', true],
  ['tem acesso ao calendário?', true],
  ['você tem acesso ao meu e-mail?', true],
  // --- posse
  ['meu calendario', true],
  ['qual meu calendário?', true],
  ['minhas reuniões de amanhã', true],
  ['meus e-mails de hoje', true],
  ['minha caixa de entrada está cheia?', true],
  // --- pergunta de acesso
  ['você consegue ver minha agenda?', true],
  ['consegue acessar meu email?', true],
  ['pode olhar meu calendário?', true],
  ['está lendo meus e-mails?', true],
  // --- expressões fixas
  ['o que tenho hoje?', true],
  ['o que eu tenho amanhã?', true],
  ['tem algo na minha agenda?', true],
  ['faz um resumo do meu dia', true],
  ['resumo do dia', true],
  ['resuma meu dia', true],
  ['como está o meu dia?', true],
  ['tem algo urgente?', true],
  ['o que chegou de novo?', true],
  ['preciso responder alguém?', true],

  // --- precisam continuar de fora (senão o modelo local é acordado à toa)
  ['o que é a Agenda 2030 da ONU?', false],
  ['o que significa calendário no dicionário?', false],
  ['me explique o que é um compromisso', false],
  ['para que serve um calendário?', false],
  ['escreva um e-mail para o João', false],
  ['qual a agenda do evento?', false],
  ['resuma o livro Dom Casmurro', false],
  ['resuma o livro Dia de Cão', false],
  ['o dia está bonito hoje', false],
  ['como vai você?', false],
  ['qual é o tempo de forno do bolo?', false],
  ['quem foi Napoleão Hill?', false],
  ['preciso de um calendário de vacinação', false],
  ['o calendário juliano foi reformado em 1582', false],
]);

console.log('\n=== Dobra de acentos (a causa do bug do \\b) ===');
{
  const pares = [
    ['você vê', 'voce ve'],
    ['o que é', 'o que e'],
    ['são', 'sao'],
    ['definição', 'definicao'],
    ['calendário', 'calendario'],
    ['não', 'nao'],
  ];
  let ok = 0;
  for (const [entrada, esperado] of pares) {
    const obtido = dobrarAcentos(entrada);
    if (obtido === esperado) ok += 1;
    else console.log(`   FALHA  "${entrada}" -> "${obtido}" (esperado "${esperado}")`);
  }
  console.log(`  ${ok}/${pares.length} corretos`);
  falhas += pares.length - ok;
}

bater('Visão: câmera e tela', detectVisionIntent, [
  ['olhe para mim e diga o que você vê', 'camera'],
  ['olha pra mim', 'camera'],
  ['o que você vê?', 'camera'],
  ['como eu estou?', 'camera'],
  ['o que tem atrás de mim?', 'camera'],
  ['descreva o ambiente', 'camera'],
  ['olhe minha tela', 'screen'],
  ['veja minha tela', 'screen'],
  ['o que eu estou fazendo?', 'screen'],
  ['explica o que está acontecendo', 'screen'],
  ['me ajuda com isso aqui na tela', 'screen'],

  // --- falsos positivos que já apareceram
  ['o que é uma tela OLED?', false],
  ['a tela do meu celular quebrou', false],
  ['olha, acho que você está errado', false],
  ['quem foi Napoleão Hill?', false],
  ['me explique o que é uma câmera fotográfica', false],
  ['o que é um calendário?', false],
]);

/* ------------------------------------------------------------------ */

console.log(
  falhas === 0
    ? '\nTodas as intenções estão corretas.\n'
    : `\n${falhas} caso(s) falharam.\n`
);
process.exit(falhas === 0 ? 0 : 1);
