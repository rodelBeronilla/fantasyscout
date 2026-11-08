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


def base_url(url: str | None = None) -> str:
    return (url or os.environ.get("FS_AI_URL") or DEFAULT_URL).rstrip("/")


def unavailable(
    *,
    url: str | None = None,
    model: str | None = None,
    timeout: float = 10.0,
    client: httpx.Client | None = None,
) -> str | None:
    """Why the model cannot answer now (the service is down or the model is not pulled), or
    None when it can. A job that needs the model checks this first and stands down quietly: the
    model is available only while the home server is (ADR 0017)."""
    name = model or model_name()
    owned = client is None
    http = client or httpx.Client(timeout=timeout)
    try:
        response = http.get(f"{base_url(url)}/api/tags")
        response.raise_for_status()
        pulled = {str(m.get("name")) for m in response.json().get("models") or []}
    except (httpx.HTTPError, ValueError, AttributeError) as e:
        return f"the local model's service is not reachable at {base_url(url)} ({type(e).__name__})"
    finally:
        if owned:
            http.close()
    if name not in pulled:
        return f"the model {name} is not pulled on the local model's service"
    return None


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
    base = base_url(url)
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
