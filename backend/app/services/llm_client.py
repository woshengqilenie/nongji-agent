from __future__ import annotations

import json
from typing import Any, AsyncGenerator

import httpx


async def stream_openai_compatible(
    *,
    endpoint: str,
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    temperature: float = 0.2,
    max_tokens: int | None = None,
    timeout_seconds: float = 120.0,
) -> AsyncGenerator[dict[str, Any], None]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": temperature,
    }
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    timeout = httpx.Timeout(timeout_seconds, connect=min(timeout_seconds, 15.0))
    full_text = ""

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", endpoint, headers=headers, json=payload) as resp:
            if resp.status_code >= 400:
                body = await resp.aread()
                text = body.decode("utf-8", errors="ignore")
                raise RuntimeError(f"上游模型接口错误({resp.status_code}): {text}")

            async for line in resp.aiter_lines():
                if not line:
                    continue
                if not line.startswith("data:"):
                    continue

                raw = line[5:].strip()
                if raw == "[DONE]":
                    break

                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                choices = data.get("choices") or []
                if not choices:
                    continue

                delta = choices[0].get("delta") or {}
                token = delta.get("content")
                if token:
                    full_text += token
                    yield {"type": "token", "token": token}

    yield {"type": "done", "text": full_text}
