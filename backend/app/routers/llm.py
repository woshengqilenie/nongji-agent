from __future__ import annotations

import json
import os
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from starlette.responses import StreamingResponse

from ..services.llm_client import stream_openai_compatible

router = APIRouter(prefix="/llm", tags=["llm"])


class LLMStreamIn(BaseModel):
    endpoint: str | None = Field(default=None, description="完整接口地址，例如 http://127.0.0.1:5001/v1/chat/completions")
    api_key: str | None = Field(default=None, description="模型服务 API Key")
    model: str | None = Field(default=None, description="模型名")
    messages: list[dict[str, Any]]
    temperature: float = 0.2
    max_tokens: int | None = None
    stage: str = "通用"
    timeout_seconds: float = 120.0


@router.post("/chat/stream")
async def llm_chat_stream(data: LLMStreamIn) -> StreamingResponse:
    endpoint = (data.endpoint or os.getenv("LLM_ENDPOINT", "")).strip()
    api_key = (data.api_key or os.getenv("LLM_API_KEY", "")).strip()
    model = (data.model or os.getenv("LLM_MODEL", "deepseek-chat")).strip()

    if not endpoint:
        raise HTTPException(status_code=400, detail="未配置模型接口地址 endpoint")
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")
    if not model:
        raise HTTPException(status_code=400, detail="未配置模型名称")
    if not data.messages:
        raise HTTPException(status_code=400, detail="messages 不能为空")

    async def event_generator():
        try:
            async for event in stream_openai_compatible(
                endpoint=endpoint,
                api_key=api_key,
                model=model,
                messages=data.messages,
                temperature=data.temperature,
                max_tokens=data.max_tokens,
                timeout_seconds=data.timeout_seconds,
            ):
                if event["type"] == "token":
                    payload = {"阶段": data.stage, "增量": event["token"]}
                    yield f"event: token\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                elif event["type"] == "done":
                    payload = {"阶段": data.stage, "完成": True, "全文": event["text"]}
                    yield f"event: done\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
        except Exception as exc:  # noqa: BLE001
            payload = {"阶段": data.stage, "错误": str(exc)}
            yield f"event: error\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
