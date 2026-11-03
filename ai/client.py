"""The local language model (ADR 0017): Ollama's chat endpoint, asked for JSON in a given shape.

The model runs beside the home runners (infra/runner/compose.yml, the ``ai`` service); a job
reaches it at ``FS_AI_URL``. ``FS_AI_MODEL`` names the model (qwen3:8b by default).
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

DEFAULT_URL = "http://ai:11434"
DEFAULT_MODEL = "qwen3:8b"


def model_name() -> str:
    return os.environ.get("FS_AI_MODEL", DEFAULT_MODEL)


def chat_json(
    system: str,
    user: str,
    schema: dict[str, Any],
    *,
    url: str | None = None,
    model: str | None = None,
    timeout: float = 300.0,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """One answer, constrained to ``schema`` (Ollama structured outputs), parsed.

    Thinking is off and the temperature low: the model rewords numbers it is given, so a steady,
    literal answer is the one wanted.
    """
    body = {
        "model": model or model_name(),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "format": schema,
        "stream": False,
        "think": False,
        "options": {"temperature": 0.2},
    }
    base = (url or os.environ.get("FS_AI_URL") or DEFAULT_URL).rstrip("/")
    owned = client is None
    http = client or httpx.Client(timeout=timeout)
    try:
        response = http.post(f"{base}/api/chat", json=body)
        response.raise_for_status()
        content = response.json()["message"]["content"]
    finally:
        if owned:
            http.close()
    parsed = json.loads(content)
    if not isinstance(parsed, dict):
        msg = "the model's answer is not a JSON object"
        raise ValueError(msg)
    return parsed
