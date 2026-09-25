'use strict';

/**
 * Testes do caminho OAuth (API do Gmail + API do Google Agenda).
 *
 * A parte que depende do navegador não dá para automatizar, mas tudo o que é
 * lógica pura dá — e é onde os erros silenciosos moram: montagem da mensagem
 * RFC 2822, extração de texto de MIME aninhado, corte de citação e conversão
 * de fuso horário.
 *
 *   node scripts/test-google.js
 *
 * O último teste fala com o Google de verdade (uma requisição de leitura, sem
 * autenticar) para conferir se o endereço de retorno está cadastrado.
 */

const P = `${__dirname}/../src/main/`;
const gmail = require(`${P}gmail`);
const gcalendar = require(`${P}gcalendar`);
const google = require(`${P}google`);

let falhas = 0;
function conferir(rotulo, condicao, detalhe) {
  if (!condicao) falhas += 1;
  console.log(`${condicao ? '  ok  ' : ' FALHA'}  ${rotulo}${detalhe ? ` — ${detalhe}` : ''}`);
}

function secao(t) {
  console.log(`\n=== ${t} ===`);
}

/* ------------------------------------------------------------------ */

secao('1. base64url (o Gmail não aceita +, / nem =)');
const original = 'Olá, mundo! Acentuação e símbolos: +/=?';
const codificado = gmail.paraBase64Url(original);
conferir('não contém + nem /', !/[+/]/.test(codificado), codificado.slice(0, 30));
conferir('não termina com =', !codificado.endsWith('='));
conferir('volta ao original', gmail.deBase64Url(codificado) === original);

secao('2. montagem da mensagem (RFC 2822)');
const raw = gmail.montarRfc822({
  de: 'eu@gmail.com',
  para: 'ana@cliente.com',
  assunto: 'Re: Contrato',
  texto: 'Oi Ana,\n\nSegue assinado.\n\nAbraço,\nHudson',
  respostaA: '<abc@mail.gmail.com>',
  referencias: '<anterior@mail.gmail.com> <abc@mail.gmail.com>',
});
conferir('tem From', /^From: eu@gmail\.com$/m.test(raw));
conferir('tem To', /^To: ana@cliente\.com$/m.test(raw));
conferir('tem Subject', /^Subject: Re: Contrato$/m.test(raw));
conferir('amarra na conversa (In-Reply-To)', /^In-Reply-To: <abc@mail\.gmail\.com>$/m.test(raw));
conferir('mantém References', /^References: <anterior@mail\.gmail\.com> <abc@mail\.gmail\.com>$/m.test(raw));
conferir('declara UTF-8', /charset="UTF-8"/.test(raw));
conferir('usa CRLF nos cabeçalhos', raw.includes('\r\n'));
const corpo = raw.split('\r\n\r\n')[1] || '';
conferir(
  'o corpo volta legível',
  Buffer.from(corpo.replace(/\r\n/g, ''), 'base64').toString('utf8').includes('Abraço'),
  'acentuação preservada'
);
conferir(
  'sem References, usa o In-Reply-To',
  /^References: <x@y>$/m.test(
    gmail.montarRfc822({ de: 'a@b', para: 'c@d', assunto: 's', texto: 't', respostaA: '<x@y>' })
  )
);

secao('3. extração de texto de MIME aninhado');
const payload = {
  mimeType: 'multipart/alternative',
  headers: [{ name: 'Subject', value: 'Teste' }],
  parts: [
    {
      mimeType: 'multipart/related',
      parts: [
        { mimeType: 'text/html', body: { data: gmail.paraBase64Url('<p>Olá <b>mundo</b></p>') } },
      ],
    },
    { mimeType: 'text/plain', body: { data: gmail.paraBase64Url('Olá mundo\nsegunda linha') } },
    {
      mimeType: 'application/pdf',
      headers: [{ name: 'Content-Disposition', value: 'attachment; filename="doc.pdf"' }],
      body: { data: gmail.paraBase64Url('nao deve aparecer') },
    },
  ],
};
const extraido = gmail.extrairTexto(payload);
conferir('prefere text/plain ao HTML', extraido.includes('segunda linha'), JSON.stringify(extraido));
conferir('ignora anexo', !extraido.includes('nao deve aparecer'));
conferir(
  'HTML vira texto quando não há plain',
  gmail
    .extrairTexto({
      mimeType: 'text/html',
      body: { data: gmail.paraBase64Url('<div>Olá&nbsp;<b>mundo</b></div>') },
    })
    .includes('Olá mundo')
);

secao('4. corte da citação da resposta anterior');
const comCitacao = `Oi, tudo bem?

Segue o que você pediu.

Em qui, 25 de set de 2026 às 09:12, Ana <ana@x.com> escreveu:
> Preciso do contrato
> assinado hoje.`;
const limpo = gmail.limparCitacao(comCitacao);
conferir('mantém o texto novo', limpo.includes('Segue o que você pediu'));
conferir('remove a citação com >', !limpo.includes('Preciso do contrato'));
conferir('remove a linha do "Em ... escreveu"', !limpo.includes('escreveu'));
conferir(
  'trata "On ... wrote" em inglês',
  !gmail.limparCitacao('Olá\n\nOn Mon, Sep 25 2026 at 10:00, Bob <b@x> wrote:\n> oi').includes('wrote')
);

secao('5. fusos da agenda (o defeito que já mordeu uma vez)');
// 9h em São Paulo é 12h UTC. Um evento às 22h de Brasília é o dia seguinte
// em UTC — e não pode escorregar para o dia errado no agrupamento.
const noveDaManha = new Date('2026-09-26T12:00:00Z');
conferir(
  'hora local de 12:00Z é 09:00 em São Paulo',
  gcalendar.horaNoFuso(noveDaManha, 'America/Sao_Paulo') === '09:00',
  gcalendar.horaNoFuso(noveDaManha, 'America/Sao_Paulo')
);
conferir(
  'a chave do dia é 2026-09-26',
  gcalendar.chaveNoFuso(noveDaManha, 'America/Sao_Paulo') === '2026-09-26',
  gcalendar.chaveNoFuso(noveDaManha, 'America/Sao_Paulo')
);
const dezDaNoite = new Date('2026-09-27T01:00:00Z'); // 22h de 26/09 em Brasília
conferir(
  'às 22h locais, o dia ainda é o de Brasília e não o de UTC',
  gcalendar.chaveNoFuso(dezDaNoite, 'America/Sao_Paulo') === '2026-09-26',
  `${gcalendar.chaveNoFuso(dezDaNoite, 'America/Sao_Paulo')} (UTC diria ${dezDaNoite.toISOString().slice(0, 10)})`
);

secao('6. endereço de retorno do OAuth (fala com o Google)');
const candidatos = google.candidatosRedirecionamento();
conferir('tem vários candidatos para descobrir', candidatos.length >= 4, `${candidatos.length} candidatos`);
conferir(
  'inclui os dois formatos que o Google trata como diferentes',
  candidatos.includes('http://localhost:3099/') &&
    candidatos.includes('http://localhost:3099/oauth2callback'),
  'com e sem barra final'
);
conferir('a URL de autorização pede refresh token', /access_type=offline/.test(google.urlAutorizacao('x')));
conferir('força a tela de consentimento', /prompt=consent/.test(google.urlAutorizacao('x')));
conferir('pede os escopos do Gmail e da Agenda', /gmail\.readonly/.test(google.urlAutorizacao('x')));
conferir('leva o state antifalsificação', /state=x/.test(google.urlAutorizacao('x')));

(async () => {
  const d = await google.descobrirRedirecionamento();
  conferir(
    'descobre um endereço de retorno que o Google aceita',
    d.ok === true,
    d.ok ? d.uri : `${d.campo}: ${d.erro}`
  );
  if (d.ok) {
    conferir('o endereço descoberto bate com a porta de escuta', (() => {
      try { return Number(new URL(d.uri).port) === google.portaEscuta(); } catch { return false; }
    })(), `${d.uri} -> porta ${google.portaEscuta()}`);
  } else if (d.tentados) {
    console.log('\n  Endereços testados:');
    for (const t of d.tentados) console.log(`    ${t.estado.padEnd(10)} ${t.uri}`);
    if (d.comoResolver) console.log(`\n  ↳ Para resolver: ${d.comoResolver}`);
  }

  console.log(
    falhas === 0
      ? '\nTudo certo no caminho OAuth.\n'
      : `\n${falhas} verificação(ões) falharam.\n`
  );
  process.exit(falhas === 0 ? 0 : 1);
})();
