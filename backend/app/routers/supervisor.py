from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Order, OrderStatus
from ..services.order_ops import transition_order as perform_transition_order
from ..services.portal_views import (
    build_order_card,
    build_owner_rankings,
    build_recent_event_feed,
    build_region_heat,
)

router = APIRouter(prefix="/supervisor", tags=["supervisor"])

QUEUE_KEYS = {"waiting_dispatch", "waiting_machine_response", "abnormal", "active", "history"}


class ConfirmDispatchIn(BaseModel):
    operator_id: int | None = None
    machine_id: int
    note: str = ""


class SupervisorActionIn(BaseModel):
    operator_id: int | None = None
    note: str = ""


def _queue_key(card: dict) -> str:
    status = card["status"]
    stage_key = card["stage_key"]
    if status in {"PAID_ESCROW", "DISPATCH_PROPOSED"}:
        return "waiting_dispatch"
    if status in {"DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED"} and stage_key in {"waiting_owner", "reassign_waiting_owner"}:
        return "waiting_machine_response"
    if status in {"ABNORMAL_PENDING", "REASSIGN_PROPOSED"}:
        return "abnormal"
    if status in {"IN_SERVICE", "TO_CONFIRM"} or stage_key in {"accepted", "en_route", "reassign_accepted", "reassign_en_route"}:
        return "active"
    return "history"


def _matches_status_filter(card: dict, status_filter: str) -> bool:
    normalized = status_filter.strip()
    if not normalized:
        return True

    tokens = [token.strip() for token in normalized.split(",") if token.strip()]
    for token in tokens:
        token_lower = token.lower()
        if token_lower in QUEUE_KEYS and _queue_key(card) == token_lower:
            return True
        if card["status"].upper() == token.upper():
            return True
        if card["stage_key"].lower() == token_lower:
            return True
    return False


@router.get("/overview")
def supervisor_overview(db: Session = Depends(get_db)) -> dict:
    orders = db.query(Order).order_by(Order.id.desc()).all()
    cards = [build_order_card(db, order) for order in orders]
    queues = {
        "waiting_dispatch": [],
        "waiting_machine_response": [],
        "abnormal": [],
        "active": [],
        "history": [],
    }
    for card in cards:
        queues[_queue_key(card)].append(card)

    metrics = {
        "total_orders": len(cards),
        "waiting_dispatch": len(queues["waiting_dispatch"]),
        "waiting_machine_response": len(queues["waiting_machine_response"]),
        "abnormal_orders": len(queues["abnormal"]),
        "active_orders": len(queues["active"]),
        "completed_orders": sum(1 for card in cards if card["status"] == "COMPLETED"),
    }
    metrics["completion_rate"] = round((metrics["completed_orders"] / metrics["total_orders"]) * 100, 1) if metrics["total_orders"] else 0.0

    return {
        "metrics": metrics,
        "queues": {key: value[:10] for key, value in queues.items()},
        "regions": build_region_heat(db),
        "owners": build_owner_rankings(db)[:8],
        "recent_events": build_recent_event_feed(db, limit=14),
    }


@router.get("/orders")
def supervisor_orders(status: str | None = None, db: Session = Depends(get_db)) -> list[dict]:
    orders = db.query(Order).order_by(Order.id.desc()).all()
    cards = [build_order_card(db, order) for order in orders]
    if not status:
        return cards
    return [card for card in cards if _matches_status_filter(card, status)]


@router.get("/orders/{order_id}")
def supervisor_order_detail(order_id: int, db: Session = Depends(get_db)) -> dict:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    return build_order_card(db, order)


@router.post("/orders/{order_id}/dispatch/confirm")
def supervisor_confirm_dispatch(order_id: int, data: ConfirmDispatchIn, db: Session = Depends(get_db)) -> dict:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    if order.status == OrderStatus.DISPATCH_PROPOSED:
        target_status = OrderStatus.DISPATCH_CONFIRMED
    elif order.status == OrderStatus.REASSIGN_PROPOSED:
        target_status = OrderStatus.REASSIGN_CONFIRMED
    else:
        raise HTTPException(status_code=400, detail="当前订单不在可确认派单状态")

    perform_transition_order(
        db,
        order,
        target_status,
        operator_id=data.operator_id,
        event_type="supervisor_confirm_dispatch",
        payload={
            "machine_id": data.machine_id,
            "note": data.note or "主管已确认派单结果",
        },
    )
    return build_order_card(db, order)


@router.post("/orders/{order_id}/resume")
def supervisor_resume(order_id: int, data: SupervisorActionIn, db: Session = Depends(get_db)) -> dict:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    perform_transition_order(
        db,
        order,
        OrderStatus.IN_SERVICE,
        operator_id=data.operator_id,
        event_type="supervisor_resume_service",
        payload={"note": data.note or "主管确认恢复原机继续作业"},
    )
    return build_order_card(db, order)


@router.post("/orders/{order_id}/refund")
def supervisor_refund(order_id: int, data: SupervisorActionIn, db: Session = Depends(get_db)) -> dict:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    if order.status not in {OrderStatus.ABNORMAL_PENDING, OrderStatus.DISPUTE}:
        raise HTTPException(status_code=400, detail="仅异常或争议订单可执行退款")

    perform_transition_order(
        db,
        order,
        OrderStatus.REFUNDING,
        operator_id=data.operator_id,
        event_type="supervisor_start_refund",
        payload={"note": data.note or "主管发起取消并退款"},
    )
    perform_transition_order(
        db,
        order,
        OrderStatus.REFUNDED,
        operator_id=data.operator_id,
        event_type="supervisor_finish_refund",
        payload={"note": "退款完成"},
    )
    return build_order_card(db, order)
