from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Machine, MachineStatus, Order, ServiceSKU
from ..services.portal_views import build_order_card, build_owner_rankings, build_service_card

router = APIRouter(prefix="/market", tags=["market"])


@router.get("/home")
def market_home(db: Session = Depends(get_db)) -> dict:
    skus = db.query(ServiceSKU).filter(ServiceSKU.is_active == 1).order_by(ServiceSKU.id.asc()).all()
    machines = db.query(Machine).all()
    orders = db.query(Order).all()
    categories_counter = Counter(sku.work_type for sku in skus)
    service_cards = [build_service_card(db, sku) for sku in skus]
    featured_services = sorted(
        service_cards,
        key=lambda item: (-float(item["completion_rate"]), -float(item["owner_rating"]), item["title"]),
    )[:8]

    active_machine_count = sum(1 for machine in machines if machine.status != MachineStatus.offline)
    return {
        "categories": [
            {"key": key, "label": key, "count": count}
            for key, count in sorted(categories_counter.items(), key=lambda item: item[0])
        ],
        "featured_services": featured_services,
        "highlights": [
            {"label": "可派单机具", "value": active_machine_count, "desc": "平台当前可调度农机"},
            {"label": "在线服务SKU", "value": len(skus), "desc": "覆盖收割、播种、耕整、植保"},
            {"label": "历史订单", "value": len(orders), "desc": "支持派单、改派、验收闭环"},
        ],
        "top_owners": build_owner_rankings(db)[:5],
    }


@router.get("/services")
def list_services(work_type: str | None = None, db: Session = Depends(get_db)) -> list[dict]:
    query = db.query(ServiceSKU).filter(ServiceSKU.is_active == 1)
    if work_type:
        query = query.filter(ServiceSKU.work_type == work_type)
    skus = query.order_by(ServiceSKU.id.asc()).all()
    return [build_service_card(db, sku) for sku in skus]


@router.get("/orders")
def list_market_orders(buyer_id: int, db: Session = Depends(get_db)) -> list[dict]:
    orders = db.query(Order).filter(Order.buyer_id == buyer_id).order_by(Order.id.desc()).all()
    return [build_order_card(db, order) for order in orders]


@router.get("/orders/{order_id}/tracking")
def market_order_tracking(order_id: int, db: Session = Depends(get_db)) -> dict:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    return build_order_card(db, order)
