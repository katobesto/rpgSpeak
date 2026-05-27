#!/usr/bin/env python3
"""
rpgSpeak TTS Service — Piper TTS
FastAPI server wrapping Piper TTS for fast, local Spanish speech synthesis.

Usage:
  ./start.sh                          # recommended
  python tts_server.py --port 8020 --data-dir ../data
"""

import argparse
import asyncio
import io
import logging
import re
import wave
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("tts-service")

# ─── CLI Args ────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument("--port",       type=int, default=8020,   help="HTTP port")
parser.add_argument("--data-dir",   default="./data",         help="App data directory")
parser.add_argument("--models-dir", default="",               help="Piper models directory (shared across projects)")
args, _ = parser.parse_known_args()

DATA_DIR   = Path(args.data_dir)
VOICES_DIR = DATA_DIR / "tts" / "voices"
VOICES_DIR.mkdir(parents=True, exist_ok=True)

# Prefer a shared Piper models dir (reuse models from other projects).
# Priority: --models-dir flag > ~/.local/share/piper-voices > VOICES_DIR
_SHARED_DEFAULT = Path.home() / ".local" / "share" / "piper-voices"
if args.models_dir:
    MODELS_DIR = Path(args.models_dir)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
elif _SHARED_DEFAULT.exists():
    MODELS_DIR = _SHARED_DEFAULT
else:
    MODELS_DIR = VOICES_DIR

logger.info("Models dir: %s", MODELS_DIR)

# ─── App ─────────────────────────────────────────────────────────────────────

app = FastAPI(title="rpgSpeak TTS Service", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Voice catalog ───────────────────────────────────────────────────────────

HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"

VOICE_CATALOG = [
    # ── Femeninas ──────────────────────────────────────────────────────────────
    {
        "id":          "es_daniela",
        "name":        "Daniela",
        "gender":      "female",
        "description": "Voz femenina expresiva, acento argentino (alta calidad)",
        "model_id":    "es_AR-daniela-high",
        "speaker_id":  None,
        "path_prefix": "es/es_AR/daniela/high",
    },
    {
        "id":          "es_sofia",
        "name":        "Sofía",
        "gender":      "female",
        "description": "Voz femenina clara y natural (España)",
        "model_id":    "es_ES-sharvard-medium",
        "speaker_id":  1,           # sharvard: M=0, F=1
        "path_prefix": "es/es_ES/sharvard/medium",
    },
    # ── Masculinas ─────────────────────────────────────────────────────────────
    {
        "id":          "es_carlos",
        "name":        "Carlos",
        "gender":      "male",
        "description": "Voz masculina grave y narrativa (España)",
        "model_id":    "es_ES-sharvard-medium",
        "speaker_id":  0,           # sharvard: M=0, F=1
        "path_prefix": "es/es_ES/sharvard/medium",
    },
    {
        "id":          "es_david",
        "name":        "David",
        "gender":      "male",
        "description": "Voz masculina clara y expresiva (España)",
        "model_id":    "es_ES-davefx-medium",
        "speaker_id":  None,
        "path_prefix": "es/es_ES/davefx/medium",
    },
    {
        "id":          "es_laura",
        "name":        "Laura",
        "gender":      "female",
        "description": "Voz femenina cálida y expresiva, acento mexicano (alta calidad)",
        "model_id":    "es_MX-laura-high",
        "speaker_id":  None,
        "path_prefix": "es/es_MX/laura/high",
    },
    {
        "id":          "es_antonio",
        "name":        "Antonio",
        "gender":      "male",
        "description": "Voz masculina neutra y profesional (México)",
        "model_id":    "es_MX-ald-medium",
        "speaker_id":  None,
        "path_prefix": "es/es_MX/ald/medium",
    },
    {
        "id":          "es_claude",
        "name":        "Claude",
        "gender":      "male",
        "description": "Voz masculina, acento mexicano (alta calidad)",
        "model_id":    "es_MX-claude-high",
        "speaker_id":  None,
        "path_prefix": "es/es_MX/claude/high",
    },
]

VOICE_MAP = {v["id"]: v for v in VOICE_CATALOG}

# ─── Model loading — lazy dict cache ─────────────────────────────────────────
# Piper models load in <1 s, so no async complexity needed.

_loaded_models: dict[str, object] = {}  # model_id → PiperVoice


def _model_paths(model_id: str) -> tuple[Path, Path]:
    onnx_path = MODELS_DIR / f"{model_id}.onnx"
    json_path  = MODELS_DIR / f"{model_id}.onnx.json"
    return onnx_path, json_path


def _model_available(model_id: str) -> bool:
    onnx_path, json_path = _model_paths(model_id)
    return onnx_path.exists() and json_path.exists()


async def _download_model(model_id: str, path_prefix: str) -> None:
    """Download .onnx and .onnx.json for model_id if not already present."""
    onnx_path, json_path = _model_paths(model_id)

    files = [
        (f"{HF_BASE}/{path_prefix}/{model_id}.onnx",      onnx_path),
        (f"{HF_BASE}/{path_prefix}/{model_id}.onnx.json", json_path),
    ]

    async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
        for url, dest in files:
            if dest.exists():
                logger.info("Already downloaded: %s", dest.name)
                continue
            logger.info("Downloading %s → %s", url, dest)
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                dest.parent.mkdir(parents=True, exist_ok=True)
                tmp = dest.with_suffix(dest.suffix + ".tmp")
                try:
                    with tmp.open("wb") as f:
                        async for chunk in resp.aiter_bytes(chunk_size=65536):
                            f.write(chunk)
                    tmp.rename(dest)
                    logger.info("✓ Downloaded %s (%d bytes)", dest.name, dest.stat().st_size)
                except Exception:
                    tmp.unlink(missing_ok=True)
                    raise


def _patch_model_config(json_path: Path) -> None:
    """Fix models whose config stores enum reprs instead of plain strings.
    e.g. 'PhonemeType.ESPEAK' → 'espeak'  (bug in some older Piper model exports)."""
    try:
        src = json_path.read_text(encoding="utf-8")
        if "PhonemeType." not in src:
            return
        fixed = src.replace("PhonemeType.ESPEAK", "espeak").replace("PhonemeType.TEXT", "text")
        json_path.write_text(fixed, encoding="utf-8")
        logger.info("Patched phoneme_type enum in %s", json_path.name)
    except Exception as exc:
        logger.warning("Could not patch %s: %s", json_path.name, exc)


def _load_model_sync(model_id: str) -> object:
    """Load PiperVoice from disk (sync, fast <1 s). Cached after first load."""
    if model_id in _loaded_models:
        return _loaded_models[model_id]

    from piper.voice import PiperVoice  # type: ignore

    onnx_path, json_path = _model_paths(model_id)
    _patch_model_config(json_path)   # fix PhonemeType enum bug if present
    logger.info("Loading Piper model: %s", model_id)
    voice = PiperVoice.load(str(onnx_path), config_path=str(json_path), use_cuda=False)
    _loaded_models[model_id] = voice
    logger.info("✓ Model loaded: %s", model_id)
    return voice


async def _get_model(model_id: str, path_prefix: str) -> object:
    """Return a loaded PiperVoice, auto-downloading model files if missing."""
    if not _model_available(model_id):
        logger.info("Model files missing for %s — downloading…", model_id)
        await _download_model(model_id, path_prefix)

    loop = asyncio.get_event_loop()
    voice = await loop.run_in_executor(None, _load_model_sync, model_id)
    return voice


# ─── Text preprocessing ──────────────────────────────────────────────────────

_MD_PATTERNS = [
    (re.compile(r"```[\s\S]*?```"),        ""),    # fenced code
    (re.compile(r"`[^`]+`"),               ""),    # inline code
    (re.compile(r"\*\*([^*]+)\*\*"),       r"\1"), # bold
    (re.compile(r"\*([^*]+)\*"),           r"\1"), # italic
    (re.compile(r"_([^_]+)_"),             r"\1"), # underscore italic
    (re.compile(r"^#{1,6}\s+", re.M),     ""),    # headings
    (re.compile(r"\[([^\]]+)\]\([^)]+\)"), r"\1"), # links
    (re.compile(r"^[-*+]\s+", re.M),      ""),    # list markers
    (re.compile(r"^\d+\.\s+", re.M),      ""),    # numbered lists
    (re.compile(r"---+"),                  ""),    # horizontal rules
    (re.compile(r"^\s*\([^)]{1,300}\)\s*", re.M), ""),  # stage directions at line start only
]


def clean_text(text: str) -> str:
    for pattern, repl in _MD_PATTERNS:
        text = pattern.sub(repl, text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ─── Request models ──────────────────────────────────────────────────────────

class SynthesizeRequest(BaseModel):
    text:        str   = Field(..., min_length=1, max_length=5000)
    voice_id:    str   = Field(default="es_sofia")
    speed:       float = Field(default=1.0, ge=0.5, le=2.0)
    temperature: float = Field(default=0.667, ge=0.1, le=1.0)


class DownloadVoiceRequest(BaseModel):
    voice_id: str


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "engine": "piper"}


@app.get("/voices")
def list_voices():
    return [
        {**{k: v for k, v in voice.items() if k not in ("path_prefix",)},
         "available": _model_available(voice["model_id"])}
        for voice in VOICE_CATALOG
    ]


@app.post("/download-voice")
async def download_voice(req: DownloadVoiceRequest):
    voice = VOICE_MAP.get(req.voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail="Voz no encontrada")

    if _model_available(voice["model_id"]):
        return {"success": True, "message": "Modelo ya descargado"}

    try:
        await _download_model(voice["model_id"], voice["path_prefix"])
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"Error al descargar modelo: {exc}") from exc

    onnx_path, _ = _model_paths(voice["model_id"])
    return {"success": True, "size": onnx_path.stat().st_size}


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest):
    voice = VOICE_MAP.get(req.voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail=f"Voz '{req.voice_id}' no encontrada")

    text = clean_text(req.text)
    if not text:
        raise HTTPException(status_code=400, detail="El texto está vacío después de limpiar")

    logger.info("Synthesizing | voice=%s | speed=%.1f | chars=%d",
                req.voice_id, req.speed, len(text))

    try:
        piper_voice = await _get_model(voice["model_id"], voice["path_prefix"])
    except Exception as exc:
        logger.error("Failed to load/download model: %s", exc)
        raise HTTPException(status_code=500, detail=f"Error al cargar modelo TTS: {exc}") from exc

    # Map parameters — piper-tts ≥2.0 uses SynthesisConfig
    from piper.config import SynthesisConfig  # type: ignore

    syn_config = SynthesisConfig(
        speaker_id   = voice.get("speaker_id"),
        length_scale = 1.0 / req.speed,   # higher = slower
        noise_scale  = req.temperature,    # expressiveness
        noise_w_scale = 0.8,
    )

    def _synth() -> bytes:
        """Collect all AudioChunk objects and encode as WAV."""
        chunks = list(piper_voice.synthesize(text, syn_config))
        if not chunks:
            return b""
        # All chunks share same sample_rate / width / channels
        sr = chunks[0].sample_rate
        sw = chunks[0].sample_width
        sc = chunks[0].sample_channels
        # Concatenate raw int16 PCM
        pcm = b"".join(c.audio_int16_bytes for c in chunks)
        # Encode to WAV
        wav_io = io.BytesIO()
        with wave.open(wav_io, "wb") as wf:
            wf.setnchannels(sc)
            wf.setsampwidth(sw)
            wf.setframerate(sr)
            wf.writeframes(pcm)
        return wav_io.getvalue()

    loop = asyncio.get_event_loop()
    try:
        wav_bytes = await loop.run_in_executor(None, _synth)
    except Exception as exc:
        logger.error("Synthesis error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Error en síntesis: {exc}") from exc

    logger.info("✓ Synthesized %d bytes WAV", len(wav_bytes))

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"Content-Disposition": 'attachment; filename="speech.wav"'},
    )


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    logger.info("rpgSpeak TTS Service (Piper) starting on port %d", args.port)
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")
