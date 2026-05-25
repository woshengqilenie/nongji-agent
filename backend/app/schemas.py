from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from .models import MachineStatus, OrderStatus, UserRole


class UserOut(BaseModel):
    id: int
    role: UserRole
    name: str
    phone: str
    rating: float
    region: str

    class Config:
        from_attributes = True


class MachineOut(BaseModel):
    id: int
    owner_id: int
    machine_type: str
    capacity_mu_per_hour: float
    lng: float
    lat: float
    status: MachineStatus
    health_score: int

    class Config:
        from_attributes = True


class SKUOut(BaseModel):
    id: int
    owner_id: int
    machine_id: int
    work_type: str
    title: str
    unit: str
    unit_price: float
    radius_km: float
    min_area: float

    class Config:
        from_attributes = True


class OrderCreateIn(BaseModel):
    buyer_id: int
    sku_id: int
    area_mu: float = Field(gt=0)
    urgency_level: str = "medium"
    quality_constraints: str = ""
    schedule_start: datetime | None = None
    schedule_end: datetime | None = None
    target_lng: float | None = None
    target_lat: float | None = None


class OrderOut(BaseModel):
    id: int
    order_no: str
    buyer_id: int
    sku_id: int
    machine_id: int | None
    area_mu: float
    amount: float
    status: OrderStatus
    urgency_level: str
    quality_constraints: str
    schedule_start: datetime | None
    schedule_end: datetime | None
    target_lng: float | None
    target_lat: float | None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class TransitionIn(BaseModel):
    to_status: OrderStatus
    operator_id: int | None = None
    note: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)


class TransitionOut(BaseModel):
    order_id: int
    from_status: OrderStatus
    to_status: OrderStatus
    changed: bool


class DemandParseIn(BaseModel):
    text: str
    buyer_id: int | None = None


class DemandParseOut(BaseModel):
    task_id: str
    work_type: str
    area_mu: float
    budget_range: str
    urgency_level: str
    quality_constraints: str
    schedule_hint: str
    raw_text: str


class DispatchProposalIn(BaseModel):
    order_id: int
    auto_transition: bool = False


class CandidateOut(BaseModel):
    machine_id: int
    owner_id: int
    owner_name: str = ""
    owner_rating: float = 0
    machine_type: str = ""
    score: float
    distance_km: float
    eta_minutes: int = 0
    availability_score: float
    capacity_score: float = 0
    capacity_hours: float = 0
    health_score: float = 0
    reputation_score: float
    price_score: float
    price_per_mu: float = 0
    weather_risk_score: float
    weather_gap_level: str = ""
    weather_action_hint: str = ""
    score_breakdown: dict[str, Any] = Field(default_factory=dict)
    reason_tags: list[str] = Field(default_factory=list)
    composite_reason: str = ""


class DispatchProposalOut(BaseModel):
    order_id: int
    selected_machine_id: int | None
    confidence: float
    reason: str
    need_human_approval: bool
    candidates: list[CandidateOut]
    weather_summary: dict[str, Any] = Field(default_factory=dict)
    mode: str = "dispatch"


class ExceptionHandleIn(BaseModel):
    order_id: int
    event_type: str
    description: str = ""
    auto_transition: bool = False


class ExceptionHandleOut(BaseModel):
    order_id: int
    event_type: str
    action_type: str
    suggested_status: OrderStatus
    replacement_machine_id: int | None
    reason: str
    need_human_approval: bool
    proposal: dict[str, Any] = Field(default_factory=dict)


class ExplainIn(BaseModel):
    decision_type: str
    audience: str = "buyer"
    payload: dict[str, Any] = Field(default_factory=dict)


class ExplainOut(BaseModel):
    说明: str


class WeatherHourlyOut(BaseModel):
    time: str
    precipitation_probability: float
    precipitation: float
    weather_code: int
    weather_text: str
    wind_speed_10m: float


class WeatherCurrentOut(BaseModel):
    time: str | None = None
    temperature_2m: float
    apparent_temperature: float
    precipitation: float
    weather_code: int
    weather_text: str
    wind_speed_10m: float


class WeatherRiskOut(BaseModel):
    risk_level: str
    risk_score: float
    dispatch_penalty: float
    max_precip_probability: float
    max_precipitation: float
    max_wind_speed: float
    weather_code: int
    weather_text: str
    flags: list[str]
    recommendation: str


class WeatherMachineContextOut(BaseModel):
    machine_id: int
    machine_type: str
    distance_km: float
    current: WeatherCurrentOut
    risk: WeatherRiskOut
    gap_level: str
    comparison_text: str


class OrderWeatherOut(BaseModel):
    order_id: int
    provider: str
    target_lng: float
    target_lat: float
    current: WeatherCurrentOut
    hourly: list[WeatherHourlyOut]
    risk: WeatherRiskOut
    suggested_action: str
    suggested_reason: str
    machine_context: WeatherMachineContextOut | None = None


class WeatherDemoScenarioIn(BaseModel):
    target_scene: str = "severe_storm"
    machine_scene: str | None = "clear"
    apply_current_machine: bool = True
    clear_existing: bool = True
