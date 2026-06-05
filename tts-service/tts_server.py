#!/usr/bin/env python3
"""
rpgSpeak TTS Service — Edge TTS (cloud, neural, gratuito)
FastAPI server usando Microsoft Edge TTS para síntesis de voz.

Las voces Piper locales han sido retiradas para simplificar el despliegue
y reducir el tamaño de la carpeta data. Solo se usan voces neurales de
Microsoft Edge TTS (requieren conexión a internet, sin API key).

Usage:
  python tts_server.py --port 8020
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("tts-service")

# ─── CLI Args ────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8020, help="HTTP port")
parser.add_argument("--data-dir", default="./data", help="App data directory (unused, kept para compatibilidad)")
args, _ = parser.parse_known_args()

# ─── App ─────────────────────────────────────────────────────────────────────

app = FastAPI(title="rpgSpeak TTS Service", version="3.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Voice catalog — solo voces neurales Edge TTS ────────────────────────────

VOICE_CATALOG = [
    # ══ ESPAÑA ════════════════════════════════════════════════════════════════
    {
        "id":           "edge_elvira",
        "name":         "Elvira",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina, acento español (Microsoft)",
        "edge_voice_id": "es-ES-ElviraNeural",
    },
    {
        "id":           "edge_irene",
        "name":         "Irene",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina cálida, acento español (Microsoft)",
        "edge_voice_id": "es-ES-IreneNeural",
    },
    {
        "id":           "edge_triana",
        "name":         "Triana",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina expresiva, acento español (Microsoft)",
        "edge_voice_id": "es-ES-TrianaNeural",
    },
    {
        "id":           "edge_abril",
        "name":         "Abril",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina amigable, acento español (Microsoft)",
        "edge_voice_id": "es-ES-AbrilNeural",
    },
    {
        "id":           "edge_estrella",
        "name":         "Estrella",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina positiva, acento español (Microsoft)",
        "edge_voice_id": "es-ES-EstrellaNeural",
    },
    {
        "id":           "edge_laia",
        "name":         "Laia",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina cálida, acento español (Microsoft)",
        "edge_voice_id": "es-ES-LaiaNeural",
    },
    {
        "id":           "edge_vera",
        "name":         "Vera",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina clara, acento español (Microsoft)",
        "edge_voice_id": "es-ES-VeraNeural",
    },
    {
        "id":           "edge_ximena",
        "name":         "Ximena",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina multilingüe, acento español (Microsoft)",
        "edge_voice_id": "es-ES-XimenaMultilingualNeural",
    },
    {
        "id":           "edge_arabella",
        "name":         "Arabella",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina multilingüe expresiva, acento español (Microsoft)",
        "edge_voice_id": "es-ES-ArabellaMultilingualNeural",
    },
    {
        "id":           "edge_isidora",
        "name":         "Isidora",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina multilingüe serena, acento español (Microsoft)",
        "edge_voice_id": "es-ES-IsidoraMultilingualNeural",
    },
    {
        "id":           "edge_alvaro",
        "name":         "Álvaro",
        "gender":       "male",
        "type":         "cloud",
        "description":  "Voz neural masculina, acento español (Microsoft)",
        "edge_voice_id": "es-ES-AlvaroNeural",
    },
    {
        "id":           "edge_saul",
        "name":         "Saúl",
        "gender":       "male",
        "type":         "cloud",
        "description":  "Voz neural masculina natural, acento español (Microsoft)",
        "edge_voice_id": "es-ES-SaulNeural",
    },
    # ══ MÉXICO ════════════════════════════════════════════════════════════════
    {
        "id":           "edge_dalia",
        "name":         "Dalia",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina, acento mexicano (Microsoft)",
        "edge_voice_id": "es-MX-DaliaNeural",
    },
    {
        "id":           "edge_candela",
        "name":         "Candela",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina expresiva, acento mexicano (Microsoft)",
        "edge_voice_id": "es-MX-CandelaNeural",
    },
    {
        "id":           "edge_jorge_mx",
        "name":         "Jorge",
        "gender":       "male",
        "type":         "cloud",
        "description":  "Voz neural masculina, acento mexicano (Microsoft)",
        "edge_voice_id": "es-MX-JorgeNeural",
    },
    # ══ ARGENTINA ════════════════════════════════════════════════════════════
    {
        "id":           "edge_elena_ar",
        "name":         "Elena AR",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina, acento argentino (Microsoft)",
        "edge_voice_id": "es-AR-ElenaNeural",
    },
    {
        "id":           "edge_tomas_ar",
        "name":         "Tomás AR",
        "gender":       "male",
        "type":         "cloud",
        "description":  "Voz neural masculina, acento argentino (Microsoft)",
        "edge_voice_id": "es-AR-TomasNeural",
    },
    # ══ COLOMBIA ═════════════════════════════════════════════════════════════
    {
        "id":           "edge_salome",
        "name":         "Salomé",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina, acento colombiano (Microsoft)",
        "edge_voice_id": "es-CO-SalomeNeural",
    },
    {
        "id":           "edge_gonzalo",
        "name":         "Gonzalo",
        "gender":       "male",
        "type":         "cloud",
        "description":  "Voz neural masculina, acento colombiano (Microsoft)",
        "edge_voice_id": "es-CO-GonzaloNeural",
    },
    # ══ ESPAÑOL AMERICANO (US) ════════════════════════════════════════════════
    {
        "id":           "edge_paloma",
        "name":         "Paloma",
        "gender":       "female",
        "type":         "cloud",
        "description":  "Voz neural femenina neutra, español americano (Microsoft)",
        "edge_voice_id": "es-US-PalomaNeural",
    },
]

VOICE_MAP = {v["id"]: v for v in VOICE_CATALOG}

# ─── Synthesis ───────────────────────────────────────────────────────────────

async def _synth_edge(text: str, voice_meta: dict, speed: float) -> bytes:
    """Synthesize using Microsoft Edge TTS (neural, cloud, free, no API key)."""
    try:
        import edge_tts  # type: ignore
    except ImportError:
        raise RuntimeError("edge-tts no está instalado. Ejecuta: pip install edge-tts")

    edge_voice = voice_meta["edge_voice_id"]

    # Convertir speed (0.5-3.0) a rate de Edge TTS ("+20%", "-30%", etc.)
    rate_pct = int(round((speed - 1.0) * 100))
    rate_str = f"+{rate_pct}%" if rate_pct >= 0 else f"{rate_pct}%"

    logger.info("Edge TTS | voice=%s | rate=%s | chars=%d", edge_voice, rate_str, len(text))

    communicate = edge_tts.Communicate(
        text=text,
        voice=edge_voice,
        rate=rate_str,
    )

    audio_chunks: list[bytes] = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_chunks.append(chunk["data"])

    if not audio_chunks:
        raise RuntimeError("Edge TTS no devolvió audio")

    return b"".join(audio_chunks)


# ─── Request models ───────────────────────────────────────────────────────────

class SynthesizeRequest(BaseModel):
    text:        str   = Field(..., min_length=1, max_length=12000)
    voice_id:    str   = Field(default="edge_elvira")
    speed:       float = Field(default=1.0, ge=0.5, le=3.0)
    temperature: float = Field(default=0.667, ge=0.0, le=1.0)


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/voices")
async def list_voices():
    return {
        "success": True,
        "data": [
            {
                "id":          v["id"],
                "name":        v["name"],
                "gender":      v["gender"],
                "description": v["description"],
                "available":   True,   # Edge TTS siempre disponible (solo requiere internet)
                "type":        "cloud",
            }
            for v in VOICE_CATALOG
        ],
    }


@app.get("/health")
async def health():
    return {"status": "ok", "engine": "edge-tts", "voices": len(VOICE_CATALOG)}


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest):
    voice = VOICE_MAP.get(req.voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail=f"Voz '{req.voice_id}' no encontrada")

    text = clean_text(req.text)
    if not text:
        raise HTTPException(status_code=400, detail="El texto está vacío después de limpiar")

    logger.info("Synthesizing | voice=%s | speed=%.1f | chars=%d", req.voice_id, req.speed, len(text))

    try:
        audio_bytes = await _synth_edge(text, voice, req.speed)
    except Exception as exc:
        logger.error("Synthesis error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Error en síntesis: {exc}") from exc

    logger.info("✓ Synthesized %d bytes (audio/mpeg)", len(audio_bytes))

    return Response(
        content=audio_bytes,
        media_type="audio/mpeg",
        headers={"Content-Disposition": 'attachment; filename="speech.mp3"'},
    )


# ─── Text preprocessing ──────────────────────────────────────────────────────

# ── Patrón de etiquetas de personaje (aplicar ANTES del resto) ───────────────
# "**Natasha:** texto"  →  "Natasha dice, texto"
_SPEAKER_PATTERNS = [
    (re.compile(r"\*\*([^*:\n]{1,50}):\*\*\s*\n?"), r"\1 dice, "),
    (re.compile(
        r"^([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{0,29}(?:\s+[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{0,29}){0,3}):\s+",
        re.M
    ), r"\1 dice, "),
]

_MD_PATTERNS = [
    (re.compile(r"```[\s\S]*?```"),         ""),
    (re.compile(r"`[^`]+`"),                ""),
    (re.compile(r"\*\*([^*]+)\*\*"),        r"\1"),
    (re.compile(r"\*([^*]+)\*"),            r"\1"),
    (re.compile(r"_([^_]+)_"),              r"\1"),
    (re.compile(r"^#{1,6}\s+", re.M),      ""),
    (re.compile(r"\[([^\]]+)\]\([^)]+\)"),  r"\1"),
    (re.compile(r"^[-*+]\s+", re.M),       ""),
    (re.compile(r"^\d+\.\s+", re.M),       ""),
    (re.compile(r"^[\s]*[-_*]{3,}[\s]*$", re.M), ""),
    (re.compile(r"^\s*\([^)]{1,300}\)\s*", re.M), ""),
]


def clean_text(text: str) -> str:
    for pattern, repl in _SPEAKER_PATTERNS:
        text = pattern.sub(repl, text)
    for pattern, repl in _MD_PATTERNS:
        text = pattern.sub(repl, text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    logger.info("rpgSpeak TTS Service (Edge TTS) starting on port %d", args.port)
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")
