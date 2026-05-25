from __future__ import annotations

import json
from collections import defaultdict
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import Machine, Order, OrderEvent, OrderStatus, Review, ServiceSKU, User, UserRole

WORK_TYPE_META = {
    "收割": {"label": "收割", "theme": "harvest"},
    "播种": {"label": "播种", "theme": "seeding"},
    "耕地": {"label": "耕整", "theme": "tillage"},
    "植保": {"label": "植保", "theme": "protection"},
}


def parse_payload(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def format_dt(value) -> str | None:
    if not value:
        return None
    return value.strftime("%m-%d %H:%M")


def build_service_window(order: Order) -> str:
    if order.schedule_start and order.schedule_end:
        return f"{format_dt(order.schedule_start)} - {format_dt(order.schedule_end)}"
    if order.schedule_start:
        return f"{format_dt(order.schedule_start)} 起"
    return "时间待平台确认"


def work_type_label(work_type: str) -> str:
    return WORK_TYPE_META.get(work_type, {}).get("label", work_type)


def resolve_order_region(order: Order, buyer: User | None) -> str:
    if buyer and buyer.region:
        return buyer.region
    if order.target_lat is not None and order.target_lng is not None:
        return f"田块@{order.target_lat:.3f},{order.target_lng:.3f}"
    return "待确认区域"


def latest_event(events: list[OrderEvent], *event_types: str) -> OrderEvent | None:
    event_type_set = set(event_types)
    for event in reversed(events):
        if event.event_type in event_type_set:
            return event
    return None


def find_latest_dispatch_cycle_index(events: list[OrderEvent]) -> int:
    for idx in range(len(events) - 1, -1, -1):
        if (
            events[idx].to_status in {OrderStatus.DISPATCH_CONFIRMED.value, OrderStatus.REASSIGN_CONFIRMED.value}
            and events[idx].event_type in {"status_transition", "supervisor_confirm_dispatch"}
        ):
            return idx
    return -1


def event_after_cycle(events: list[OrderEvent], cycle_index: int, event_type: str) -> OrderEvent | None:
    for idx in range(len(events) - 1, cycle_index, -1):
        if events[idx].event_type == event_type:
            return events[idx]
    return None


def summarize_event(event: OrderEvent | None) -> str:
    if not event:
        return "暂无动态"
    payload = parse_payload(event.payload_json)
    custom_note = str(payload.get("note") or payload.get("description") or "").strip()
    mapping = {
        "create_order": "租赁端已提交订单",
        "pay_order": "租赁端已完成托管支付",
        "agent_dispatch_propose": "调度算法已生成候选方案",
        "machine_accept": "机主已接单",
        "machine_depart": "机手已出发前往田块",
        "machine_reject": "机主拒单，平台已回流重派",
        "machine_reschedule_request": "机主申请改约，平台待重排",
        "machine_fault_report": "机手已上报设备故障",
        "start_service": "农机已到场并开工",
        "finish_service": "农机已提交完工回传",
        "confirm_service": "租赁端已确认验收",
        "agent_exception_handle": "异常 Agent 已给出处置建议",
    }
    base = mapping.get(event.event_type)
    if base:
        return f"{base}：{custom_note}" if custom_note else base
    if event.event_type == "status_transition":
        if custom_note:
            return custom_note
        return f"订单状态更新为 {event.to_status}"
    return custom_note or event.event_type


def derive_tracking_stage(order: Order, events: list[OrderEvent]) -> dict[str, Any]:
    cycle_index = find_latest_dispatch_cycle_index(events)
    accepted_event = event_after_cycle(events, cycle_index, "machine_accept")
    departed_event = event_after_cycle(events, cycle_index, "machine_depart")
    fault_event = latest_event(events, "machine_fault_report")
    stage_key = order.status.value.lower()
    stage_label = order.status.value
    logistics_text = "平台处理中"
    progress_index = 0

    if order.status == OrderStatus.CREATED:
        stage_key = "await_pay"
        stage_label = "待支付"
        logistics_text = "订单已创建，等待托管支付"
        progress_index = 0
    elif order.status == OrderStatus.PAID_ESCROW:
        stage_key = "matching"
        stage_label = "平台匹配中"
        logistics_text = "平台正在结合距离、天气、健康分计算最优机组"
        progress_index = 1
    elif order.status == OrderStatus.DISPATCH_PROPOSED:
        stage_key = "waiting_dispatch"
        stage_label = "待主管派单"
        logistics_text = "调度主管待确认最终派单结果"
        progress_index = 2
    elif order.status == OrderStatus.DISPATCH_CONFIRMED:
        progress_index = 3
        if departed_event:
            stage_key = "en_route"
            stage_label = "机手已出发"
            logistics_text = "机手正在前往田块，租赁端可等待到场"
            progress_index = 4
        elif accepted_event:
            stage_key = "accepted"
            stage_label = "机主已接单"
            logistics_text = "机主已确认作业安排，待机手出发"
        else:
            stage_key = "waiting_owner"
            stage_label = "机主待响应"
            logistics_text = "平台已派单，等待机主确认接单"
    elif order.status == OrderStatus.IN_SERVICE:
        stage_key = "servicing"
        stage_label = "正在作业"
        logistics_text = "农机正在田块执行作业"
        progress_index = 5
    elif order.status == OrderStatus.ABNORMAL_PENDING:
        stage_key = "abnormal"
        stage_label = "异常待处理"
        logistics_text = "天气或设备异常触发，等待主管处置"
        if fault_event:
            logistics_text = "机手已上报故障，等待平台改派或恢复"
        progress_index = 5
    elif order.status == OrderStatus.REASSIGN_PROPOSED:
        stage_key = "reassigning"
        stage_label = "改派处理中"
        logistics_text = "平台正在重新计算替补机组"
        progress_index = 3
    elif order.status == OrderStatus.REASSIGN_CONFIRMED:
        if departed_event:
            stage_key = "reassign_en_route"
            stage_label = "替补机手已出发"
            logistics_text = "替补机组正在赶赴田块"
            progress_index = 4
        elif accepted_event:
            stage_key = "reassign_accepted"
            stage_label = "替补机主已接单"
            logistics_text = "替补机主已接单，等待出发"
            progress_index = 3
        else:
            stage_key = "reassign_waiting_owner"
            stage_label = "替补机主待响应"
            logistics_text = "改派结果已确认，等待替补机主响应"
            progress_index = 3
    elif order.status == OrderStatus.TO_CONFIRM:
        stage_key = "to_confirm"
        stage_label = "待验收"
        logistics_text = "作业完成，等待租赁端确认验收"
        progress_index = 6
    elif order.status == OrderStatus.COMPLETED:
        stage_key = "completed"
        stage_label = "已完成"
        logistics_text = "订单已闭环完成"
        progress_index = 7
    elif order.status == OrderStatus.REFUNDING:
        stage_key = "refunding"
        stage_label = "退款中"
        logistics_text = "订单已终止，平台退款处理中"
        progress_index = 6
    elif order.status == OrderStatus.REFUNDED:
        stage_key = "refunded"
        stage_label = "已退款"
        logistics_text = "订单已退款完成"
        progress_index = 7
    elif order.status == OrderStatus.CANCELED:
        stage_key = "canceled"
        stage_label = "已取消"
        logistics_text = "订单已取消"
        progress_index = 7
    elif order.status == OrderStatus.DISPUTE:
        stage_key = "dispute"
        stage_label = "争议处理中"
        logistics_text = "订单进入争议处理"
        progress_index = 6

    return {
        "stage_key": stage_key,
        "stage_label": stage_label,
        "logistics_text": logistics_text,
        "progress_index": progress_index,
    }


def build_timeline(order: Order, events: list[OrderEvent]) -> list[dict[str, Any]]:
    stage = derive_tracking_stage(order, events)
    progress_index = int(stage["progress_index"])

    key_to_event = {
        "create": latest_event(events, "create_order", "seed_import"),
        "pay": latest_event(events, "pay_order"),
        "dispatch": latest_event(events, "agent_dispatch_propose", "status_transition"),
        "accept": latest_event(events, "machine_accept"),
        "depart": latest_event(events, "machine_depart"),
        "start": latest_event(events, "start_service"),
        "finish": latest_event(events, "finish_service"),
        "confirm": latest_event(events, "confirm_service"),
    }

    steps = [
        ("create", "提交订单"),
        ("pay", "托管支付"),
        ("dispatch", "调度派单"),
        ("accept", "机主响应"),
        ("depart", "机手出发"),
        ("start", "开始作业"),
        ("finish", "待验收"),
        ("confirm", "完成闭环"),
    ]
    timeline = []
    for idx, (key, label) in enumerate(steps):
        event = key_to_event.get(key)
        state = "todo"
        if idx < progress_index:
            state = "done"
        elif idx == progress_index:
            state = "current"
        if event:
            state = "done" if idx <= progress_index else state
        timeline.append(
            {
                "key": key,
                "label": label,
                "state": state,
                "time": format_dt(event.created_at) if event else None,
                "detail": summarize_event(event) if event else "",
            }
        )
    return timeline


def build_order_card(db: Session, order: Order) -> dict[str, Any]:
    buyer = db.get(User, order.buyer_id)
    sku = db.get(ServiceSKU, order.sku_id)
    machine = db.get(Machine, order.machine_id) if order.machine_id else None
    owner = db.get(User, machine.owner_id) if machine else (db.get(User, sku.owner_id) if sku else None)
    events = (
        db.query(OrderEvent)
        .filter(OrderEvent.order_id == order.id)
        .order_by(OrderEvent.created_at.asc(), OrderEvent.id.asc())
        .all()
    )
    stage = derive_tracking_stage(order, events)
    timeline = build_timeline(order, events)
    recent = events[-1] if events else None
    payload = parse_payload(recent.payload_json) if recent else {}
    last_action_note = summarize_event(recent)

    return {
        "id": order.id,
        "order_no": order.order_no,
        "status": order.status.value,
        "stage_key": stage["stage_key"],
        "stage_label": stage["stage_label"],
        "logistics_text": stage["logistics_text"],
        "amount": order.amount,
        "area_mu": order.area_mu,
        "urgency_level": order.urgency_level,
        "quality_constraints": order.quality_constraints,
        "service_window": build_service_window(order),
        "created_at": order.created_at.isoformat(),
        "updated_at": order.updated_at.isoformat(),
        "target": {
            "lng": order.target_lng,
            "lat": order.target_lat,
            "region": resolve_order_region(order, buyer),
            "address_text": resolve_order_region(order, buyer),
        },
        "buyer": {
            "id": buyer.id if buyer else None,
            "name": buyer.name if buyer else "未知需求方",
            "region": buyer.region if buyer else "",
        },
        "sku": {
            "id": sku.id if sku else None,
            "title": sku.title if sku else "未知服务",
            "work_type": sku.work_type if sku else "",
            "work_type_label": work_type_label(sku.work_type if sku else ""),
            "unit_price": sku.unit_price if sku else 0,
        },
        "machine": {
            "id": machine.id if machine else None,
            "machine_type": machine.machine_type if machine else "",
            "health_score": machine.health_score if machine else None,
            "status": machine.status.value if machine else None,
        },
        "owner": {
            "id": owner.id if owner else None,
            "name": owner.name if owner else "待平台确认",
            "rating": owner.rating if owner else None,
        },
        "timeline": timeline,
        "latest_event": {
            "event_type": recent.event_type if recent else "",
            "time": format_dt(recent.created_at) if recent else None,
            "summary": last_action_note,
            "payload": payload,
        },
    }


def build_service_card(db: Session, sku: ServiceSKU) -> dict[str, Any]:
    owner = db.get(User, sku.owner_id)
    machine = db.get(Machine, sku.machine_id)
    total_orders = db.query(func.count(Order.id)).filter(Order.sku_id == sku.id).scalar() or 0
    completed_orders = (
        db.query(func.count(Order.id))
        .filter(Order.sku_id == sku.id, Order.status == OrderStatus.COMPLETED)
        .scalar()
        or 0
    )
    eta_minutes = max(18, round((sku.radius_km or 20) * 1.35))
    completion_rate = round((completed_orders / total_orders) * 100, 1) if total_orders else round((owner.rating if owner else 4.5) * 20, 1)
    tags = [
        f"{work_type_label(sku.work_type)}服务",
        f"{sku.radius_km:.0f}km覆盖",
        f"{sku.min_area:.0f}亩起接",
    ]
    if owner and owner.rating >= 4.6:
        tags.append("高评分机主")
    if machine and machine.health_score >= 88:
        tags.append("高健康分机具")

    return {
        "sku_id": sku.id,
        "title": sku.title,
        "work_type": sku.work_type,
        "work_type_label": work_type_label(sku.work_type),
        "unit_price": sku.unit_price,
        "unit": sku.unit,
        "radius_km": sku.radius_km,
        "min_area": sku.min_area,
        "owner_id": owner.id if owner else None,
        "owner_name": owner.name if owner else "未知机主",
        "owner_rating": owner.rating if owner else 4.5,
        "region": owner.region if owner else "",
        "machine_id": machine.id if machine else None,
        "machine_type": machine.machine_type if machine else "",
        "machine_status": machine.status.value if machine else "idle",
        "health_score": machine.health_score if machine else 0,
        "capacity_mu_per_hour": machine.capacity_mu_per_hour if machine else 0,
        "completion_rate": completion_rate,
        "monthly_orders": total_orders,
        "eta_minutes": eta_minutes,
        "summary": f"{machine.machine_type if machine else '农机服务'} · {machine.capacity_mu_per_hour if machine else 0}亩/小时",
        "tags": tags,
    }


def build_region_heat(db: Session) -> list[dict[str, Any]]:
    orders = db.query(Order).all()
    regions: dict[str, dict[str, Any]] = defaultdict(lambda: {"total": 0, "active": 0, "abnormal": 0, "completed": 0})
    for order in orders:
        buyer = db.get(User, order.buyer_id)
        region = resolve_order_region(order, buyer)
        item = regions[region]
        item["total"] += 1
        if order.status in {
            OrderStatus.PAID_ESCROW,
            OrderStatus.DISPATCH_PROPOSED,
            OrderStatus.DISPATCH_CONFIRMED,
            OrderStatus.REASSIGN_PROPOSED,
            OrderStatus.REASSIGN_CONFIRMED,
            OrderStatus.IN_SERVICE,
            OrderStatus.ABNORMAL_PENDING,
            OrderStatus.TO_CONFIRM,
        }:
            item["active"] += 1
        if order.status in {OrderStatus.ABNORMAL_PENDING, OrderStatus.REASSIGN_PROPOSED}:
            item["abnormal"] += 1
        if order.status == OrderStatus.COMPLETED:
            item["completed"] += 1

    heat = []
    for region, item in regions.items():
        total = item["total"] or 1
        completion_rate = round((item["completed"] / total) * 100, 1)
        abnormal_rate = round((item["abnormal"] / total) * 100, 1)
        heat.append(
            {
                "region": region,
                "total_orders": item["total"],
                "active_orders": item["active"],
                "abnormal_orders": item["abnormal"],
                "completion_rate": completion_rate,
                "abnormal_rate": abnormal_rate,
                "heat": min(100, item["active"] * 18 + item["abnormal"] * 20 + item["total"] * 8),
            }
        )
    return sorted(heat, key=lambda item: (-item["heat"], item["region"]))


def build_owner_rankings(db: Session) -> list[dict[str, Any]]:
    owners = db.query(User).filter(User.role == UserRole.owner).all()
    rankings = []
    for owner in owners:
        machine_ids = [row[0] for row in db.query(Machine.id).filter(Machine.owner_id == owner.id).all()]
        total_orders = 0
        completed_orders = 0
        abnormal_orders = 0
        if machine_ids:
            total_orders = db.query(func.count(Order.id)).filter(Order.machine_id.in_(machine_ids)).scalar() or 0
            completed_orders = (
                db.query(func.count(Order.id))
                .filter(Order.machine_id.in_(machine_ids), Order.status == OrderStatus.COMPLETED)
                .scalar()
                or 0
            )
            abnormal_orders = (
                db.query(func.count(Order.id))
                .filter(Order.machine_id.in_(machine_ids), Order.status == OrderStatus.ABNORMAL_PENDING)
                .scalar()
                or 0
            )
        review_avg = db.query(func.avg(Review.rating)).filter(Review.owner_id == owner.id).scalar()
        base_rating = float(review_avg or owner.rating or 4.5)
        completion_rate = (completed_orders / total_orders) * 100 if total_orders else base_rating * 20
        abnormal_penalty = (abnormal_orders / total_orders) * 100 if total_orders else 0
        service_score = round(base_rating * 11 + completion_rate * 0.45 - abnormal_penalty * 0.15, 1)
        rankings.append(
            {
                "owner_id": owner.id,
                "name": owner.name,
                "region": owner.region,
                "rating": round(base_rating, 2),
                "total_orders": total_orders,
                "completed_orders": completed_orders,
                "completion_rate": round(completion_rate, 1),
                "abnormal_orders": abnormal_orders,
                "service_score": max(60.0, min(99.0, service_score)),
            }
        )
    return sorted(rankings, key=lambda item: (-item["service_score"], -item["completed_orders"], item["name"]))


def build_recent_event_feed(db: Session, limit: int = 12) -> list[dict[str, Any]]:
    events = db.query(OrderEvent).order_by(OrderEvent.created_at.desc(), OrderEvent.id.desc()).limit(limit).all()
    feed = []
    for event in events:
        feed.append(
            {
                "id": event.id,
                "order_id": event.order_id,
                "event_type": event.event_type,
                "created_at": event.created_at.isoformat(),
                "summary": summarize_event(event),
                "payload": parse_payload(event.payload_json),
            }
        )
    return feed
