from __future__ import annotations

import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Order, OrderEvent, OrderStatus
from ..schemas import (
    DemandParseIn,
    DemandParseOut,
    DispatchProposalIn,
    DispatchProposalOut,
    ExceptionHandleIn,
    ExceptionHandleOut,
    ExplainIn,
    ExplainOut,
)
from ..services.agent_logic import (
    build_dispatch_proposal,
    create_dispatch_log,
    explain_decision,
    handle_exception,
    parse_demand_text,
)
from ..services.weather_service import fetch_weather_snapshot
from ..state_machine import assert_transition, can_transition, next_statuses

router = APIRouter(prefix="/agents", tags=["agents"])


def _utcnow_naive() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _append_event(
    db: Session,
    order_id: int,
    from_status: OrderStatus,
    to_status: OrderStatus,
    event_type: str,
    payload: dict | None = None,
) -> None:
    db.add(
        OrderEvent(
            order_id=order_id,
            event_type=event_type,
            from_status=from_status.value,
            to_status=to_status.value,
            payload_json=json.dumps(payload or {}, ensure_ascii=False),
        )
    )


def _advance_order_status(
    db: Session,
    order: Order,
    to_status: OrderStatus,
    event_type: str,
    payload: dict | None = None,
) -> None:
    from_status = order.status
    try:
        assert_transition(from_status, to_status)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"错误": str(exc), "允许的下一状态": [s.value for s in next_statuses(from_status)]},
        ) from exc
    order.status = to_status
    order.updated_at = _utcnow_naive()
    _append_event(db, order.id, from_status, to_status, event_type, payload=payload)


@router.post("/demand/parse", response_model=DemandParseOut)
def parse_demand(data: DemandParseIn) -> dict:
    return parse_demand_text(data.text)


@router.post("/dispatch/propose", response_model=DispatchProposalOut)
def propose_dispatch(data: DispatchProposalIn, db: Session = Depends(get_db)) -> dict:
    order = db.get(Order, data.order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")

    weather_summary: dict = {}
    target_weather_snapshot = None
    if order.target_lng is not None and order.target_lat is not None:
        try:
            target_weather_snapshot = fetch_weather_snapshot(order.target_lng, order.target_lat, forecast_for=order.schedule_start)
            weather_summary = target_weather_snapshot["risk"]
        except Exception:
            weather_summary = {}
            target_weather_snapshot = None

    proposal = build_dispatch_proposal(
        db,
        order,
        weather_summary=weather_summary,
        target_weather_snapshot=target_weather_snapshot,
    )
    create_dispatch_log(db, order_id=order.id, payload=proposal, agent="DispatchAgent")

    if data.auto_transition:
        from_status = order.status
        if from_status == OrderStatus.ABNORMAL_PENDING:
            to_status = OrderStatus.REASSIGN_PROPOSED
        else:
            to_status = OrderStatus.DISPATCH_PROPOSED

        try:
            assert_transition(from_status, to_status)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"状态流转校验失败: {exc}") from exc

        order.status = to_status
        order.updated_at = _utcnow_naive()
        if proposal.get("selected_machine_id"):
            order.machine_id = int(proposal["selected_machine_id"])
        _append_event(db, order.id, from_status, to_status, "agent_dispatch_propose")

    db.commit()

    return {
        "order_id": order.id,
        "selected_machine_id": proposal.get("selected_machine_id"),
        "confidence": proposal.get("confidence", 0.0),
        "reason": proposal.get("reason", ""),
        "need_human_approval": proposal.get("need_human_approval", True),
        "candidates": proposal.get("candidates", []),
        "weather_summary": proposal.get("weather_summary", {}),
        "mode": proposal.get("mode", "dispatch"),
    }


@router.post("/exception/handle", response_model=ExceptionHandleOut)
def process_exception(data: ExceptionHandleIn, db: Session = Depends(get_db)) -> dict:
    order = db.get(Order, data.order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")

    result = handle_exception(db, order, data.event_type, data.description)
    proposal = result.get("proposal", {})
    create_dispatch_log(db, order_id=order.id, payload=proposal, agent="ExceptionAgent")

    if data.auto_transition:
        to_status = result["suggested_status"]
        transition_payload = {
            "event_type": result["event_type"],
            "action_type": result["action_type"],
            "replacement_machine_id": result["replacement_machine_id"],
        }

        if order.status != OrderStatus.ABNORMAL_PENDING and to_status in {OrderStatus.ABNORMAL_PENDING, OrderStatus.REASSIGN_PROPOSED}:
            if can_transition(order.status, OrderStatus.ABNORMAL_PENDING):
                _advance_order_status(
                    db,
                    order,
                    OrderStatus.ABNORMAL_PENDING,
                    "agent_exception_enter_abnormal",
                    payload=transition_payload,
                )
            elif order.status != to_status:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "错误": f"状态流转非法: {order.status.value} -> {to_status.value}",
                        "允许的下一状态": [s.value for s in next_statuses(order.status)],
                    },
                )

        if order.status != to_status:
            _advance_order_status(db, order, to_status, "agent_exception_handle", payload=transition_payload)

    db.commit()

    return {
        "order_id": order.id,
        "event_type": result["event_type"],
        "action_type": result["action_type"],
        "suggested_status": result["suggested_status"],
        "replacement_machine_id": result["replacement_machine_id"],
        "reason": result["reason"],
        "need_human_approval": result["need_human_approval"],
        "proposal": proposal,
    }


@router.post("/explain", response_model=ExplainOut)
def explain(data: ExplainIn) -> dict:
    message = explain_decision(data.decision_type, data.audience, data.payload)
    return {"说明": message}
