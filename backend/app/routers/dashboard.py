from __future__ import annotations

from math import asin, cos, pi, radians, sin, sqrt

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Machine, Order, OrderEvent, OrderStatus, ServiceSKU, TelemetryPoint, User, WeatherAlert
from ..services.portal_views import build_order_card, build_service_card

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius_km = 6371.0
    phi1 = radians(lat1)
    phi2 = radians(lat2)
    dphi = radians(lat2 - lat1)
    dlambda = radians(lng2 - lng1)
    a = sin(dphi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(dlambda / 2) ** 2
    return 2 * radius_km * asin(sqrt(a))


def _plot_radius_m(area_mu: float) -> float:
    area_sqm = max(float(area_mu or 0.0), 0.0) * 666.6667
    return round(sqrt(area_sqm / pi), 1) if area_sqm else 0.0


def _resolve_alert_center(alert: WeatherAlert, orders: list[Order], buyers_by_id: dict[int, User], machines: list[Machine], owners_by_id: dict[int, User]) -> tuple[float, float] | None:
    points: list[tuple[float, float]] = []

    for order in orders:
        buyer = buyers_by_id.get(order.buyer_id)
        if buyer and buyer.region == alert.region and order.target_lng is not None and order.target_lat is not None:
            points.append((float(order.target_lng), float(order.target_lat)))

    if not points:
        for machine in machines:
            owner = owners_by_id.get(machine.owner_id)
            if owner and owner.region == alert.region:
                points.append((float(machine.lng), float(machine.lat)))

    if not points:
        return None

    lng = round(sum(item[0] for item in points) / len(points), 6)
    lat = round(sum(item[1] for item in points) / len(points), 6)
    return lng, lat


@router.get("/metrics")
def dashboard_metrics(db: Session = Depends(get_db)) -> dict:
    total_orders = db.query(func.count(Order.id)).scalar() or 0
    completed_orders = db.query(func.count(Order.id)).filter(Order.status == OrderStatus.COMPLETED).scalar() or 0
    avg_amount = db.query(func.avg(Order.amount)).scalar() or 0.0

    status_rows = db.query(Order.status, func.count(Order.id)).group_by(Order.status).all()
    status_counts = {row[0].value: row[1] for row in status_rows}

    active_statuses = [
        OrderStatus.DISPATCH_PROPOSED,
        OrderStatus.DISPATCH_CONFIRMED,
        OrderStatus.IN_SERVICE,
        OrderStatus.ABNORMAL_PENDING,
        OrderStatus.REASSIGN_PROPOSED,
        OrderStatus.REASSIGN_CONFIRMED,
    ]
    active_orders = (
        db.query(func.count(Order.id))
        .filter(Order.status.in_(active_statuses))
        .scalar()
        or 0
    )

    completion_rate = round((completed_orders / total_orders) * 100, 2) if total_orders else 0.0

    return {
        "total_orders": total_orders,
        "completed_orders": completed_orders,
        "completion_rate": completion_rate,
        "active_orders": active_orders,
        "avg_order_amount": round(float(avg_amount), 2),
        "status_counts": status_counts,
    }


@router.get("/recent-events")
def recent_events(limit: int = 20, db: Session = Depends(get_db)) -> list[dict]:
    limit = min(max(limit, 1), 100)
    events = db.query(OrderEvent).order_by(OrderEvent.created_at.desc(), OrderEvent.id.desc()).limit(limit).all()
    return [
        {
            "id": event.id,
            "order_id": event.order_id,
            "event_type": event.event_type,
            "from_status": event.from_status,
            "to_status": event.to_status,
            "operator_id": event.operator_id,
            "payload": event.payload_json,
            "created_at": event.created_at.isoformat(),
        }
        for event in events
    ]


@router.get("/map-overview")
def dashboard_map_overview(db: Session = Depends(get_db)) -> dict:
    users = db.query(User).order_by(User.id.asc()).all()
    users_by_id = {user.id: user for user in users}

    machines = db.query(Machine).order_by(Machine.id.asc()).all()
    skus = db.query(ServiceSKU).order_by(ServiceSKU.id.asc()).all()
    orders = db.query(Order).order_by(Order.id.asc()).all()
    alerts = db.query(WeatherAlert).order_by(WeatherAlert.start.asc(), WeatherAlert.id.asc()).all()
    telemetry_rows = db.query(TelemetryPoint).order_by(TelemetryPoint.machine_id.asc(), TelemetryPoint.ts.desc()).all()

    latest_telemetry_by_machine: dict[int, TelemetryPoint] = {}
    for telemetry in telemetry_rows:
        latest_telemetry_by_machine.setdefault(telemetry.machine_id, telemetry)

    skus_by_machine: dict[int, list[ServiceSKU]] = {}
    for sku in skus:
        skus_by_machine.setdefault(sku.machine_id, []).append(sku)

    order_cards = [build_order_card(db, order) for order in orders]
    order_cards_by_id = {card["id"]: card for card in order_cards}
    service_cards = [build_service_card(db, sku) for sku in skus]

    order_status_pairs = sorted({(card["status"], card["stage_label"]) for card in order_cards}, key=lambda item: item[0])
    work_types = sorted({card["sku"]["work_type_label"] for card in order_cards if card["sku"]["work_type_label"]})
    work_types.extend(sorted({item["work_type_label"] for item in service_cards if item["work_type_label"] and item["work_type_label"] not in work_types}))

    machine_items = []
    for machine in machines:
        owner = users_by_id.get(machine.owner_id)
        related_services = skus_by_machine.get(machine.id, [])
        related_orders = [card for card in order_cards if int(card["machine"]["id"] or 0) == machine.id]
        latest_telemetry = latest_telemetry_by_machine.get(machine.id)
        machine_items.append(
            {
                "id": machine.id,
                "owner_id": machine.owner_id,
                "owner_name": owner.name if owner else f"机主#{machine.owner_id}",
                "owner_rating": owner.rating if owner else 4.5,
                "region": owner.region if owner else "",
                "machine_type": machine.machine_type,
                "capacity_mu_per_hour": machine.capacity_mu_per_hour,
                "status": machine.status.value,
                "health_score": machine.health_score,
                "lng": float(machine.lng),
                "lat": float(machine.lat),
                "work_types": sorted({item.work_type for item in related_services}),
                "active_order_ids": [card["id"] for card in related_orders],
                "latest_telemetry": {
                    "ts": latest_telemetry.ts.isoformat(),
                    "speed_kmh": latest_telemetry.speed_kmh,
                    "engine_temp": latest_telemetry.engine_temp,
                    "fuel_rate": latest_telemetry.fuel_rate,
                    "status": latest_telemetry.status,
                }
                if latest_telemetry
                else None,
            }
        )

    field_items = []
    for order in orders:
        card = order_cards_by_id[order.id]
        if order.target_lng is None or order.target_lat is None:
            continue
        field_items.append(
            {
                "order_id": order.id,
                "order_no": order.order_no,
                "buyer_id": order.buyer_id,
                "buyer_name": card["buyer"]["name"],
                "region": card["target"]["region"],
                "work_type": card["sku"]["work_type"],
                "work_type_label": card["sku"]["work_type_label"],
                "title": card["sku"]["title"],
                "status": card["status"],
                "stage_key": card["stage_key"],
                "stage_label": card["stage_label"],
                "urgency_level": card["urgency_level"],
                "amount": card["amount"],
                "area_mu": card["area_mu"],
                "plot_radius_m": _plot_radius_m(card["area_mu"]),
                "machine_id": card["machine"]["id"],
                "machine_type": card["machine"]["machine_type"],
                "owner_name": card["owner"]["name"],
                "service_window": card["service_window"],
                "quality_constraints": card["quality_constraints"],
                "lng": float(order.target_lng),
                "lat": float(order.target_lat),
                "latest_event": card["latest_event"]["summary"],
            }
        )

    service_items = []
    for service in service_cards:
        machine = next((item for item in machines if item.id == service["machine_id"]), None)
        if not machine:
            continue
        service_items.append(
            {
                "sku_id": service["sku_id"],
                "title": service["title"],
                "work_type": service["work_type"],
                "work_type_label": service["work_type_label"],
                "owner_id": service["owner_id"],
                "owner_name": service["owner_name"],
                "owner_rating": service["owner_rating"],
                "region": service["region"],
                "machine_id": service["machine_id"],
                "machine_type": service["machine_type"],
                "machine_status": service["machine_status"],
                "health_score": service["health_score"],
                "capacity_mu_per_hour": service["capacity_mu_per_hour"],
                "unit_price": service["unit_price"],
                "unit": service["unit"],
                "radius_km": service["radius_km"],
                "min_area": service["min_area"],
                "lng": float(machine.lng),
                "lat": float(machine.lat),
                "completion_rate": service["completion_rate"],
                "summary": service["summary"],
            }
        )

    route_items = []
    for order in orders:
        if not order.machine_id or order.target_lng is None or order.target_lat is None:
            continue
        machine = next((item for item in machines if item.id == order.machine_id), None)
        card = order_cards_by_id[order.id]
        if not machine:
            continue
        route_items.append(
            {
                "order_id": order.id,
                "machine_id": machine.id,
                "machine_type": machine.machine_type,
                "owner_name": card["owner"]["name"],
                "buyer_name": card["buyer"]["name"],
                "work_type": card["sku"]["work_type"],
                "work_type_label": card["sku"]["work_type_label"],
                "status": card["status"],
                "stage_key": card["stage_key"],
                "stage_label": card["stage_label"],
                "distance_km": round(_haversine_km(order.target_lat, order.target_lng, machine.lat, machine.lng), 2),
                "from_lng": float(machine.lng),
                "from_lat": float(machine.lat),
                "to_lng": float(order.target_lng),
                "to_lat": float(order.target_lat),
            }
        )

    alert_items = []
    owners_by_id = {user.id: user for user in users if user.role.value == "owner"}
    buyers_by_id = {user.id: user for user in users if user.role.value == "buyer"}
    for alert in alerts:
        center = _resolve_alert_center(alert, orders, buyers_by_id, machines, owners_by_id)
        if not center:
            continue
        lng, lat = center
        alert_items.append(
            {
                "id": alert.id,
                "region": alert.region,
                "level": alert.level,
                "type": alert.type,
                "start": alert.start.isoformat(),
                "end": alert.end.isoformat(),
                "lng": lng,
                "lat": lat,
            }
        )

    active_route_count = sum(1 for item in route_items if item["status"] not in {"COMPLETED", "REFUNDED", "CANCELED"})

    return {
        "metrics": {
            "machine_count": len(machine_items),
            "field_count": len(field_items),
            "service_count": len(service_items),
            "route_count": len(route_items),
            "active_route_count": active_route_count,
            "weather_alert_count": len(alert_items),
        },
        "filters": {
            "regions": sorted({item["region"] for item in machine_items if item["region"]} | {item["region"] for item in field_items if item["region"]}),
            "work_types": [{"key": item, "label": item} for item in work_types],
            "statuses": [{"key": key, "label": label} for key, label in order_status_pairs],
        },
        "machines": machine_items,
        "fields": field_items,
        "service_coverage": service_items,
        "routes": route_items,
        "weather_alerts": alert_items,
    }
