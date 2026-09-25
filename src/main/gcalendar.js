'use strict';

/**
 * Agenda pela API REST do Google Calendar (OAuth).
 *
 * Devolve o mesmo formato do leitor de iCalendar (calendar.js), então a
 * triagem e a interface não mudam. A vantagem sobre o endereço secreto do
 * iCal: repetições, convidados e fusos já vêm resolvidos pelo Google, sem
 * precisar interpretar RRULE à mão.
 */

const google = require('./google');

const BASE = 'https://www.googleapis.com/calendar/v3';
const FUSO_PADRAO = process.env.NINO_FUSO || 'America/Sao_Paulo';
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** Estados que significam "não vou". */
const RECUSADOS = new Set(['declined']);

async function buscar({ dias = 7, max = 60, agora = new Date() } = {}) {
  if (!google.conectado()) {
    return {
      ok: false,
      erro: 'Ainda não há autorização do Google. Clique em "Conectar com o Google".',
      codigo: 'SEM_CONEXAO',
    };
  }

  const inicio = new Date(agora.getTime() - 6 * 3600000); // inclui o que já começou
  const fim = new Date(agora.getTime() + dias * 86400000);

  const params = new URLSearchParams({
    timeMin: inicio.toISOString(),
    timeMax: fim.toISOString(),
    singleEvents: 'true', // o Google já expande as repetições para nós
    orderBy: 'startTime',
    maxResults: String(Math.min(100, max * 2)),
  });

  try {
    const token = await google.token();
    const r = await google.apiGet(
      `${BASE}/calendars/primary/events?${params.toString()}`,
      token
    );
    if (r.status !== 200 || !r.json) {
      return { ok: false, erro: google.explicarErro(r.json, r.texto, r.status) };
    }

    const eventos = [];
    for (const item of r.json.items || []) {
      if (item.status === 'cancelled') continue;
      // Eventos recusados não interessam ao resumo do dia.
      const meu = (item.attendees || []).find((a) => a.self);
      if (meu && RECUSADOS.has(meu.responseStatus)) continue;

      const diaInteiro = Boolean(item.start && item.start.date);
      const quando = diaInteiro
        ? new Date(`${item.start.date}T00:00:00Z`)
        : new Date(item.start.dateTime || item.start.date);

      const fimEvento =
        item.end && (item.end.dateTime || item.end.date)
          ? new Date(item.end.dateTime || `${item.end.date}T00:00:00Z`)
          : null;

      const chaveDia = diaInteiro
        ? item.start.date
        : chaveNoFuso(quando, item.start.timeZone || FUSO_PADRAO);

      eventos.push({
        inicio: quando.toISOString(),
        fim: fimEvento ? fimEvento.toISOString() : null,
        chaveDia,
        hora: diaInteiro ? 'dia inteiro' : horaNoFuso(quando, item.start.timeZone || FUSO_PADRAO),
        horaFim:
          fimEvento && !diaInteiro
            ? horaNoFuso(fimEvento, item.end.timeZone || item.start.timeZone || FUSO_PADRAO)
            : '',
        titulo: item.summary || '(sem título)',
        local: item.location || '',
        descricao: String(item.description || '').slice(0, 500),
        organizador: (item.organizer && (item.organizer.displayName || item.organizer.email)) || '',
        convidados: (item.attendees || [])
          .filter((a) => !a.self)
          .map((a) => a.displayName || a.email)
          .slice(0, 12),
        diaInteiro,
        repete: Boolean(item.recurringEventId),
        link: item.htmlLink || '',
      });
    }

    eventos.sort((a, b) => {
      if (a.chaveDia !== b.chaveDia) return a.chaveDia.localeCompare(b.chaveDia);
      if (a.diaInteiro !== b.diaInteiro) return a.diaInteiro ? -1 : 1;
      return a.inicio.localeCompare(b.inicio);
    });
    const recortados = eventos.slice(0, max);

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
      origem: 'google-calendar-api',
      eventos: recortados,
      porDia: Object.values(porDia).sort((a, b) => a.chave.localeCompare(b.chave)),
      dias,
      total: recortados.length,
    };
  } catch (err) {
    return {
      ok: false,
      erro:
        err.message === 'SEM_CONEXAO'
          ? 'Ainda não há autorização do Google. Clique em "Conectar com o Google".'
          : err.message,
    };
  }
}

function chaveNoFuso(quando, fuso) {
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
    return quando.toISOString().slice(0, 10);
  }
}

function horaNoFuso(quando, fuso) {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: fuso || FUSO_PADRAO,
    }).format(quando);
  } catch {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(quando);
  }
}

function formatarDia(chave) {
  const [a, m, d] = chave.split('-').map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return `${DIAS_SEMANA[dia]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

/** Lista as agendas da conta, para uso futuro. */
async function listarCalendarios() {
  try {
    const token = await google.token();
    const r = await google.apiGet(`${BASE}/users/me/calendarList`, token);
    if (r.status !== 200 || !r.json) {
      return { ok: false, erro: google.explicarErro(r.json, r.texto, r.status) };
    }
    return {
      ok: true,
      agendas: (r.json.items || []).map((c) => ({
        id: c.id,
        nome: c.summary,
        principal: Boolean(c.primary),
      })),
    };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

module.exports = { buscar, listarCalendarios, chaveNoFuso, horaNoFuso };
