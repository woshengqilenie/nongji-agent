from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timedelta
import logging
import os
from typing import Any
from zoneinfo import ZoneInfo

import httpx

OPEN_METEO_FORECAST_URL = os.getenv("OPEN_METEO_FORECAST_URL", "https://api.open-meteo.com/v1/forecast")
WEATHER_OVERRIDE_STORE: dict[str, dict[str, Any]] = {}
SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
logger = logging.getLogger(__name__)

WEATHER_CODE_LABELS = {
    0: "晴朗",
    1: "大部晴朗",
    2: "局部多云",
    3: "阴天",
    45: "有雾",
    48: "冻雾",
    51: "小毛雨",
    53: "毛雨",
    55: "强毛雨",
    56: "冻毛雨",
    57: "强冻毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "冻雨",
    67: "强冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "冰粒",
    80: "小阵雨",
    81: "阵雨",
    82: "强阵雨",
    85: "小阵雪",
    86: "强阵雪",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴强冰雹",
}

SEVERE_CODES = {65, 67, 75, 82, 86, 95, 96, 99}
RAIN_CODES = {51, 53, 55, 56, 57, 61, 63, 66, 80, 81}
WIND_SENSITIVE_MACHINE_TYPES = {"植保机"}


def _coord_key(lng: float, lat: float) -> str:
    return f"{round(float(lng), 4):.4f}:{round(float(lat), 4):.4f}"


def set_weather_override(lng: float, lat: float, snapshot: dict[str, Any]) -> dict[str, Any]:
    WEATHER_OVERRIDE_STORE[_coord_key(lng, lat)] = deepcopy(snapshot)
    return deepcopy(snapshot)


def get_weather_override(lng: float, lat: float) -> dict[str, Any] | None:
    snapshot = WEATHER_OVERRIDE_STORE.get(_coord_key(lng, lat))
    return deepcopy(snapshot) if snapshot else None


def clear_weather_override(lng: float, lat: float) -> bool:
    return WEATHER_OVERRIDE_STORE.pop(_coord_key(lng, lat), None) is not None


def clear_all_weather_overrides() -> int:
    count = len(WEATHER_OVERRIDE_STORE)
    WEATHER_OVERRIDE_STORE.clear()
    return count


def _demo_weather_base_time(forecast_for: date | datetime | None = None) -> datetime:
    if isinstance(forecast_for, datetime):
        base = forecast_for.astimezone(SHANGHAI_TZ) if forecast_for.tzinfo else forecast_for
    elif isinstance(forecast_for, date):
        base = datetime.combine(forecast_for, datetime.min.time().replace(hour=8))
    else:
        base = datetime.now(SHANGHAI_TZ)
    return base.replace(second=0, microsecond=0)


def _demo_hourly_series(base_time: datetime, template: dict[str, Any], count: int = 24) -> list[dict[str, Any]]:
    hourly: list[dict[str, Any]] = []
    for idx in range(count):
        item = deepcopy(template)
        item["time"] = (base_time + timedelta(hours=idx * 3)).strftime("%Y-%m-%dT%H:%M")
        hourly.append(item)
    return hourly


def build_demo_weather_snapshot(scene: str, forecast_for: date | datetime | None = None) -> dict[str, Any]:
    normalized = str(scene or "").strip().lower()
    base_time = _demo_weather_base_time(forecast_for)
    current_time = base_time.strftime("%Y-%m-%dT%H:%M")

    if normalized == "clear":
        hourly_template = {
            "time": current_time,
            "precipitation_probability": 5.0,
            "precipitation": 0.0,
            "weather_code": 0,
            "weather_text": "晴朗",
            "wind_speed_10m": 12.0,
        }
        return {
            "provider": "demo-weather",
            "current": {
                "time": current_time,
                "temperature_2m": 24.0,
                "apparent_temperature": 24.0,
                "precipitation": 0.0,
                "weather_code": 0,
                "weather_text": "晴朗",
                "wind_speed_10m": 11.0,
            },
            "hourly": _demo_hourly_series(base_time, hourly_template),
            "risk": {
                "risk_level": "low",
                "risk_score": 8.0,
                "dispatch_penalty": 6.0,
                "max_precip_probability": 5.0,
                "max_precipitation": 0.0,
                "max_wind_speed": 12.0,
                "weather_code": 0,
                "weather_text": "晴朗",
                "flags": [],
                "recommendation": "天气整体可接受，可按常规规则派单。",
            },
        }
    if normalized == "watch_rain":
        hourly_template = {
            "time": current_time,
            "precipitation_probability": 72.0,
            "precipitation": 4.0,
            "weather_code": 63,
            "weather_text": "中雨",
            "wind_speed_10m": 24.0,
        }
        return {
            "provider": "demo-weather",
            "current": {
                "time": current_time,
                "temperature_2m": 21.0,
                "apparent_temperature": 21.0,
                "precipitation": 1.8,
                "weather_code": 63,
                "weather_text": "中雨",
                "wind_speed_10m": 22.0,
            },
            "hourly": _demo_hourly_series(base_time, hourly_template),
            "risk": {
                "risk_level": "medium",
                "risk_score": 48.0,
                "dispatch_penalty": 18.0,
                "max_precip_probability": 72.0,
                "max_precipitation": 4.0,
                "max_wind_speed": 24.0,
                "weather_code": 63,
                "weather_text": "中雨",
                "flags": ["降水概率高", "未来6小时可能出现明显降水"],
                "recommendation": "天气存在波动，建议优先近距离、健康分较高的农机。",
            },
        }
    if normalized in {"severe_rain", "severe_storm"}:
        weather_code = 95 if normalized == "severe_storm" else 65
        weather_text = "雷暴" if normalized == "severe_storm" else "大雨"
        wind_speed = 58.0 if normalized == "severe_storm" else 42.0
        hourly_template = {
            "time": current_time,
            "precipitation_probability": 96.0,
            "precipitation": 14.0,
            "weather_code": weather_code,
            "weather_text": weather_text,
            "wind_speed_10m": wind_speed,
        }
        return {
            "provider": "demo-weather",
            "current": {
                "time": current_time,
                "temperature_2m": 18.0,
                "apparent_temperature": 17.0,
                "precipitation": 9.5,
                "weather_code": weather_code,
                "weather_text": weather_text,
                "wind_speed_10m": 56.0 if normalized == "severe_storm" else 38.0,
            },
            "hourly": _demo_hourly_series(base_time, hourly_template),
            "risk": {
                "risk_level": "high",
                "risk_score": 88.0 if normalized == "severe_storm" else 78.0,
                "dispatch_penalty": 34.0,
                "max_precip_probability": 96.0,
                "max_precipitation": 14.0,
                "max_wind_speed": wind_speed,
                "weather_code": weather_code,
                "weather_text": weather_text,
                "flags": ["降水概率高", "未来6小时可能出现大雨", "风力较强", "存在雷暴风险"]
                if normalized == "severe_storm"
                else ["降水概率高", "未来6小时可能出现大雨", "风力较强"],
                "recommendation": "天气风险高，建议暂停派单或等待窗口改善。",
            },
        }

    raise ValueError(f"不支持的演示天气场景: {scene}")


def build_fallback_weather_snapshot(reason: str = "") -> dict[str, Any]:
    snapshot = build_demo_weather_snapshot("clear")
    now = datetime.now(SHANGHAI_TZ).replace(minute=0, second=0, microsecond=0)
    current = snapshot["current"]
    current["time"] = now.strftime("%Y-%m-%dT%H:%M")

    hourly: list[dict[str, Any]] = []
    for offset in range(1, 7):
        item = deepcopy(snapshot["hourly"][0])
        item["time"] = (now + timedelta(hours=offset)).strftime("%Y-%m-%dT%H:%M")
        hourly.append(item)

    snapshot["provider"] = "weather-fallback"
    snapshot["hourly"] = hourly
    snapshot["risk"]["flags"] = ["外部天气服务不可用", "已使用平台兜底天气"]
    snapshot["risk"]["recommendation"] = "外部天气暂不可用，已切换为平台兜底天气，请结合地图与人工判断。"
    if reason:
        snapshot["fallback_reason"] = reason
    return snapshot


def weather_code_label(code: int | None) -> str:
    if code is None:
        return "未知"
    return WEATHER_CODE_LABELS.get(int(code), f"天气码 {code}")


def risk_level_rank(level: str | None) -> int:
    return {"low": 1, "medium": 2, "high": 3}.get(str(level or "").lower(), 0)


def assess_weather_risk(snapshot: dict[str, Any]) -> dict[str, Any]:
    current = snapshot.get("current", {})
    hourly = snapshot.get("hourly", [])

    max_precip_probability = max((float(item.get("precipitation_probability", 0.0)) for item in hourly), default=0.0)
    max_precipitation = max((float(item.get("precipitation", 0.0)) for item in hourly), default=0.0)
    max_wind_speed = max((float(item.get("wind_speed_10m", 0.0)) for item in hourly), default=float(current.get("wind_speed_10m", 0.0)))
    worst_code = max(
        [int(current.get("weather_code", 0))]
        + [int(item.get("weather_code", 0)) for item in hourly],
        key=lambda code: (
            3 if code in {95, 96, 99} else 2 if code in SEVERE_CODES else 1 if code in RAIN_CODES else 0,
            code,
        ),
    )

    score = 0.0
    flags: list[str] = []

    if max_precip_probability >= 70:
        score += 22
        flags.append("降水概率高")
    elif max_precip_probability >= 40:
        score += 10

    if max_precipitation >= 8:
        score += 28
        flags.append("未来6小时可能出现大雨")
    elif max_precipitation >= 3:
        score += 14
        flags.append("未来6小时可能出现明显降水")

    if max_wind_speed >= 50:
        score += 25
        flags.append("风力较强")
    elif max_wind_speed >= 35:
        score += 12

    if worst_code in {95, 96, 99}:
        score += 30
        flags.append("存在雷暴风险")
    elif worst_code in SEVERE_CODES:
        score += 18
    elif worst_code in RAIN_CODES:
        score += 8

    risk_score = min(100.0, round(score, 2))
    if risk_score >= 70:
        risk_level = "high"
        recommendation = "作业天气风险高，建议取消订单并退款，避免农机空跑和作业损失。"
        dispatch_penalty = 34.0
    elif risk_score >= 35:
        risk_level = "medium"
        recommendation = "天气存在波动，建议优先近距离、健康分较高的农机。"
        dispatch_penalty = 18.0
    else:
        risk_level = "low"
        recommendation = "天气整体可接受，可按常规规则派单。"
        dispatch_penalty = 6.0

    return {
        "risk_level": risk_level,
        "risk_score": risk_score,
        "dispatch_penalty": dispatch_penalty,
        "max_precip_probability": round(max_precip_probability, 2),
        "max_precipitation": round(max_precipitation, 2),
        "max_wind_speed": round(max_wind_speed, 2),
        "weather_code": worst_code,
        "weather_text": weather_code_label(worst_code),
        "flags": flags,
        "recommendation": recommendation,
    }


def _forecast_date_value(value: date | datetime | None) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(SHANGHAI_TZ).date() if value.tzinfo else value.date()
    return value


def _sample_every_three_hours(hourly: list[dict[str, Any]], limit: int = 24) -> list[dict[str, Any]]:
    if not hourly:
        return []
    sampled: list[dict[str, Any]] = []
    for item in hourly:
        try:
            hour = datetime.fromisoformat(str(item["time"])).hour
        except (KeyError, ValueError):
            continue
        if hour % 3 == 0:
            sampled.append(item)
    return (sampled or hourly[::3])[:limit]


def _select_hourly_window(
    hourly: list[dict[str, Any]],
    forecast_for: date | datetime | None,
    window_hours: int = 8,
) -> list[dict[str, Any]]:
    if not hourly:
        return []
    if forecast_for is None:
        return hourly[:6]
    if isinstance(forecast_for, datetime):
        target_dt = forecast_for.astimezone(SHANGHAI_TZ) if forecast_for.tzinfo else forecast_for
    else:
        target_dt = datetime.combine(forecast_for, datetime.min.time().replace(hour=8))
    parsed: list[tuple[datetime, dict[str, Any]]] = []
    for item in hourly:
        try:
            parsed.append((datetime.fromisoformat(str(item["time"])), item))
        except (KeyError, ValueError):
            continue
    if not parsed:
        return hourly[:6]
    start_idx = min(range(len(parsed)), key=lambda idx: abs((parsed[idx][0] - target_dt).total_seconds()))
    return [item for _, item in parsed[start_idx : start_idx + window_hours]] or hourly[:6]


def _current_from_hourly(hourly_item: dict[str, Any]) -> dict[str, Any]:
    weather_code = int(hourly_item.get("weather_code", 0))
    return {
        "time": hourly_item.get("time"),
        "temperature_2m": float(hourly_item.get("temperature_2m", 0.0)),
        "apparent_temperature": float(hourly_item.get("apparent_temperature", hourly_item.get("temperature_2m", 0.0))),
        "precipitation": float(hourly_item.get("precipitation", 0.0)),
        "weather_code": weather_code,
        "weather_text": weather_code_label(weather_code),
        "wind_speed_10m": float(hourly_item.get("wind_speed_10m", 0.0)),
    }


def fetch_weather_snapshot(lng: float, lat: float, forecast_for: date | datetime | None = None) -> dict[str, Any]:
    override = get_weather_override(lng, lat)
    if override:
        return override

    forecast_date = _forecast_date_value(forecast_for)
    params = {
        "latitude": lat,
        "longitude": lng,
        "current": "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
        "hourly": "temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m",
        "forecast_days": 3,
        "timezone": "Asia/Shanghai",
        "wind_speed_unit": "kmh",
    }
    if forecast_date:
        date_text = forecast_date.isoformat()
        params["start_date"] = date_text
        params["end_date"] = (forecast_date + timedelta(days=2)).isoformat()
        params.pop("forecast_days", None)
    try:
        with httpx.Client(timeout=httpx.Timeout(8.0, connect=3.0), trust_env=False) as client:
            resp = client.get(OPEN_METEO_FORECAST_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        logger.warning(
            "weather fetch failed for lng=%s lat=%s, falling back to local snapshot: %s",
            lng,
            lat,
            exc,
        )
        return build_fallback_weather_snapshot(str(exc))

    hourly_raw = data.get("hourly", {})
    times = list(hourly_raw.get("time", []))
    hourly: list[dict[str, Any]] = []
    for idx, ts in enumerate(times):
        weather_code = int((hourly_raw.get("weather_code", []) or [0])[idx])
        hourly.append(
            {
                "time": ts,
                "temperature_2m": float((hourly_raw.get("temperature_2m", []) or [0.0])[idx]),
                "apparent_temperature": float((hourly_raw.get("apparent_temperature", []) or [0.0])[idx]),
                "precipitation_probability": float((hourly_raw.get("precipitation_probability", []) or [0.0])[idx]),
                "precipitation": float((hourly_raw.get("precipitation", []) or [0.0])[idx]),
                "weather_code": weather_code,
                "weather_text": weather_code_label(weather_code),
                "wind_speed_10m": float((hourly_raw.get("wind_speed_10m", []) or [0.0])[idx]),
            }
        )

    selected_hourly = _select_hourly_window(hourly, forecast_for)
    display_hourly = _sample_every_three_hours(hourly)
    current_raw = data.get("current", {})
    current = (
        _current_from_hourly(selected_hourly[0])
        if forecast_for and selected_hourly
        else {
            "time": current_raw.get("time"),
            "temperature_2m": float(current_raw.get("temperature_2m", 0.0)),
            "apparent_temperature": float(current_raw.get("apparent_temperature", 0.0)),
            "precipitation": float(current_raw.get("precipitation", 0.0)),
            "weather_code": int(current_raw.get("weather_code", 0)),
            "weather_text": weather_code_label(current_raw.get("weather_code")),
            "wind_speed_10m": float(current_raw.get("wind_speed_10m", 0.0)),
        }
    )

    risk = assess_weather_risk({"current": current, "hourly": selected_hourly})
    return {
        "provider": "open-meteo",
        "current": current,
        "hourly": display_hourly,
        "risk": risk,
    }


def compare_weather_context(
    source_snapshot: dict[str, Any] | None,
    target_snapshot: dict[str, Any],
    distance_km: float,
) -> dict[str, Any]:
    target_risk = target_snapshot.get("risk", {})
    source_risk = (source_snapshot or {}).get("risk", {})
    target_score = float(target_risk.get("risk_score", 0.0))
    source_score = float(source_risk.get("risk_score", 0.0))
    gap = round(target_score - source_score, 2)

    if gap >= 25:
        gap_level = "target_much_worse"
        comparison_text = "农机出发地天气明显好于目的地，应以目的地作业风险为主。"
    elif gap >= 10:
        gap_level = "target_worse"
        comparison_text = "目的地天气差于农机出发地，远距离出车风险偏高。"
    elif gap <= -15:
        gap_level = "source_worse"
        comparison_text = "农机出发地天气更差，可能影响准时到达。"
    else:
        gap_level = "similar"
        comparison_text = "农机出发地与目的地天气差异不大。"

    suggested_action = "continue"
    suggested_reason = "天气整体可控，可继续按当前流程执行。"

    if risk_level_rank(target_risk.get("risk_level")) >= 3:
        suggested_action = "refund"
        suggested_reason = "目的地作业时段天气风险高，建议取消订单并退款，避免农机空跑和作业损失。"
    elif gap >= 25 and distance_km >= 20:
        suggested_action = "reassign"
        suggested_reason = "出发地天气优于目的地且路程较远，建议优先改派更靠近目的地的农机。"
    elif gap >= 10 and distance_km >= 40:
        suggested_action = "reassign"
        suggested_reason = "目的地天气正在变差，远距离农机接单风险升高，建议尝试本地替补。"
    elif risk_level_rank(target_risk.get("risk_level")) == 2:
        suggested_action = "watch"
        suggested_reason = "目的地有中等天气风险，建议谨慎执行并优先近距离农机。"

    return {
        "gap_score": gap,
        "gap_level": gap_level,
        "comparison_text": comparison_text,
        "suggested_action": suggested_action,
        "suggested_reason": suggested_reason,
    }


def build_weather_adjusted_score(
    machine_type: str,
    machine_health: int,
    distance_km: float,
    target_weather_risk: dict[str, Any] | None,
    source_weather_risk: dict[str, Any] | None = None,
) -> float:
    if not target_weather_risk:
        return 100.0

    penalty = float(target_weather_risk.get("dispatch_penalty", 0.0))
    adjusted_penalty = penalty * (1.0 if distance_km >= 40 else 0.7 if distance_km >= 20 else 0.45)

    if machine_health < 80:
        adjusted_penalty += 8.0
    if machine_type in WIND_SENSITIVE_MACHINE_TYPES and float(target_weather_risk.get("max_wind_speed", 0.0)) >= 35:
        adjusted_penalty += 35.0
    if machine_type in WIND_SENSITIVE_MACHINE_TYPES and float(target_weather_risk.get("max_precipitation", 0.0)) >= 3:
        adjusted_penalty += 20.0

    if source_weather_risk:
        gap = float(target_weather_risk.get("risk_score", 0.0)) - float(source_weather_risk.get("risk_score", 0.0))
        if gap >= 25 and distance_km >= 20:
            adjusted_penalty += 22.0
        elif gap >= 10 and distance_km >= 40:
            adjusted_penalty += 12.0
        elif gap <= -15:
            adjusted_penalty += 8.0

    return max(0.0, round(100.0 - adjusted_penalty, 2))
