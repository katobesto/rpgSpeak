#!/usr/bin/env python3
"""
rpgSpeak TTS Service — Piper TTS
FastAPI server wrapping Piper TTS for fast, local Spanish speech synthesis.

Supports two synthesis backends:
  • Python library (piper-tts)  — Mac / x86_64 Linux
  • Standalone binary (piper)   — ARM64 Linux (no wheels for piper-phonemize)

Usage:
  ./start.sh                          # recommended
  python tts_server.py --port 8020 --data-dir ../data
"""

from __future__ import annotations  # permite dict[x,y], tuple[x,y] en Python 3.8

import argparse
import asyncio
import io
import logging
import os
import platform
import re
import shutil
import subprocess
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
_SHARED_DEFAULT = Path.home() / ".local" / "share" / "piper-voices"
if args.models_dir:
    MODELS_DIR = Path(args.models_dir)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
elif _SHARED_DEFAULT.exists():
    MODELS_DIR = _SHARED_DEFAULT
else:
    MODELS_DIR = VOICES_DIR

logger.info("Models dir: %s", MODELS_DIR)

# ─── Piper binary (ARM64 Linux fallback) ─────────────────────────────────────

# Location where we install the Piper standalone binary
PIPER_BIN_DIR  = DATA_DIR / "tts" / "piper"
PIPER_BINARY   = PIPER_BIN_DIR / "piper"

# Piper binary releases — map (system, machine) → download URL
_PIPER_RELEASES = {
    ("Linux",  "aarch64"): "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz",
    ("Linux",  "x86_64"):  "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz",
    ("Darwin", "arm64"):   "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_macos_aarch64.tar.gz",
    ("Darwin", "x86_64"):  "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_macos_x86_64.tar.gz",
}

def _detect_piper_binary() -> Optional[Path]:
    """Return path to piper binary if available, else None."""
    # 1. Already installed in our data dir
    if PIPER_BINARY.exists():
        return PIPER_BINARY
    # 2. In PATH
    found = shutil.which("piper")
    if found:
        return Path(found)
    return None

def _install_piper_binary() -> Path:
    """Download and install the Piper binary for the current platform."""
    import tarfile, tempfile
    system  = platform.system()   # "Linux" | "Darwin"
    machine = platform.machine()  # "aarch64" | "x86_64" | "arm64"
    # macOS M-series reports "arm64" not "aarch64"
    if machine == "arm64":
        machine = "aarch64"
    url = _PIPER_RELEASES.get((system, machine))
    if not url:
        raise RuntimeError(f"No Piper binary available for {system}/{machine}")

    logger.info("Downloading Piper binary for %s/%s …", system, machine)
    PIPER_BIN_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
        import urllib.request
        urllib.request.urlretrieve(url, tmp.name)
        with tarfile.open(tmp.name, "r:gz") as tar:
            # Piper archives contain a "piper/" directory with the binary + libs
            tar.extractall(PIPER_BIN_DIR.parent)
    Path(tmp.name).unlink(missing_ok=True)

    piper_bin = PIPER_BIN_DIR / "piper"
    if not piper_bin.exists():
        raise RuntimeError(f"Piper binary not found after extraction at {piper_bin}")
    piper_bin.chmod(0o755)
    logger.info("✓ Piper binary installed at %s", piper_bin)
    return piper_bin

# Try importing the Python library; fall back to binary on ARM64
_USE_BINARY = False
try:
    from piper.voice import PiperVoice    # type: ignore
    from piper.config import SynthesisConfig  # type: ignore
    logger.info("Using piper-tts Python library for synthesis")
except ImportError:
    _USE_BINARY = True
    logger.info("piper-tts Python library not available — will use binary")

# ─── App ─────────────────────────────────────────────────────────────────────

app = FastAPI(title="rpgSpeak TTS Service", version="2.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Voice catalog ───────────────────────────────────────────────────────────

HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"

VOICE_CATALOG = [
    # ── Argentina ──────────────────────────────────────────────────────────────
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
        "id":          "es_catala",
        "name":        "Catala",
        "gender":      "female",
        "description": "Voz femenina, acento argentino (calidad media)",
        "model_id":    "es_AR-catala-medium",
        "speaker_id":  None,
        "path_prefix": "es/es_AR/catala/medium",
    },
    # ── España ─────────────────────────────────────────────────────────────────
    {
        "id":          "es_sofia",
        "name":        "Sofía",
        "gender":      "female",
        "description": "Voz femenina clara y natural (España)",
        "model_id":    "es_ES-sharvard-medium",
        "speaker_id":  1,           # sharvard: M=0, F=1
        "path_prefix": "es/es_ES/sharvard/medium",
    },
    {
        "id":          "es_carlos",
        "name":        "Carlos",
        "gender":      "male",
        "description": "Voz masculina narrativa, acento español",
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
        "id":          "es_carlfm",
        "name":        "Carl",
        "gender":      "male",
        "description": "Voz masculina compacta (España, calidad básica, muy rápida)",
        "model_id":    "es_ES-carlfm-x_low",
        "speaker_id":  None,
        "path_prefix": "es/es_ES/carlfm/x_low",
    },
    # ── México ─────────────────────────────────────────────────────────────────
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
        "id":          "es_claude_mx",
        "name":        "Claude MX",
        "gender":      "male",
        "description": "Voz masculina, acento mexicano (alta calidad)",
        "model_id":    "es_MX-claude-high",
        "speaker_id":  None,
        "path_prefix": "es/es_MX/claude/high",
    },
]

VOICE_MAP = {v["id"]: v for v in VOICE_CATALOG}

# ─── Model loading — lazy dict cache ─────────────────────────────────────────

_loaded_models: dict[str, object] = {}  # model_id → PiperVoice (Python backend)


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
    """Fix models whose config stores enum reprs instead of plain strings."""
    try:
        src = json_path.read_text(encoding="utf-8")
        if "PhonemeType." not in src:
            return
        fixed = src.replace("PhonemeType.ESPEAK", "espeak").replace("PhonemeType.TEXT", "text")
        json_path.write_text(fixed, encoding="utf-8")
        logger.info("Patched phoneme_type enum in %s", json_path.name)
    except Exception as exc:
        logger.warning("Could not patch %s: %s", json_path.name, exc)


# ─── Synthesis backends ───────────────────────────────────────────────────────

def _synth_python(text: str, model_id: str, voice_meta: dict,
                  speed: float, temperature: float) -> bytes:
    """Synthesize using the piper-tts Python library (x86_64 / macOS)."""
    if model_id not in _loaded_models:
        onnx_path, json_path = _model_paths(model_id)
        _patch_model_config(json_path)
        logger.info("Loading Piper model: %s", model_id)
        voice_obj = PiperVoice.load(str(onnx_path), config_path=str(json_path), use_cuda=False)
        _loaded_models[model_id] = voice_obj
        logger.info("✓ Model loaded: %s", model_id)

    voice_obj = _loaded_models[model_id]
    syn_config = SynthesisConfig(
        speaker_id    = voice_meta.get("speaker_id"),
        length_scale  = 1.0 / speed,
        noise_scale   = temperature,
        noise_w_scale = 0.8,
    )

    chunks = list(voice_obj.synthesize(text, syn_config))
    if not chunks:
        return b""
    sr = chunks[0].sample_rate
    sw = chunks[0].sample_width
    sc = chunks[0].sample_channels
    pcm = b"".join(c.audio_int16_bytes for c in chunks)
    wav_io = io.BytesIO()
    with wave.open(wav_io, "wb") as wf:
        wf.setnchannels(sc)
        wf.setsampwidth(sw)
        wf.setframerate(sr)
        wf.writeframes(pcm)
    return wav_io.getvalue()


def _normalize_for_binary(text: str) -> str:
    """Piper binary emits one WAV block per input line.
    Multiple lines → multiple concatenated WAV headers → browser decodes only the first.
    Solution: collapse paragraph breaks to '. ' and remaining newlines to ' ',
    so the whole text becomes a single line → single WAV output."""
    # Paragraph break → period + space (adds a natural pause)
    text = re.sub(r"\n{2,}", ". ", text)
    # Single newline → space
    text = text.replace("\n", " ")
    # Collapse whitespace runs
    text = re.sub(r"  +", " ", text)
    # Remove duplicate period-spaces
    text = re.sub(r"\.\s*\.\s*", ". ", text)
    return text.strip()


def _synth_binary(text: str, model_id: str, voice_meta: dict,
                  speed: float, temperature: float) -> bytes:
    """Synthesize using the Piper standalone binary (ARM64 Linux)."""
    binary = _detect_piper_binary()
    if binary is None:
        logger.info("Piper binary not found — installing…")
        binary = _install_piper_binary()

    onnx_path, json_path = _model_paths(model_id)
    _patch_model_config(json_path)

    # Flatten to single line so Piper emits exactly one WAV block
    normalized = _normalize_for_binary(text)
    logger.debug("Normalized text (%d chars → %d chars)", len(text), len(normalized))

    cmd = [
        str(binary),
        "--model",        str(onnx_path),
        "--config",       str(json_path),
        "--output_file",  "-",
        "--length_scale", str(round(1.0 / speed, 3)),
        "--noise_scale",  str(round(temperature, 3)),
        "--noise_w",      "0.8",
    ]
    speaker_id = voice_meta.get("speaker_id")
    if speaker_id is not None:
        cmd += ["--speaker", str(speaker_id)]

    env = os.environ.copy()
    env["LD_LIBRARY_PATH"] = str(PIPER_BIN_DIR) + ":" + env.get("LD_LIBRARY_PATH", "")

    result = subprocess.run(
        cmd,
        input=normalized.encode("utf-8"),
        capture_output=True,
        timeout=120,
        env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Piper binary failed: {result.stderr.decode(errors='replace')}")
    return result.stdout


async def _ensure_model(voice: dict) -> None:
    """Download model files if not present."""
    if not _model_available(voice["model_id"]):
        logger.info("Model files missing for %s — downloading…", voice["model_id"])
        await _download_model(voice["model_id"], voice["path_prefix"])


# ─── Request models ───────────────────────────────────────────────────────────

class SynthesizeRequest(BaseModel):
    text:        str   = Field(..., min_length=1, max_length=12000)
    voice_id:    str   = Field(default="es_daniela")
    speed:       float = Field(default=1.0, ge=0.5, le=3.0)
    temperature: float = Field(default=0.667, ge=0.0, le=1.0)


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/voices")
async def list_voices():
    voices = []
    for v in VOICE_CATALOG:
        voices.append({
            "id":          v["id"],
            "name":        v["name"],
            "gender":      v["gender"],
            "description": v["description"],
            "available":   _model_available(v["model_id"]),
            "type":        "builtin",
        })
    return {"success": True, "data": voices}


@app.post("/voices/{voice_id}/download")
async def download_voice(voice_id: str):
    voice = VOICE_MAP.get(voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail=f"Voz '{voice_id}' no encontrada")
    try:
        await _download_model(voice["model_id"], voice["path_prefix"])
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"Error al descargar modelo: {exc}") from exc

    onnx_path, _ = _model_paths(voice["model_id"])
    return {"success": True, "size": onnx_path.stat().st_size}


@app.get("/health")
async def health():
    return {"status": "ok", "engine": "piper-binary" if _USE_BINARY else "piper-python"}


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest):
    voice = VOICE_MAP.get(req.voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail=f"Voz '{req.voice_id}' no encontrada")

    text = clean_text(req.text)
    if not text:
        raise HTTPException(status_code=400, detail="El texto está vacío después de limpiar")

    logger.info("Synthesizing | voice=%s | speed=%.1f | chars=%d | backend=%s",
                req.voice_id, req.speed, len(text), "binary" if _USE_BINARY else "python")

    try:
        await _ensure_model(voice)
    except Exception as exc:
        logger.error("Failed to load/download model: %s", exc)
        raise HTTPException(status_code=500, detail=f"Error al cargar modelo TTS: {exc}") from exc

    synth_fn = _synth_binary if _USE_BINARY else _synth_python

    loop = asyncio.get_event_loop()
    try:
        wav_bytes = await loop.run_in_executor(
            None, synth_fn, text, voice["model_id"], voice, req.speed, req.temperature
        )
    except Exception as exc:
        logger.error("Synthesis error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Error en síntesis: {exc}") from exc

    logger.info("✓ Synthesized %d bytes WAV", len(wav_bytes))

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"Content-Disposition": 'attachment; filename="speech.wav"'},
    )


# ─── Text preprocessing ───────────────────────────────────────────────────────

_MD_PATTERNS = [
    (re.compile(r"```[\s\S]*?```"),         ""),    # fenced code blocks
    (re.compile(r"`[^`]+`"),                ""),    # inline code
    (re.compile(r"\*\*([^*]+)\*\*"),        r"\1"), # bold → plain
    (re.compile(r"\*([^*]+)\*"),            r"\1"), # italic → plain
    (re.compile(r"_([^_]+)_"),              r"\1"), # underscore italic → plain
    (re.compile(r"^#{1,6}\s+", re.M),      ""),    # markdown headings
    (re.compile(r"\[([^\]]+)\]\([^)]+\)"),  r"\1"), # links → text
    (re.compile(r"^[-*+]\s+", re.M),       ""),    # unordered list markers
    (re.compile(r"^\d+\.\s+", re.M),       ""),    # ordered list markers
    # Horizontal rules: ONLY when the whole line is dashes/underscores/asterisks.
    # Anchored to full lines to avoid eating narrative em-dashes like "—" or "---".
    (re.compile(r"^[\s]*[-_*]{3,}[\s]*$", re.M), ""),
    # Stage directions: parentheticals at the START of a paragraph line.
    # e.g. "(Aria frunce el ceño)" at beginning of line, but NOT "(risas)" inside a sentence.
    (re.compile(r"^\s*\([^)]{1,300}\)\s*", re.M), ""),
]


def clean_text(text: str) -> str:
    for pattern, repl in _MD_PATTERNS:
        text = pattern.sub(repl, text)
    # Collapse runs of blank lines to one
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    logger.info("rpgSpeak TTS Service (Piper) starting on port %d | backend=%s",
                args.port, "binary" if _USE_BINARY else "python")
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")
