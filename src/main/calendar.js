'use strict';

/**
 * Leitor da agenda do Google.
 *
 * O Google oferece, em Configurações da Agenda, um "endereço secreto no
 * formato iCal": uma URL longa e imprevisível que devolve a agenda inteira
 * em texto, sem OAuth e sem senha. Para LER a agenda é o caminho mais
 * simples que existe — e é só o que o Nino precisa para o resumo do dia.
 *
 * (Para escrever eventos seria preciso CalDAV com OAuth, que é bem mais
 * trabalhoso. Escrever na agenda não está no escopo por enquanto.)
 *
 * O formato iCalendar é texto puro: cada evento é um bloco BEGIN:VEVENT...
 * END:VEVENT com linhas "CHAVE;PARAM=VALOR:conteúdo".
 */

const https = require('https');
const http = require('http');

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/**
 * Fuso usado quando o evento não diz o seu. Sem isso, um compromisso às
 * 22h de Brasília apareceria no dia seguinte, porque 22h BRT já é o dia
 * seguinte em UTC.
 */
const FUSO_PADRAO = process.env.NINO_FUSO || 'America/Sao_Paulo';

/* ------------------------------------------------------------------ */
/* Busca                                                               */
/* ------------------------------------------------------------------ */

function baixar(url, redirecionamentos = 4) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(
      url,
      { headers: { 'User-Agent': 'Nino/1.0 (agenda local)' }, timeout: 25000 },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirecionamentos > 0
        ) {
          res.resume();
          const proxima = new URL(res.headers.location, url).toString();
          resolve(baixar(proxima, redirecionamentos - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(
              `A agenda respondeu ${res.statusCode}. Confira se o endereço secreto do iCal está completo.`
            )
          );
          return;
        }
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
      }
    );
    req.on('timeout', () => req.destroy(new Error('A agenda demorou demais para responder.')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Leitura do formato iCalendar                                        */
/* ------------------------------------------------------------------ */

/**
 * O iCalendar quebra linhas longas em 75 caracteres e continua na linha
 * seguinte começando com um espaço. Desfazer isso é o primeiro passo
 * obrigatório de qualquer leitura.
 */
function desdobrar(texto) {
  return texto
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

/** "CHAVE;PARAM=VALOR:conteúdo" -> {chave, params, valor} */
function analisarLinha(linha) {
  const corte = linha.indexOf(':');
  if (corte < 0) return null;
  const esquerda = linha.slice(0, corte);
  const valor = linha.slice(corte + 1);
  const [chave, ...resto] = esquerda.split(';');
  const params = {};
  for (const pedaco of resto) {
    const [k, v] = pedaco.split('=');
    if (k) params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, '');
  }
  return { chave: chave.toUpperCase(), params, valor };
}

/** Desfaz os escapes do iCalendar (\, \; \n \\). */
function desescapar(valor) {
  return String(valor || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * Converte a hora de parede de um fuso (ex.: America/Sao_Paulo) no instante
 * correto. O truque: descobrir o deslocamento do fuso naquele momento
 * perguntando ao próprio Intl, sem depender de biblioteca de datas.
 */
function horaNoFuso(ano, mes, dia, hora, minuto, segundo, fuso) {
  const palpite = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: fuso,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    // Duas passadas cobrem a virada de horário de verão.
    let instante = palpite;
    for (let i = 0; i < 2; i += 1) {
      const p = {};
      for (const parte of fmt.formatToParts(new Date(instante))) {
        p[parte.type] = parte.value;
      }
      const comoUtc = Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour) % 24,
        Number(p.minute),
        Number(p.second)
      );
      instante = palpite - (comoUtc - instante);
    }
    return new Date(instante);
  } catch {
    // Fuso desconhecido: trata como UTC, que é o padrão do formato.
    return new Date(palpite);
  }
}

/** Lê uma data/hora iCalendar em objeto Date. */
function lerData(analisada) {
  if (!analisada) return null;
  const v = analisada.valor;
  const soData = analisada.params.VALUE === 'DATE' || /^\d{8}$/.test(v);
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, a, mes, d, h = '0', mi = '0', s = '0', z] = m;
  const ano = Number(a);
  const numMes = Number(mes);
  const dia = Number(d);

  if (soData) {
    return { data: new Date(Date.UTC(ano, numMes - 1, dia)), diaInteiro: true, fuso: null };
  }
  if (z) {
    return {
      data: new Date(Date.UTC(ano, numMes - 1, dia, Number(h), Number(mi), Number(s))),
      diaInteiro: false,
      fuso: 'UTC',
    };
  }
  const fuso = analisada.params.TZID || FUSO_PADRAO;
  return {
    data: horaNoFuso(ano, numMes, dia, Number(h), Number(mi), Number(s), fuso),
    diaInteiro: false,
    fuso,
  };
}

/**
 * Dia a que o evento pertence, como "2026-09-25", calculado no fuso do
 * próprio evento. Sem isso, um evento de dia inteiro (que é uma data
 * flutuante, sem hora) escorrega para o dia anterior ao ser lido como
 * instante UTC — foi exatamente o que aconteceu no primeiro teste.
 */
function chaveDoDia(quando, diaInteiro, fuso) {
  if (diaInteiro) {
    // Data flutuante: os componentes UTC são a data original do arquivo.
    return `${quando.getUTCFullYear()}-${String(quando.getUTCMonth() + 1).padStart(2, '0')}-${String(
      quando.getUTCDate()
    ).padStart(2, '0')}`;
  }
  try {
    const p = {};
    for (const parte of new Intl.DateTimeFormat('en-US', {
      timeZone: fuso || FUSO_PADRAO,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(quando)) {
      p[parte.type] = parte.value;
    }
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    return `${quando.getFullYear()}-${String(quando.getMonth() + 1).padStart(2, '0')}-${String(
      quando.getDate()
    ).padStart(2, '0')}`;
  }
}

/** Rótulo curto do dia, ex.: "sex 25/09". */
function formatarDia(chave) {
  const [a, m, d] = chave.split('-').map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return `${DIAS_SEMANA[dia]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

/** Extrai todos os VEVENT de um texto iCalendar. */
function extrairEventos(texto) {
  const linhas = desdobrar(texto);
  const eventos = [];
  let atual = null;
  for (const linha of linhas) {
    const c = linha.trim();
    if (c === 'BEGIN:VEVENT') {
      atual = {};
      continue;
    }
    if (c === 'END:VEVENT') {
      if (atual) eventos.push(atual);
      atual = null;
      continue;
    }
    if (!atual) continue;
    const p = analisarLinha(linha);
    if (!p) continue;
    atual[p.chave] = p; // guarda com parâmetros, ex.: DTSTART;TZID=...
  }
  return eventos;
}

/* ------------------------------------------------------------------ */
/* Repetição (RRULE)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Expande repetições simples dentro da janela pedida. Reuniões semanais e
 * diárias cobrem a esmagadora maioria dos compromissos; regras exóticas
 * aparecem só na primeira ocorrência, o que é suficiente para um resumo.
 */
function expandir(inicio, regra, janelaFim, max = 30) {
  const ocorrencias = [];
  if (!inicio) return ocorrencias;
  const r = {};
  for (const pedaco of String(regra).split(';')) {
    const [k, v] = pedaco.split('=');
    if (k) r[k.toUpperCase()] = v;
  }
  const freq = (r.FREQ || '').toUpperCase();
  const intervalo = Math.max(1, Number(r.INTERVAL) || 1);
  const total = r.COUNT ? Number(r.COUNT) : Infinity;
  const ate = r.UNTIL ? lerData({ valor: r.UNTIL, params: {} })?.data : null;

  const porDia = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  let proximo = new Date(inicio.getTime());

  // Sem BYDAY, a repetição semanal cai no mesmo dia da semana do início.
  const diasAlvo =
    freq === 'WEEKLY' && r.BYDAY
      ? r.BYDAY.split(',').map((d) => porDia[d.trim().toUpperCase()]).filter((n) => n !== undefined)
      : null;

  for (let n = 0; n < total && ocorrencias.length < max && proximo <= janelaFim; n += 1) {
    if (ate && proximo > ate) break;
    if (proximo >= inicio) ocorrencias.push(new Date(proximo.getTime()));

    if (freq === 'DAILY') {
      proximo = new Date(proximo.getTime() + intervalo * 86400000);
    } else if (freq === 'WEEKLY' && diasAlvo) {
      // Avança até o próximo dia da semana marcado.
      let candidato = new Date(proximo.getTime() + 86400000);
      let guarda = 0;
      while (!diasAlvo.includes(candidato.getUTCDay()) && guarda < 14) {
        candidato = new Date(candidato.getTime() + 86400000);
        guarda += 1;
      }
      proximo = candidato;
      // Pula as semanas intermediárias quando INTERVAL > 1.
      if (intervalo > 1 && candidato.getUTCDay() === diasAlvo[0]) {
        proximo = new Date(proximo.getTime() + (intervalo - 1) * 7 * 86400000);
      }
    } else if (freq === 'WEEKLY') {
      proximo = new Date(proximo.getTime() + intervalo * 7 * 86400000);
    } else if (freq === 'MONTHLY') {
      const d = new Date(proximo.getTime());
      d.setUTCMonth(d.getUTCMonth() + intervalo);
      proximo = d;
    } else if (freq === 'YEARLY') {
      const d = new Date(proximo.getTime());
      d.setUTCFullYear(d.getUTCFullYear() + intervalo);
      proximo = d;
    } else {
      break; // regra não suportada: fica só a primeira ocorrência
    }
  }
  return ocorrencias;
}

/* ------------------------------------------------------------------ */
/* Montagem do resultado                                               */
/* ------------------------------------------------------------------ */

function formatarHora(data, diaInteiro, fuso) {
  if (diaInteiro) return 'dia inteiro';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: fuso || undefined,
    }).format(data);
  } catch {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(data);
  }
}

/**
 * Busca e organiza os eventos dos próximos dias.
 * Devolve {ok, eventos, porDia, de, ate}.
 */
async function buscar({ url, dias = 7, max = 60, agora = new Date() } = {}) {
  if (!url) return { ok: false, erro: 'Sem endereço de agenda configurado.' };

  let texto;
  try {
    texto = await baixar(url);
  } catch (err) {
    return { ok: false, erro: err.message };
  }

  const inicio = new Date(agora.getTime());
  const fim = new Date(agora.getTime() + dias * 86400000);
  // Uma margem para trás: compromissos de hoje que já começaram ainda
  // interessam a quem pede "o que eu tenho hoje?".
  const limitePassado = new Date(agora.getTime() - 6 * 3600000);

  const eventos = [];
  for (const bruto of extrairEventos(texto)) {
    const ini = lerData(bruto.DTSTART);
    if (!ini) continue;
    const fimEvento = lerData(bruto.DTEND);
    const duracao =
      fimEvento && !ini.diaInteiro ? fimEvento.data.getTime() - ini.data.getTime() : 0;

    const ocorrencias =
      bruto.RRULE && String(bruto.RRULE.valor).trim()
        ? expandir(ini.data, bruto.RRULE.valor, fim)
        : [ini.data];

    for (const quando of ocorrencias) {
      if (quando < limitePassado || quando > fim) continue;
      const termina = duracao ? new Date(quando.getTime() + duracao) : null;
      const convidados = [];
      for (const chave of Object.keys(bruto)) {
        if (chave === 'ATTENDEE') {
          const analisada = bruto[chave];
          // O nome vem no parâmetro CN; o valor é o endereço mailto:.
          const nome = analisada.params.CN;
          const email = String(analisada.valor || '').replace(/^mailto:/i, '');
          convidados.push(nome || email);
        }
      }
      const chaveDia = chaveDoDia(quando, ini.diaInteiro, ini.fuso);
      eventos.push({
        inicio: quando.toISOString(),
        fim: termina ? termina.toISOString() : null,
        chaveDia,
        hora: formatarHora(quando, ini.diaInteiro, ini.fuso),
        horaFim: termina && !ini.diaInteiro ? formatarHora(termina, false, ini.fuso) : '',
        titulo: desescapar(bruto.SUMMARY && bruto.SUMMARY.valor).replace(/\s+/g, ' ') || '(sem título)',
        local: desescapar(bruto.LOCATION && bruto.LOCATION.valor),
        descricao: desescapar(bruto.DESCRIPTION && bruto.DESCRIPTION.valor).slice(0, 500),
        organizador: desescapar(bruto.ORGANIZER && bruto.ORGANIZER.valor).replace(
          /^mailto:/i,
          ''
        ),
        convidados: convidados.slice(0, 12),
        diaInteiro: Boolean(ini.diaInteiro),
        repete: Boolean(bruto.RRULE && String(bruto.RRULE.valor).trim()),
      });
    }
  }

  // Ordena por dia e, dentro do dia, por horário. Eventos de dia inteiro
  // vêm primeiro, como na maioria das agendas.
  eventos.sort((a, b) => {
    if (a.chaveDia !== b.chaveDia) return a.chaveDia.localeCompare(b.chaveDia);
    if (a.diaInteiro !== b.diaInteiro) return a.diaInteiro ? -1 : 1;
    return a.inicio.localeCompare(b.inicio);
  });
  const recortados = eventos.slice(0, max);

  // Agrupa por dia para o resumo ficar legível.
  const porDia = {};
  for (const ev of recortados) {
    if (!porDia[ev.chaveDia]) {
      porDia[ev.chaveDia] = {
        chave: ev.chaveDia,
        rotulo: formatarDia(ev.chaveDia),
        eventos: [],
      };
    }
    porDia[ev.chaveDia].eventos.push(ev);
  }

  return {
    ok: true,
    eventos: recortados,
    porDia: Object.values(porDia).sort((a, b) => a.chave.localeCompare(b.chave)),
    dias,
    total: recortados.length,
  };
}

module.exports = { buscar, extrairEventos, lerData, horaNoFuso, DIAS_SEMANA };
