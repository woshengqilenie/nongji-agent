from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Machine, Order
from ..schemas import OrderWeatherOut, WeatherDemoScenarioIn
from ..services.weather_service import (
    build_demo_weather_snapshot,
    clear_all_weather_overrides,
    clear_weather_override,
    compare_weather_context,
    fetch_weather_snapshot,
    set_weather_override,
)

router = APIRouter(prefix="/weather", tags=["weather"])


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    from math import atan2, cos, radians, sin, sqrt

    radius = 6371.0
    phi1 = radians(lat1)
    phi2 = radians(lat2)
    dphi = radians(lat2 - lat1)
    dlambda = radians(lng2 - lng1)
    a = sin(dphi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(dlambda / 2) ** 2
    return 2 * radius * atan2(sqrt(a), sqrt(1 - a))


@router.get("/point")
def get_point_weather(lng: float, lat: float) -> dict:
    snapshot = fetch_weather_snapshot(lng, lat)
    return {
        "target_lng": float(lng),
        "target_lat": float(lat),
        "provider": snapshot["provider"],
        "current": snapshot["current"],
        "hourly": snapshot["hourly"],
        "risk": snapshot["risk"],
    }


@router.get("/order/{order_id}", response_model=OrderWeatherOut)
def get_order_weather(order_id: int, db: Session = Depends(get_db)) -> dict:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    if order.target_lng is None or order.target_lat is None:
        raise HTTPException(status_code=400, detail="当前订单缺少目的地经纬度，无法查询天气")

    snapshot = fetch_weather_snapshot(order.target_lng, order.target_lat, forecast_for=order.schedule_start)
    machine_context = None
    suggested_action = "continue"
    suggested_reason = snapshot["risk"]["recommendation"]

    if order.machine_id:
        machine = db.get(Machine, order.machine_id)
        if machine:
            try:
                machine_snapshot = fetch_weather_snapshot(machine.lng, machine.lat, forecast_for=order.schedule_start)
            except Exception:
                machine_snapshot = None

            if machine_snapshot:
                distance_km = round(_haversine_km(order.target_lat, order.target_lng, machine.lat, machine.lng), 2)
                comparison = compare_weather_context(machine_snapshot, snapshot, distance_km=distance_km)
                machine_context = {
                    "machine_id": machine.id,
                    "machine_type": machine.machine_type,
                    "distance_km": distance_km,
                    "current": machine_snapshot["current"],
                    "risk": machine_snapshot["risk"],
                    "gap_level": comparison["gap_level"],
                    "comparison_text": comparison["comparison_text"],
                }
                suggested_action = comparison["suggested_action"]
                suggested_reason = comparison["suggested_reason"]

    return {
        "order_id": order.id,
        "provider": snapshot["provider"],
        "target_lng": float(order.target_lng),
        "target_lat": float(order.target_lat),
        "current": snapshot["current"],
        "hourly": snapshot["hourly"],
        "risk": snapshot["risk"],
        "suggested_action": suggested_action,
        "suggested_reason": suggested_reason,
        "machine_context": machine_context,
    }


@router.post("/demo/order/{order_id}/scenario")
def apply_demo_weather_scenario(order_id: int, data: WeatherDemoScenarioIn, db: Session = Depends(get_db)) -> dict:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")
    if order.target_lng is None or order.target_lat is None:
        raise HTTPException(status_code=400, detail="当前订单缺少目的地经纬度，无法设置演示天气")

    target_snapshot = build_demo_weather_snapshot(data.target_scene, forecast_for=order.schedule_start)
    if data.clear_existing:
        clear_weather_override(order.target_lng, order.target_lat)

    set_weather_override(order.target_lng, order.target_lat, target_snapshot)
    machine_payload = None

    if data.apply_current_machine and order.machine_id:
        machine = db.get(Machine, order.machine_id)
        if machine:
            if data.machine_scene:
                machine_snapshot = build_demo_weather_snapshot(data.machine_scene, forecast_for=order.schedule_start)
                if data.clear_existing:
                    clear_weather_override(machine.lng, machine.lat)
                set_weather_override(machine.lng, machine.lat, machine_snapshot)
                machine_payload = {
                    "machine_id": machine.id,
                    "scene": data.machine_scene,
                    "lng": machine.lng,
                    "lat": machine.lat,
                }
            else:
                clear_weather_override(machine.lng, machine.lat)

    return {
        "order_id": order.id,
        "target": {
            "scene": data.target_scene,
            "lng": order.target_lng,
            "lat": order.target_lat,
            "provider": target_snapshot["provider"],
            "risk_level": target_snapshot["risk"]["risk_level"],
        },
        "machine": machine_payload,
    }


@router.delete("/demo/order/{order_id}/scenario")
def clear_demo_weather_scenario(order_id: int, db: Session = Depends(get_db)) -> dict:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="未找到订单")

    cleared = 0
    if order.target_lng is not None and order.target_lat is not None:
        cleared += 1 if clear_weather_override(order.target_lng, order.target_lat) else 0

    if order.machine_id:
        machine = db.get(Machine, order.machine_id)
        if machine:
            cleared += 1 if clear_weather_override(machine.lng, machine.lat) else 0

    return {"order_id": order.id, "cleared": cleared}


@router.delete("/demo/overrides")
def clear_demo_weather_overrides() -> dict:
    return {"cleared": clear_all_weather_overrides()}
