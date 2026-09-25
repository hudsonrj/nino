#!/usr/bin/env python3
"""
Worker de transcrição persistente (faster-whisper).

Protocolo: uma linha JSON por requisição no stdin, uma linha JSON por
resposta no stdout. Mantém o modelo carregado na memória entre chamadas.

  -> {"id": 1, "path": "/tmp/audio.wav", "language": "pt"}
  <- {"id": 1, "text": "...", "language": "pt", "duration": 3.2}

Comandos especiais:
  -> {"cmd": "ping"}   <- {"ready": true, "model": "small"}
  -> {"cmd": "exit"}   <- encerra
"""

import json
import os
import sys
import traceback


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    model_name = os.environ.get("WHISPER_MODEL", "small")
    default_language = os.environ.get("WHISPER_LANG", "pt") or None
    download_root = os.environ.get("WHISPER_CACHE") or None
    compute_type = os.environ.get("WHISPER_COMPUTE", "int8")

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover
        emit({"fatal": f"faster_whisper indisponível: {exc}"})
        return 2

    try:
        model = WhisperModel(
            model_name,
            device="cpu",
            compute_type=compute_type,
            download_root=download_root,
            cpu_threads=max(1, (os.cpu_count() or 4) - 1),
        )
    except Exception as exc:
        emit({"fatal": f"falha ao carregar o modelo '{model_name}': {exc}"})
        return 3

    emit({"ready": True, "model": model_name, "compute": compute_type})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue

        if req.get("cmd") == "exit":
            break
        if req.get("cmd") == "ping":
            emit({"ready": True, "model": model_name})
            continue

        req_id = req.get("id")
        path = req.get("path")
        if not path or not os.path.exists(path):
            emit({"id": req_id, "error": f"arquivo não encontrado: {path}"})
            continue

        try:
            segments, info = model.transcribe(
                path,
                language=req.get("language") or default_language,
                beam_size=int(req.get("beam_size", 1)),
                vad_filter=True,
                condition_on_previous_text=False,
                temperature=0.0,
            )
            text = " ".join(seg.text.strip() for seg in segments).strip()
            emit(
                {
                    "id": req_id,
                    "text": text,
                    "language": getattr(info, "language", None),
                    "duration": round(getattr(info, "duration", 0.0) or 0.0, 2),
                }
            )
        except Exception as exc:
            emit({"id": req_id, "error": f"{exc}\n{traceback.format_exc()}"})

    return 0


if __name__ == "__main__":
    sys.exit(main())
