# Nexus descriptive-TTS server — Qwen3-TTS (VoiceDesign)
# ======================================================
# Wraps Qwen3-TTS so the bot can speak with a free-form STYLE DESCRIPTION
# ("soft, romantic, whispering"). Use the *VoiceDesign* variant — that's the one
# that turns a text description into the voice.
#
# Contract the bot uses (set NEXUS_TTS_LOCAL_URL to this endpoint):
#   POST /  { "text": "...", "description": "soft, romantic, whispering", "voice": "..." }
#   ->  returns WAV audio bytes
#
# --- Install (on your RTX 4060 machine) ---
#   pip install fastapi uvicorn soundfile torch
#   git clone https://github.com/QwenLM/Qwen3-TTS && cd Qwen3-TTS && pip install -e .
#   huggingface-cli download Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign \
#       --local-dir models/Qwen3-TTS-VoiceDesign
#   # (a 0.6B VoiceDesign variant, if published, is lighter — check the repo)
#
# --- Run ---
#   python server.py       # listens on :8020
#
# --- Bot .env ---
#   NEXUS_TTS_LOCAL_URL=http://host.docker.internal:8020/     (bot on same machine)
#   NEXUS_TTS_LOCAL_URL=http://<4060-tailscale-ip>:8020/      (bot on the HP laptop)
#
# NOTE: Qwen3-TTS is very new — confirm the exact class name and generate() args
# against the repo's README (github.com/QwenLM/Qwen3-TTS). The two lines marked
# CHECK below are the only ones you may need to adjust; the HTTP contract is done.

import io
import os
import torch
import numpy as np
import soundfile as sf
from fastapi import FastAPI, Response
from pydantic import BaseModel

LANGUAGE = os.environ.get("TTS_LANGUAGE", "English")

MODEL_DIR = os.environ.get("MODEL_DIR", "models/Qwen3-TTS-VoiceDesign")
# Run on CPU by default so it doesn't fight qwen3:8b for GPU VRAM. Set
# DEVICE=cuda:0 if you have spare VRAM and want it faster.
DEVICE = os.environ.get("DEVICE", "cpu")
DTYPE = torch.bfloat16 if DEVICE.startswith("cuda") else torch.float32

# CHECK #1 — load the model once at startup (confirm class/import in the README):
from qwen_tts import Qwen3TTSModel  # noqa: E402

model = Qwen3TTSModel.from_pretrained(MODEL_DIR, device_map=DEVICE, dtype=DTYPE)

app = FastAPI()


class Req(BaseModel):
    text: str
    description: str = "natural, warm and friendly"
    voice: str = "default"


@app.post("/")
def tts(req: Req):
    # VoiceDesign: `instruct` = the voice description, `text` = what's spoken.
    audio, sr = model.generate_voice_design(text=req.text, language=LANGUAGE, instruct=req.description)
    # Normalise to a 1-D numpy array for soundfile.
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    audio = np.asarray(audio, dtype="float32").squeeze()
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")


@app.get("/health")
def health():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8020)
