from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Order, OrderStatus, ServiceSKU, User
from ..services.order_ops import append_note_event, transition_order as perform_transition_order
from ..services.portal_views import build_order_card

router = APIRouter(prefix="/machine", tags=["machine"])


class MachineActionIn(BaseModel):
    operator_id: int | None = None
    note: str = ""
    proposed_window: str = ""


def _resolve_owner_id(db: Session, order: Order) -> int | None:
    if order.machine_id:
        from ..models import Machine

        machine = db.get(Machine, order.machine_id)
        if machine:
            return machine.owner_id
    sku = db.get(ServiceSKU, order.sku_id)
    return sku.owner_id if sku else None


def _require_owner_order(db: Session, order_id: int, owner_id: int | None = None) -> tuple[Order, User | None]:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    if owner_id is not None and _resolve_owner_id(db, order) != owner_id:
        raise HTTPException(status_code=403, detail="当前机主无权操作该订单")
    owner = db.get(User, _resolve_owner_id(db, order)) if _resolve_owner_id(db, order) else None
    return order, owner


@router.get("/orders")
def owner_orders(owner_id: int, db: Session = Depends(get_db)) -> dict:
    orders = db.query(Order).order_by(Order.id.desc()).all()
    cards = [build_order_card(db, order) for order in orders if _resolve_owner_id(db, order) == owner_id]
    groups = {
        "pending_response": [],
        "accepted": [],
        "en_route": [],
        "in_service": [],
        "abnormal": [],
        "history": [],
    }
    for card in cards:
        status = card["status"]
        stage_key = card["stage_key"]
        if status in {"DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED"} and stage_key in {"waiting_owner", "reassign_waiting_owner"}:
            groups["pending_response"].append(card)
        elif status in {"DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED"} and stage_key in {"accepted", "reassign_accepted"}:
            groups["accepted"].append(card)
        elif status in {"DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED"} and stage_key in {"en_route", "reassign_en_route"}:
            groups["en_route"].append(card)
        elif status == "IN_SERVICE":
            groups["in_service"].append(card)
        elif status in {"ABNORMAL_PENDING", "REASSIGN_PROPOSED"}:
            groups["abnormal"].append(card)
        else:
            groups["history"].append(card)

    owner = db.get(User, owner_id)
    return {
        "owner": {
            "id": owner.id if owner else owner_id,
            "name": owner.name if owner else f"机主#{owner_id}",
            "region": owner.region if owner else "",
            "rating": owner.rating if owner else 4.5,
        },
        "metrics": {
            "pending_response": len(groups["pending_response"]),
            "accepted": len(groups["accepted"]),
            "en_route": len(groups["en_route"]),
            "in_service": len(groups["in_service"]),
            "abnormal": len(groups["abnormal"]),
            "history": len(groups["history"]),
        },
        "groups": groups,
    }


@router.post("/orders/{order_id}/accept")
def accept_order(order_id: int, data: MachineActionIn, db: Session = Depends(get_db)) -> dict:
    order, owner = _require_owner_order(db, order_id, data.operator_id)
    if order.status not in {OrderStatus.DISPATCH_CONFIRMED, OrderStatus.REASSIGN_CONFIRMED}:
        raise HTTPException(status_code=400, detail="当前订单不在待机主响应状态")
    append_note_event(
        db,
        order,
        "machine_accept",
        operator_id=data.operator_id,
        payload={"note": data.note or "机主确认接单", "owner_name": owner.name if owner else ""},
    )
    db.commit()
    return build_order_card(db, order)


@router.post("/orders/{order_id}/depart")
def depart_order(order_id: int, data: MachineActionIn, db: Session = Depends(get_db)) -> dict:
    order, owner = _require_owner_order(db, order_id, data.operator_id)
    if order.status not in {OrderStatus.DISPATCH_CONFIRMED, OrderStatus.REASSIGN_CONFIRMED}:
        raise HTTPException(status_code=400, detail="当前订单不在可出发状态")
    append_note_event(
        db,
        order,
        "machine_depart",
        operator_id=data.operator_id,
        payload={"note": data.note or "机手已出发", "owner_name": owner.name if owner else ""},
    )
    db.commit()
    return build_order_card(db, order)


@router.post("/orders/{order_id}/reject")
def reject_order(order_id: int, data: MachineActionIn, db: Session = Depends(get_db)) -> dict:
    order, owner = _require_owner_order(db, order_id, data.operator_id)
    if order.status not in {OrderStatus.DISPATCH_CONFIRMED, OrderStatus.REASSIGN_CONFIRMED}:
        raise HTTPException(status_code=400, detail="当前订单不在可拒单状态")
    target_status = OrderStatus.DISPATCH_PROPOSED if order.status == OrderStatus.DISPATCH_CONFIRMED else OrderStatus.REASSIGN_PROPOSED
    rejected_machine_id = order.machine_id
    order.machine_id = None
    perform_transition_order(
        db,
        order,
        target_status,
        operator_id=data.operator_id,
        event_type="machine_reject",
        payload={
            "note": data.note or "机主拒单，回流调度池",
            "rejected_machine_id": rejected_machine_id,
            "owner_name": owner.name if owner else "",
        },
    )
    return build_order_card(db, order)


@router.post("/orders/{order_id}/reschedule")
def reschedule_order(order_id: int, data: MachineActionIn, db: Session = Depends(get_db)) -> dict:
    order, owner = _require_owner_order(db, order_id, data.operator_id)
    if order.status not in {OrderStatus.DISPATCH_CONFIRMED, OrderStatus.REASSIGN_CONFIRMED}:
        raise HTTPException(status_code=400, detail="当前订单不在可改约状态")
    target_status = OrderStatus.DISPATCH_PROPOSED if order.status == OrderStatus.DISPATCH_CONFIRMED else OrderStatus.REASSIGN_PROPOSED
    requested_machine_id = order.machine_id
    order.machine_id = None
    perform_transition_order(
        db,
        order,
        target_status,
        operator_id=data.operator_id,
        event_type="machine_reschedule_request",
        payload={
            "note": data.note or "机主申请改约",
            "proposed_window": data.proposed_window,
            "requested_machine_id": requested_machine_id,
            "owner_name": owner.name if owner else "",
        },
    )
    return build_order_card(db, order)


@router.post("/orders/{order_id}/start")
def machine_start(order_id: int, data: MachineActionIn, db: Session = Depends(get_db)) -> dict:
    order, _owner = _require_owner_order(db, order_id, data.operator_id)
    perform_transition_order(
        db,
        order,
        OrderStatus.IN_SERVICE,
        operator_id=data.operator_id,
        event_type="start_service",
        payload={"note": data.note or "机手已到场并开始作业"},
    )
    return build_order_card(db, order)


@router.post("/orders/{order_id}/finish")
def machine_finish(order_id: int, data: MachineActionIn, db: Session = Depends(get_db)) -> dict:
    order, _owner = _require_owner_order(db, order_id, data.operator_id)
    perform_transition_order(
        db,
        order,
        OrderStatus.TO_CONFIRM,
        operator_id=data.operator_id,
        event_type="finish_service",
        payload={"note": data.note or "机手已完工，等待验收"},
    )
    return build_order_card(db, order)


@router.post("/orders/{order_id}/fault")
def report_fault(order_id: int, data: MachineActionIn, db: Session = Depends(get_db)) -> dict:
    order, owner = _require_owner_order(db, order_id, data.operator_id)
    if order.status == OrderStatus.ABNORMAL_PENDING:
        append_note_event(
            db,
            order,
            "machine_fault_report",
            operator_id=data.operator_id,
            payload={"note": data.note or "设备故障已再次上报", "owner_name": owner.name if owner else ""},
        )
        db.commit()
        return build_order_card(db, order)

    perform_transition_order(
        db,
        order,
        OrderStatus.ABNORMAL_PENDING,
        operator_id=data.operator_id,
        event_type="machine_fault_report",
        payload={"note": data.note or "设备故障，申请平台改派", "owner_name": owner.name if owner else ""},
    )
    return build_order_card(db, order)
