from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import DateTime, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _utcnow_naive() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class UserRole(str, enum.Enum):
    buyer = "buyer"
    owner = "owner"
    dispatcher = "dispatcher"
    admin = "admin"


class MachineStatus(str, enum.Enum):
    idle = "idle"
    busy = "busy"
    offline = "offline"


class OrderStatus(str, enum.Enum):
    CREATED = "CREATED"
    PAID_ESCROW = "PAID_ESCROW"
    DISPATCH_PROPOSED = "DISPATCH_PROPOSED"
    DISPATCH_CONFIRMED = "DISPATCH_CONFIRMED"
    IN_SERVICE = "IN_SERVICE"
    ABNORMAL_PENDING = "ABNORMAL_PENDING"
    REASSIGN_PROPOSED = "REASSIGN_PROPOSED"
    REASSIGN_CONFIRMED = "REASSIGN_CONFIRMED"
    TO_CONFIRM = "TO_CONFIRM"
    COMPLETED = "COMPLETED"
    CANCELED = "CANCELED"
    REFUNDING = "REFUNDING"
    REFUNDED = "REFUNDED"
    DISPUTE = "DISPUTE"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), nullable=False)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    phone: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    rating: Mapped[float] = mapped_column(Float, default=5.0)
    region: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow_naive)


class Machine(Base):
    __tablename__ = "machines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    machine_type: Mapped[str] = mapped_column(String(64), nullable=False)
    capacity_mu_per_hour: Mapped[float] = mapped_column(Float, nullable=False)
    lng: Mapped[float] = mapped_column(Float, default=0.0)
    lat: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[MachineStatus] = mapped_column(Enum(MachineStatus), default=MachineStatus.idle)
    health_score: Mapped[int] = mapped_column(Integer, default=80)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow_naive)

    owner: Mapped[User] = relationship("User")


class ServiceSKU(Base):
    __tablename__ = "service_skus"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    machine_id: Mapped[int] = mapped_column(ForeignKey("machines.id"), nullable=False)
    work_type: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(128), nullable=False)
    unit: Mapped[str] = mapped_column(String(16), default="mu")
    unit_price: Mapped[float] = mapped_column(Float, nullable=False)
    radius_km: Mapped[float] = mapped_column(Float, default=20.0)
    min_area: Mapped[float] = mapped_column(Float, default=1.0)
    is_active: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow_naive)

    owner: Mapped[User] = relationship("User")
    machine: Mapped[Machine] = relationship("Machine")


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_no: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    buyer_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    sku_id: Mapped[int] = mapped_column(ForeignKey("service_skus.id"), nullable=False)
    machine_id: Mapped[int | None] = mapped_column(ForeignKey("machines.id"), nullable=True)
    area_mu: Mapped[float] = mapped_column(Float, nullable=False)
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[OrderStatus] = mapped_column(Enum(OrderStatus), default=OrderStatus.CREATED, nullable=False)
    urgency_level: Mapped[str] = mapped_column(String(16), default="medium")
    quality_constraints: Mapped[str] = mapped_column(Text, default="")
    schedule_start: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    schedule_end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    target_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    target_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow_naive)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow_naive, onupdate=_utcnow_naive)

    buyer: Mapped[User] = relationship("User")
    sku: Mapped[ServiceSKU] = relationship("ServiceSKU")
    machine: Mapped[Machine | None] = relationship("Machine")


class DispatchLog(Base):
    __tablename__ = "dispatch_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), nullable=False)
    selected_machine_id: Mapped[int | None] = mapped_column(ForeignKey("machines.id"), nullable=True)
    agent: Mapped[str] = mapped_column(String(32), default="DispatchAgent")
    score_breakdown_json: Mapped[str] = mapped_column(Text, default="{}")
    reason: Mapped[str] = mapped_column(Text, default="")
    need_human_approval: Mapped[int] = mapped_column(Integer, default=1)
    approval_status: Mapped[str] = mapped_column(String(16), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow_naive)


class OrderEvent(Base):
    __tablename__ = "order_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    from_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    to_status: Mapped[str] = mapped_column(String(32), nullable=False)
    operator_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    payload_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow_naive)


class TelemetryPoint(Base):
    __tablename__ = "telemetry_points"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    machine_id: Mapped[int] = mapped_column(ForeignKey("machines.id"), nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    speed_kmh: Mapped[float] = mapped_column(Float, default=0.0)
    engine_temp: Mapped[float] = mapped_column(Float, default=0.0)
    fuel_rate: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(16), default="normal")


class WeatherAlert(Base):
    __tablename__ = "weather_alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    region: Mapped[str] = mapped_column(String(128), nullable=False)
    level: Mapped[str] = mapped_column(String(16), nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    end: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class Review(Base):
    __tablename__ = "reviews"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), nullable=False)
    buyer_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow_naive)
