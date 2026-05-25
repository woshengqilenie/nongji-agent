from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Order, OrderEvent, OrderStatus, ServiceSKU, User, UserRole
from ..schemas import OrderCreateIn, OrderOut, TransitionIn, TransitionOut
from ..services.order_ops import append_order_event, transition_order as perform_transition_order

router = APIRouter(prefix="/orders", tags=["orders"])


@router.post("", response_model=OrderOut)
def create_order(data: OrderCreateIn, db: Session = Depends(get_db)) -> Order:
    buyer = db.get(User, data.buyer_id)
    if not buyer:
        raise HTTPException(status_code=404, detail="未找到需求方用户")
    if buyer.role != UserRole.buyer:
        raise HTTPException(status_code=400, detail="下单用户必须是需求方角色")

    sku = db.get(ServiceSKU, data.sku_id)
    if not sku:
        raise HTTPException(status_code=404, detail="未找到服务SKU")

    order_no = f"OD{datetime.now(UTC).strftime('%Y%m%d%H%M%S%f')[:-3]}"
    amount = round(data.area_mu * sku.unit_price, 2)

    order = Order(
        order_no=order_no,
        buyer_id=data.buyer_id,
        sku_id=data.sku_id,
        machine_id=None,
        area_mu=data.area_mu,
        amount=amount,
        status=OrderStatus.CREATED,
        urgency_level=data.urgency_level,
        quality_constraints=data.quality_constraints,
        schedule_start=data.schedule_start,
        schedule_end=data.schedule_end,
        target_lng=data.target_lng,
        target_lat=data.target_lat,
    )
    db.add(order)
    db.flush()

    append_order_event(
        db,
        order_id=order.id,
        event_type="create_order",
        to_status=OrderStatus.CREATED,
        from_status=None,
        payload={"amount": amount},
    )

    db.commit()
    db.refresh(order)
    return order


@router.get("", response_model=list[OrderOut])
def list_orders(
    limit: int = 50,
    buyer_id: int | None = None,
    status: OrderStatus | None = None,
    db: Session = Depends(get_db),
) -> list[Order]:
    limit = min(max(limit, 1), 500)
    query = db.query(Order)
    if buyer_id:
        query = query.filter(Order.buyer_id == buyer_id)
    if status:
        query = query.filter(Order.status == status)
    return query.order_by(Order.id.desc()).limit(limit).all()


@router.get("/{order_id}", response_model=OrderOut)
def get_order(order_id: int, db: Session = Depends(get_db)) -> Order:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    return order


@router.get("/{order_id}/events")
def get_order_events(order_id: int, db: Session = Depends(get_db)) -> list[dict]:
    events = (
        db.query(OrderEvent)
        .filter(OrderEvent.order_id == order_id)
        .order_by(OrderEvent.created_at.asc(), OrderEvent.id.asc())
        .all()
    )
    return [
        {
            "id": e.id,
            "event_type": e.event_type,
            "from_status": e.from_status,
            "to_status": e.to_status,
            "operator_id": e.operator_id,
            "payload": e.payload_json,
            "created_at": e.created_at.isoformat(),
        }
        for e in events
    ]


@router.post("/{order_id}/transition", response_model=TransitionOut)
def transition_order(order_id: int, data: TransitionIn, db: Session = Depends(get_db)) -> TransitionOut:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    return TransitionOut(
        **perform_transition_order(
            db,
            order,
            to_status=data.to_status,
            operator_id=data.operator_id,
            event_type="status_transition",
            payload={"note": data.note, **(data.payload or {})},
        )
    )


@router.post("/{order_id}/pay", response_model=TransitionOut)
def pay_order(order_id: int, operator_id: int | None = None, db: Session = Depends(get_db)) -> TransitionOut:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    return TransitionOut(
        **perform_transition_order(db, order, OrderStatus.PAID_ESCROW, operator_id, "pay_order")
    )


@router.post("/{order_id}/start", response_model=TransitionOut)
def start_order(order_id: int, operator_id: int | None = None, db: Session = Depends(get_db)) -> TransitionOut:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    return TransitionOut(
        **perform_transition_order(db, order, OrderStatus.IN_SERVICE, operator_id, "start_service")
    )


@router.post("/{order_id}/finish", response_model=TransitionOut)
def finish_order(order_id: int, operator_id: int | None = None, db: Session = Depends(get_db)) -> TransitionOut:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    return TransitionOut(
        **perform_transition_order(db, order, OrderStatus.TO_CONFIRM, operator_id, "finish_service")
    )


@router.post("/{order_id}/confirm", response_model=TransitionOut)
def confirm_order(order_id: int, operator_id: int | None = None, db: Session = Depends(get_db)) -> TransitionOut:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    return TransitionOut(
        **perform_transition_order(db, order, OrderStatus.COMPLETED, operator_id, "confirm_service")
    )
