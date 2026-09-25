#!/usr/bin/env python3
"""
Leitor e remetente de e-mail do Nino, via IMAP e SMTP do próprio Python.

Por que Python e não uma biblioteca Node: imaplib, smtplib e email fazem
parte da biblioteca padrão e já vêm resolvendo os casos chatos do mundo
real (acentuação, MIME, anexos, multipart) há décadas. Nada para instalar.

Uso:  echo '<json>' | python3 mailbox.py <comando>

Comandos:
  ping     testa login IMAP
  pastas   lista as pastas da conta
  listar   cabeçalhos das mensagens mais recentes (não marca como lido)
  ler      corpo de uma mensagem
  enviar   manda uma resposta

A senha chega pelo stdin, nunca por argumento de linha de comando: assim
ela não aparece na lista de processos do sistema.
"""

import email
import email.utils
import imaplib
import json
import os
import re
import smtplib
import socket
import sys
import traceback
from email.header import decode_header, make_header
from email.message import EmailMessage

IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
TIMEOUT = 30

# Candidatos de nome de pasta, em português e inglês.
PASTA_ENVIADOS = ["[Gmail]/Sent Mail", "[Gmail]/E-mails enviados", "[Gmail]/Sent"]
PASTA_LIXEIRA = ["[Gmail]/Trash", "[Gmail]/Lixeira", "[Gmail]/Bin"]

LIMITE_CORPO = 12000  # corta e-mails gigantes antes de qualquer coisa


def emitir(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def texto_do_cabecalho(valor):
    """Decodifica cabeçalhos tipo =?UTF-8?Q?...?= para texto legível."""
    if not valor:
        return ""
    try:
        return str(make_header(decode_header(valor)))
    except Exception:
        return str(valor)


def limpar_citacao(texto):
    """
    Tira a parte citada da resposta anterior. Num e-mail de 200 linhas, as
    primeiras importam e o resto é histórico — e tudo isso contaria tokens.
    """
    linhas = []
    for linha in texto.splitlines():
        crua = linha.strip()
        if crua.startswith(">"):
            continue
        if re.match(r"^Em .{5,80}escreveu:", crua):
            break
        if re.match(r"^On .{5,80}wrote:", crua):
            break
        if re.match(r"^-{2,}\s*(Mensagem original|Original Message)", crua, re.I):
            break
        if re.match(r"^(De|From|Enviado|Sent):\s", crua) and len(linhas) > 3:
            break
        linhas.append(linha)
    return "\n".join(linhas).strip()


def corpo_texto(msg):
    """Extrai o texto puro de uma mensagem, seja simples, multipart ou HTML."""
    if msg.is_multipart():
        for parte in msg.walk():
            if parte.get_content_type() == "text/plain":
                if "attachment" in str(parte.get("Content-Disposition") or ""):
                    continue
                return decodificar_parte(parte)
        for parte in msg.walk():
            if parte.get_content_type() == "text/html":
                if "attachment" in str(parte.get("Content-Disposition") or ""):
                    continue
                return html_para_texto(decodificar_parte(parte))
        return ""
    if msg.get_content_type() == "text/html":
        return html_para_texto(decodificar_parte(msg))
    return decodificar_parte(msg)


def decodificar_parte(parte):
    try:
        bruto = parte.get_payload(decode=True)
    except Exception:
        return ""
    if bruto is None:
        return ""
    charset = parte.get_content_charset() or "utf-8"
    for tentativa in (charset, "utf-8", "latin-1"):
        try:
            return bruto.decode(tentativa, errors="strict")
        except (UnicodeDecodeError, LookupError):
            continue
    return bruto.decode("utf-8", errors="replace")


def html_para_texto(html):
    """Conversão crua de HTML para texto. Sem dependências: só o suficiente."""
    html = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>", "\n", html)
    html = re.sub(r"(?i)</(p|div|tr|li|h[1-6])>", "\n", html)
    html = re.sub(r"<[^>]+>", " ", html)
    html = (
        html.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    html = re.sub(r"[ \t]{2,}", " ", html)
    html = re.sub(r"\n{3,}", "\n\n", html)
    return html.strip()


def texto_seguro(msg):
    texto = limpar_citacao(corpo_texto(msg))
    return texto[:LIMITE_CORPO]


def conectar_imap(cfg):
    caixa = imaplib.IMAP4_SSL(cfg.get("imapHost") or IMAP_HOST, int(cfg.get("imapPort") or IMAP_PORT))
    caixa.socket().settimeout(TIMEOUT)
    caixa.login(cfg["email"], cfg["senha"])
    return caixa


def escolher_pasta(caixa, candidatos, padrao):
    disponiveis = []
    try:
        tip, dados = caixa.list()
        if tip == "OK":
            for linha in dados or []:
                if not linha:
                    continue
                texto = linha.decode("utf-8", errors="replace")
                m = re.search(r'"/" "?([^"]+)"?$', texto) or re.search(r" ([^ ]+)$", texto)
                if m:
                    disponiveis.append(m.group(1))
    except Exception:
        pass
    for nome in candidatos:
        if nome in disponiveis:
            return nome
    return padrao


def cmd_ping(cfg):
    caixa = conectar_imap(cfg)
    caixa.select("INBOX", readonly=True)
    caixa.logout()
    return {"ok": True, "email": cfg["email"]}


def cmd_pastas(cfg):
    caixa = conectar_imap(cfg)
    tip, dados = caixa.list()
    pastas = []
    for linha in dados or []:
        if not linha:
            continue
        texto = linha.decode("utf-8", errors="replace")
        m = re.search(r'"/" "?([^"]+)"?$', texto) or re.search(r" ([^ ]+)$", texto)
        if m:
            pastas.append(m.group(1))
    caixa.logout()
    return {"ok": True, "pastas": pastas}


def cmd_listar(cfg):
    """
    Cabeçalhos das mensagens mais recentes. Usa BODY.PEEK para NÃO marcar
    como lido — ler a caixa de entrada do usuário não pode alterar nada.
    """
    pasta = cfg.get("pasta") or "INBOX"
    limite = int(cfg.get("limite") or 20)
    somente_nao_lidos = bool(cfg.get("somenteNaoLidos"))

    caixa = conectar_imap(cfg)
    caixa.select(pasta, readonly=True)
    criterio = "(UNSEEN)" if somente_nao_lidos else "ALL"
    tip, dados = caixa.uid("search", None, criterio)
    if tip != "OK":
        caixa.logout()
        return {"ok": False, "erro": f"busca falhou: {tip}"}

    uids = (dados[0] or b"").split()
    uids = uids[-limite:]  # os mais recentes
    uids.reverse()  # mais novo primeiro

    mensagens = []
    for uid in uids:
        pedido = "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] FLAGS)"
        tip, partes = caixa.uid("fetch", uid, pedido)
        if tip != "OK" or not partes:
            continue
        bruto = b""
        flags = ""
        for parte in partes:
            if isinstance(parte, tuple):
                bruto += parte[1]
                if len(parte) > 2 and parte[2]:
                    flags = parte[2].decode("utf-8", errors="replace")
            elif isinstance(parte, bytes):
                flags += parte.decode("utf-8", errors="replace")
        msg = email.message_from_bytes(bruto)
        nome, endereco = email.utils.parseaddr(texto_do_cabecalho(msg.get("From")))
        mensagens.append(
            {
                "uid": uid.decode(),
                "de": endereco,
                "nomeDe": nome or endereco,
                "assunto": texto_do_cabecalho(msg.get("Subject")) or "(sem assunto)",
                "data": texto_do_cabecalho(msg.get("Date")),
                "messageId": (msg.get("Message-ID") or "").strip(),
                "naoLido": "\\Seen" not in flags,
            }
        )
    caixa.logout()
    return {"ok": True, "pasta": pasta, "mensagens": mensagens}


def cmd_ler(cfg):
    pasta = cfg.get("pasta") or "INBOX"
    uid = str(cfg.get("uid") or "")
    if not uid:
        return {"ok": False, "erro": "uid não informado"}
    caixa = conectar_imap(cfg)
    caixa.select(pasta, readonly=True)
    tip, partes = caixa.uid("fetch", uid, "(BODY.PEEK[])")
    if tip != "OK" or not partes:
        caixa.logout()
        return {"ok": False, "erro": "mensagem não encontrada"}
    bruto = b""
    for parte in partes:
        if isinstance(parte, tuple):
            bruto += parte[1]
    msg = email.message_from_bytes(bruto)
    nome, endereco = email.utils.parseaddr(texto_do_cabecalho(msg.get("From")))
    anexos = []
    if msg.is_multipart():
        for parte in msg.walk():
            if "attachment" in str(parte.get("Content-Disposition") or ""):
                anexos.append(texto_do_cabecalho(parte.get_filename()) or "anexo")
    caixa.logout()
    return {
        "ok": True,
        "mensagem": {
            "uid": uid,
            "de": endereco,
            "nomeDe": nome or endereco,
            "para": texto_do_cabecalho(msg.get("To")),
            "assunto": texto_do_cabecalho(msg.get("Subject")) or "(sem assunto)",
            "data": texto_do_cabecalho(msg.get("Date")),
            "messageId": (msg.get("Message-ID") or "").strip(),
            "referencias": (msg.get("References") or "").strip(),
            "texto": texto_seguro(msg),
            "anexos": anexos,
        },
    }


def cmd_enviar(cfg):
    """Envia uma resposta. Só é chamado depois do usuário aprovar o texto."""
    para = cfg.get("para")
    assunto = cfg.get("assunto") or "(sem assunto)"
    texto = cfg.get("texto") or ""
    if not para or not texto.strip():
        return {"ok": False, "erro": "destinatário ou texto vazio"}

    msg = EmailMessage()
    msg["From"] = cfg["email"]
    msg["To"] = para
    msg["Subject"] = assunto
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain=cfg["email"].split("@")[-1])
    # Amarrar na conversa original faz a resposta aparecer encadeada no
    # cliente de quem recebe, em vez de virar um e-mail solto.
    if cfg.get("respostaA"):
        msg["In-Reply-To"] = cfg["respostaA"]
    if cfg.get("referencias"):
        msg["References"] = cfg["referencias"]
    elif cfg.get("respostaA"):
        msg["References"] = cfg["respostaA"]
    msg.set_content(texto)

    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=TIMEOUT) as servidor:
        servidor.login(cfg["email"], cfg["senha"])
        servidor.send_message(msg)
    return {"ok": True, "messageId": msg["Message-ID"], "para": para}


COMANDOS = {
    "ping": cmd_ping,
    "pastas": cmd_pastas,
    "listar": cmd_listar,
    "ler": cmd_ler,
    "enviar": cmd_enviar,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMANDOS:
        emitir({"ok": False, "erro": f"comando inválido: {' '.join(sys.argv[1:])}"})
        return 2
    try:
        cfg = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        emitir({"ok": False, "erro": f"entrada inválida: {exc}"})
        return 2
    if not cfg.get("email") or not cfg.get("senha"):
        emitir({"ok": False, "erro": "faltam e-mail ou senha de app"})
        return 2

    try:
        emitir(COMANDOS[sys.argv[1]](cfg))
        return 0
    except imaplib.IMAP4.error as exc:
        # O Gmail devolve erros de login que assustam; traduzimos os comuns.
        detalhe = str(exc)
        if "AUTHENTICATIONFAILED" in detalhe or "Invalid credentials" in detalhe:
            detalhe = (
                "O Gmail recusou o login. Use uma SENHA DE APP (não a sua senha "
                "normal): myaccount.google.com/apppasswords — e confirme que a "
                "verificação em duas etapas está ligada."
            )
        emitir({"ok": False, "erro": detalhe})
        return 1
    except smtplib.SMTPAuthenticationError:
        emitir(
            {
                "ok": False,
                "erro": "O Gmail recusou o envio. Confira a senha de app e se ela tem permissão de envio.",
            }
        )
        return 1
    except (socket.timeout, TimeoutError):
        emitir({"ok": False, "erro": "A conexão com o Gmail expirou. Confira a internet."})
        return 1
    except Exception:
        # Detalhe técnico só quando o usuário pedir (NINO_DEBUG=1); na tela
        # um traceback cru não ajuda ninguém.
        if os.environ.get("NINO_DEBUG"):
            emitir({"ok": False, "erro": traceback.format_exc(limit=3)})
        else:
            emitir(
                {
                    "ok": False,
                    "erro": "Não consegui falar com o Gmail. Confira a internet e os "
                    "dados da conta. (Rode com NINO_DEBUG=1 para ver o detalhe técnico.)",
                    "detalhe": traceback.format_exc(limit=1).strip().splitlines()[-1],
                }
            )
        return 1


if __name__ == "__main__":
    sys.exit(main())
