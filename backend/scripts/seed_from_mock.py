from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.db import Base, SessionLocal, engine
from app.models import (
    DispatchLog,
    Machine,
    MachineStatus,
    Order,
    OrderEvent,
    OrderStatus,
    Review,
    ServiceSKU,
    TelemetryPoint,
    User,
    UserRole,
    WeatherAlert,
)


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value)


def clear_tables(db):
    db.query(OrderEvent).delete(synchronize_session=False)
    db.query(DispatchLog).delete(synchronize_session=False)
    db.query(Review).delete(synchronize_session=False)
    db.query(TelemetryPoint).delete(synchronize_session=False)
    db.query(WeatherAlert).delete(synchronize_session=False)
    db.query(Order).delete(synchronize_session=False)
    db.query(ServiceSKU).delete(synchronize_session=False)
    db.query(Machine).delete(synchronize_session=False)
    db.query(User).delete(synchronize_session=False)


def seed_from_file(source_file: Path) -> None:
    Base.metadata.create_all(bind=engine)

    data = json.loads(source_file.read_text(encoding="utf-8"))
    db = SessionLocal()
    try:
        clear_tables(db)

        for item in data.get("users", []):
            db.add(
                User(
                    id=item["id"],
                    role=UserRole(item["role"]),
                    name=item["name"],
                    phone=item["phone"],
                    rating=float(item.get("rating", 5.0)),
                    region=item.get("region", ""),
                )
            )

        for item in data.get("machines", []):
            db.add(
                Machine(
                    id=item["id"],
                    owner_id=item["owner_id"],
                    machine_type=item["machine_type"],
                    capacity_mu_per_hour=float(item.get("capacity_mu_per_hour", 0)),
                    lng=float(item.get("lng", 0.0)),
                    lat=float(item.get("lat", 0.0)),
                    status=MachineStatus(item.get("status", "idle")),
                    health_score=int(item.get("health_score", 80)),
                )
            )

        for item in data.get("service_skus", []):
            db.add(
                ServiceSKU(
                    id=item["id"],
                    owner_id=item["owner_id"],
                    machine_id=item["machine_id"],
                    work_type=item["work_type"],
                    title=item["title"],
                    unit=item.get("unit", "mu"),
                    unit_price=float(item.get("unit_price", 0.0)),
                    radius_km=float(item.get("radius_km", 20)),
                    min_area=float(item.get("min_area", 1)),
                    is_active=1,
                )
            )

        for item in data.get("orders", []):
            status = OrderStatus(item["status"])
            order = Order(
                id=item["id"],
                order_no=item["order_no"],
                buyer_id=item["buyer_id"],
                sku_id=item["sku_id"],
                machine_id=item.get("machine_id"),
                area_mu=float(item.get("area_mu", 0)),
                amount=float(item.get("amount", 0)),
                status=status,
                urgency_level=item.get("urgency_level", "medium"),
                quality_constraints=item.get("quality_constraints", ""),
                schedule_start=parse_dt(item.get("schedule_start")),
                schedule_end=parse_dt(item.get("schedule_end")),
                target_lng=float(item["target_lng"]) if item.get("target_lng") is not None else None,
                target_lat=float(item["target_lat"]) if item.get("target_lat") is not None else None,
            )
            db.add(order)
            db.add(
                OrderEvent(
                    order_id=item["id"],
                    event_type="seed_import",
                    from_status=None,
                    to_status=status.value,
                    payload_json="{}",
                )
            )

        for item in data.get("dispatch_logs", []):
            db.add(
                DispatchLog(
                    id=item["id"],
                    order_id=item["order_id"],
                    selected_machine_id=item.get("selected_machine_id"),
                    agent=item.get("agent", "DispatchAgent"),
                    score_breakdown_json=json.dumps(item.get("score_breakdown", {}), ensure_ascii=False),
                    reason=item.get("reason", ""),
                    need_human_approval=1 if item.get("need_human_approval", True) else 0,
                    approval_status=item.get("approval_status", "pending"),
                )
            )

        for item in data.get("telemetry_stream", []):
            db.add(
                TelemetryPoint(
                    machine_id=item["machine_id"],
                    ts=parse_dt(item["ts"]),
                    speed_kmh=float(item.get("speed_kmh", 0.0)),
                    engine_temp=float(item.get("engine_temp", 0.0)),
                    fuel_rate=float(item.get("fuel_rate", 0.0)),
                    status=item.get("status", "normal"),
                )
            )

        for item in data.get("weather_alerts", []):
            db.add(
                WeatherAlert(
                    id=item["id"],
                    region=item["region"],
                    level=item["level"],
                    type=item["type"],
                    start=parse_dt(item["start"]),
                    end=parse_dt(item["end"]),
                )
            )

        for item in data.get("reviews", []):
            db.add(
                Review(
                    id=item["id"],
                    order_id=item["order_id"],
                    buyer_id=item["buyer_id"],
                    owner_id=item["owner_id"],
                    rating=int(item["rating"]),
                    content=item.get("content", ""),
                )
            )

        db.commit()
        print("Seed import complete.")
        print(f"users={db.query(User).count()} machines={db.query(Machine).count()} skus={db.query(ServiceSKU).count()} orders={db.query(Order).count()}")
    finally:
        db.close()


if __name__ == "__main__":
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else WORKSPACE_ROOT / "mock_data_seed.json"
    if not source.exists():
        raise FileNotFoundError(f"seed file not found: {source}")
    seed_from_file(source)
