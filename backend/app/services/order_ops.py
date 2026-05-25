from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Order, OrderEvent, OrderStatus
from ..state_machine import assert_transition, next_statuses


def utcnow_naive() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def append_order_event(
    db: Session,
    order_id: int,
    event_type: str,
    to_status: OrderStatus,
    from_status: OrderStatus | None,
    operator_id: int | None = None,
    payload: dict[str, Any] | None = None,
) -> OrderEvent:
    event = OrderEvent(
        order_id=order_id,
        event_type=event_type,
        from_status=from_status.value if from_status else None,
        to_status=to_status.value,
        operator_id=operator_id,
        payload_json=json.dumps(payload or {}, ensure_ascii=False),
    )
    db.add(event)
    return event


def append_note_event(
    db: Session,
    order: Order,
    event_type: str,
    operator_id: int | None = None,
    payload: dict[str, Any] | None = None,
) -> OrderEvent:
    return append_order_event(
        db,
        order_id=order.id,
        event_type=event_type,
        from_status=order.status,
        to_status=order.status,
        operator_id=operator_id,
        payload=payload,
    )


def transition_order(
    db: Session,
    order: Order,
    to_status: OrderStatus,
    operator_id: int | None = None,
    event_type: str = "status_transition",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from_status = order.status
    if from_status == to_status:
        return {"order_id": order.id, "from_status": from_status, "to_status": to_status, "changed": False}

    try:
        assert_transition(from_status, to_status)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"错误": str(exc), "允许的下一状态": [s.value for s in next_statuses(from_status)]},
        ) from exc

    payload = payload or {}
    if to_status in {OrderStatus.DISPATCH_CONFIRMED, OrderStatus.REASSIGN_CONFIRMED} and payload.get("machine_id"):
        order.machine_id = int(payload["machine_id"])

    order.status = to_status
    order.updated_at = utcnow_naive()
    append_order_event(
        db,
        order_id=order.id,
        event_type=event_type,
        from_status=from_status,
        to_status=to_status,
        operator_id=operator_id,
        payload=payload,
    )
    db.commit()
    return {"order_id": order.id, "from_status": from_status, "to_status": to_status, "changed": True}
