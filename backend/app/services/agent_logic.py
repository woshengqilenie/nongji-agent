from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta
from statistics import median
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from ..models import DispatchLog, Machine, MachineStatus, Order, OrderStatus, ServiceSKU, User
from .weather_service import build_weather_adjusted_score, compare_weather_context, fetch_weather_snapshot

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")


def _schedule_has_signal(text: str) -> bool:
    return bool(
        re.search(
            r"(今天|今日|今早|今晚|明天|明早|明晚|后天|大后天|早上|早晨|上午|中午|下午|傍晚|晚上|凌晨|\d{1,2}\s*点|\d{1,2}\s*[:：]\s*\d{2}|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}日)",
            text,
        )
    )


def _schedule_period(text: str) -> str:
    if "凌晨" in text:
        return "凌晨"
    if re.search(r"(早上|早晨|上午)", text):
        return "早上"
    if "中午" in text:
        return "中午"
    if "下午" in text:
        return "下午"
    if "傍晚" in text:
        return "傍晚"
    if re.search(r"(晚上|今晚|明晚)", text):
        return "晚上"
    return ""


def _format_schedule_time(hour: int, minute: int = 0, preferred_period: str = "") -> str:
    period = preferred_period or ("凌晨" if hour < 6 else "早上" if hour < 12 else "中午" if hour == 12 else "下午" if hour < 18 else "傍晚" if hour < 19 else "晚上")
    display_hour = hour - 12 if period in {"下午", "傍晚", "晚上"} and hour > 12 else hour
    if minute:
        return f"{period}{display_hour}点{minute}分"
    return f"{period}{display_hour}点"


def _resolve_schedule_hint(text: str, now: datetime | None = None) -> str:
    if not text or not _schedule_has_signal(text):
        return ""

    current = now or datetime.now(SHANGHAI_TZ)
    if current.tzinfo is None:
        current = current.replace(tzinfo=SHANGHAI_TZ)
    else:
        current = current.astimezone(SHANGHAI_TZ)

    explicit_full = re.search(r"(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?", text)
    explicit_month_day = re.search(r"(\d{1,2})月(\d{1,2})日", text)
    base_day = current.replace(hour=0, minute=0, second=0, microsecond=0)

    if explicit_full:
        base_day = base_day.replace(
            year=int(explicit_full.group(1)),
            month=int(explicit_full.group(2)),
            day=int(explicit_full.group(3)),
        )
    elif explicit_month_day:
        base_day = base_day.replace(
            month=int(explicit_month_day.group(1)),
            day=int(explicit_month_day.group(2)),
        )
    elif "大后天" in text:
        base_day += timedelta(days=3)
    elif "后天" in text:
        base_day += timedelta(days=2)
    elif re.search(r"(明天|明早|明晚)", text):
        base_day += timedelta(days=1)

    preferred_period = _schedule_period(text)
    explicit_colon = re.search(r"(\d{1,2})\s*[:：]\s*(\d{2})", text)
    explicit_hour = re.search(r"(?:(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)\s*)?(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?", text)

    if explicit_colon:
        hour = max(0, min(23, int(explicit_colon.group(1))))
        minute = max(0, min(59, int(explicit_colon.group(2))))
        label = _format_schedule_time(hour, minute, preferred_period)
    elif explicit_hour:
        explicit_period = _schedule_period(explicit_hour.group(1) or "") or preferred_period
        hour = max(0, min(23, int(explicit_hour.group(2))))
        minute = 30 if explicit_hour.group(3) == "半" else max(0, min(59, int(explicit_hour.group(4)))) if explicit_hour.group(4) else 0
        if explicit_period in {"下午", "傍晚", "晚上"} and hour < 12:
            hour += 12
        elif explicit_period == "中午" and hour < 11:
            hour = 12
        label = _format_schedule_time(hour, minute, explicit_period)
    else:
        defaults = {
            "凌晨": 5,
            "早上": 8,
            "中午": 12,
            "下午": 14,
            "傍晚": 18,
            "晚上": 19,
        }
        hour = defaults.get(preferred_period or "早上", 8)
        minute = 0
        label = _format_schedule_time(hour, minute, preferred_period or "早上")

    return f"{base_day.strftime('%Y-%m-%d')} {label}"


def parse_demand_text(text: str, now: datetime | None = None) -> dict[str, Any]:
    work_type = "harvest"
    if "播" in text:
        work_type = "seeding"
    elif "耕" in text:
        work_type = "tillage"
    elif "植保" in text or "喷" in text:
        work_type = "protection"
    elif "收" in text:
        work_type = "harvest"

    area_match = re.search(r"(\d+(?:\.\d+)?)\s*亩", text)
    area_mu = float(area_match.group(1)) if area_match else 100.0

    budget_match = re.search(r"预算[^\d]*(\d+(?:\.\d+)?)", text)
    budget = budget_match.group(1) if budget_match else "unknown"

    urgency_level = "high" if any(k in text for k in ["紧急", "马上", "今天", "抢收"]) else "medium"

    quality_constraints = ""
    if "损失率" in text:
        quality_constraints = "loss-rate constrained"

    current = now or datetime.now(SHANGHAI_TZ)
    if current.tzinfo is None:
        current = current.replace(tzinfo=SHANGHAI_TZ)
    else:
        current = current.astimezone(SHANGHAI_TZ)

    return {
        "task_id": f"TASK-{current.strftime('%Y%m%d%H%M%S')}",
        "work_type": work_type,
        "area_mu": area_mu,
        "budget_range": budget,
        "urgency_level": urgency_level,
        "quality_constraints": quality_constraints,
        "schedule_hint": _resolve_schedule_hint(text, now=current),
        "raw_text": text,
    }


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _availability_score(status: MachineStatus) -> float:
    if status == MachineStatus.idle:
        return 100.0
    if status == MachineStatus.busy:
        return 35.0
    return 0.0


def _capacity_score(area_mu: float, capacity_mu_per_hour: float) -> tuple[float, float]:
    capacity = max(capacity_mu_per_hour, 1.0)
    estimated_hours = round(area_mu / capacity, 2)
    score = max(38.0, min(100.0, 108.0 - estimated_hours * 9.0))
    return round(score, 2), estimated_hours


def _eta_minutes(distance_km: float, status: MachineStatus) -> int:
    base_minutes = max(18, round((distance_km / 28.0) * 60))
    if status == MachineStatus.busy:
        base_minutes += 35
    elif status == MachineStatus.offline:
        base_minutes += 120
    return base_minutes


def _health_score(machine_health: int) -> float:
    return round(max(35.0, min(100.0, float(machine_health))), 2)


def _candidate_reason_parts(candidate: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    if float(candidate.get("distance_km", 0.0)) <= 20:
        reasons.append("距离近")
    if float(candidate.get("capacity_score", 0.0)) >= 78:
        reasons.append("履约效率高")
    if float(candidate.get("health_score", 0.0)) >= 88:
        reasons.append("机况稳")
    if float(candidate.get("reputation_score", 0.0)) >= 88:
        reasons.append("机主口碑好")
    if float(candidate.get("price_score", 0.0)) >= 88:
        reasons.append("报价有竞争力")
    if float(candidate.get("weather_risk_score", 0.0)) >= 82:
        reasons.append("天气风险低")
    return reasons[:3] or ["综合得分均衡"]


def build_dispatch_proposal(
    db: Session,
    order: Order,
    exclude_machine_id: int | None = None,
    weather_summary: dict[str, Any] | None = None,
    target_weather_snapshot: dict[str, Any] | None = None,
    mode: str = "dispatch",
) -> dict[str, Any]:
    sku = db.get(ServiceSKU, order.sku_id)
    if not sku:
        return {
            "selected_machine_id": None,
            "confidence": 0.0,
            "reason": "未找到服务SKU，无法生成派单建议",
            "need_human_approval": True,
            "candidates": [],
        }

    skus = db.query(ServiceSKU).filter(ServiceSKU.work_type == sku.work_type, ServiceSKU.is_active == 1).all()
    unit_prices = [s.unit_price for s in skus] or [sku.unit_price]
    price_median = median(unit_prices)
    weather_cache: dict[tuple[float, float], dict[str, Any]] = {}

    candidates = []
    weights = {
        "dispatch": {
            "distance": 0.2,
            "availability": 0.18,
            "capacity": 0.15,
            "health": 0.13,
            "reputation": 0.14,
            "price": 0.1,
            "weather": 0.1,
        },
        "reassign": {
            "distance": 0.24,
            "availability": 0.22,
            "capacity": 0.18,
            "health": 0.12,
            "reputation": 0.1,
            "price": 0.04,
            "weather": 0.1,
        },
    }.get(mode, None) or {
        "distance": 0.2,
        "availability": 0.18,
        "capacity": 0.15,
        "health": 0.13,
        "reputation": 0.14,
        "price": 0.1,
        "weather": 0.1,
    }
    for item in skus:
        machine = db.get(Machine, item.machine_id)
        if not machine:
            continue
        if machine.status == MachineStatus.offline:
            continue
        if exclude_machine_id and machine.id == exclude_machine_id:
            continue

        owner = db.get(User, machine.owner_id)
        owner_rating = owner.rating if owner else 4.0

        if order.target_lat is not None and order.target_lng is not None:
            distance_km = _haversine_km(order.target_lat, order.target_lng, machine.lat, machine.lng)
        else:
            distance_km = 12.0

        source_weather_snapshot = None
        source_weather_risk = None
        if target_weather_snapshot:
            key = (round(machine.lng, 3), round(machine.lat, 3))
            source_weather_snapshot = weather_cache.get(key)
            if source_weather_snapshot is None:
                try:
                    source_weather_snapshot = fetch_weather_snapshot(machine.lng, machine.lat, forecast_for=order.schedule_start)
                except Exception:
                    source_weather_snapshot = {}
                weather_cache[key] = source_weather_snapshot
            source_weather_risk = source_weather_snapshot.get("risk", {})

        distance_score = max(0.0, 100.0 - distance_km * 2.0)
        availability_score = _availability_score(machine.status)
        capacity_score, capacity_hours = _capacity_score(order.area_mu, machine.capacity_mu_per_hour)
        health_score = _health_score(machine.health_score)
        reputation_score = max(0.0, min(100.0, owner_rating * 20.0))
        price_score = max(0.0, min(100.0, 100.0 - ((item.unit_price - price_median) / max(price_median, 1.0)) * 50.0))
        weather_risk_score = build_weather_adjusted_score(
            machine.machine_type,
            machine.health_score,
            distance_km,
            weather_summary,
            source_weather_risk,
        )
        weather_context = compare_weather_context(source_weather_snapshot, target_weather_snapshot, distance_km) if target_weather_snapshot else {}
        eta_minutes = _eta_minutes(distance_km, machine.status)

        total = (
            weights["distance"] * distance_score
            + weights["availability"] * availability_score
            + weights["capacity"] * capacity_score
            + weights["health"] * health_score
            + weights["reputation"] * reputation_score
            + weights["price"] * price_score
            + weights["weather"] * weather_risk_score
        )
        candidate = {
            "machine_id": machine.id,
            "owner_id": machine.owner_id,
            "owner_name": owner.name if owner else f"机主#{machine.owner_id}",
            "owner_rating": round(owner_rating, 2),
            "machine_type": machine.machine_type,
            "score": round(total, 2),
            "distance_km": round(distance_km, 2),
            "eta_minutes": eta_minutes,
            "availability_score": round(availability_score, 2),
            "capacity_score": round(capacity_score, 2),
            "capacity_hours": capacity_hours,
            "health_score": health_score,
            "reputation_score": round(reputation_score, 2),
            "price_score": round(price_score, 2),
            "price_per_mu": item.unit_price,
            "weather_risk_score": round(weather_risk_score, 2),
            "weather_gap_level": weather_context.get("gap_level", ""),
            "weather_action_hint": weather_context.get("suggested_action", ""),
            "score_breakdown": {
                "distance": round(distance_score, 2),
                "availability": round(availability_score, 2),
                "capacity": round(capacity_score, 2),
                "health": round(health_score, 2),
                "reputation": round(reputation_score, 2),
                "price": round(price_score, 2),
                "weather": round(weather_risk_score, 2),
            },
        }
        candidate["reason_tags"] = _candidate_reason_parts(candidate)
        candidate["composite_reason"] = "、".join(candidate["reason_tags"])
        candidates.append(candidate)

    candidates.sort(key=lambda x: x["score"], reverse=True)
    selected = candidates[0] if candidates else None

    reason = "暂无可用农机"
    confidence = 0.0
    selected_machine_id = None
    if selected:
        selected_machine_id = selected["machine_id"]
        confidence = min(0.99, round(selected["score"] / 100.0, 2))
        reason = f"综合距离、可用性、履约效率、机况和天气风险后，{selected['composite_reason']}，得分最高"

    return {
        "selected_machine_id": selected_machine_id,
        "confidence": confidence,
        "reason": reason,
        "need_human_approval": True,
        "candidates": candidates[:5],
        "weather_summary": weather_summary or {},
        "mode": mode,
    }


def create_dispatch_log(db: Session, order_id: int, payload: dict[str, Any], agent: str) -> DispatchLog:
    log = DispatchLog(
        order_id=order_id,
        selected_machine_id=payload.get("selected_machine_id"),
        agent=agent,
        score_breakdown_json=json.dumps(payload.get("candidates", []), ensure_ascii=False),
        reason=payload.get("reason", ""),
        need_human_approval=1 if payload.get("need_human_approval", True) else 0,
        approval_status="pending",
    )
    db.add(log)
    db.flush()
    return log


def handle_exception(db: Session, order: Order, event_type: str, description: str = "") -> dict[str, Any]:
    event = event_type.lower()
    if event in {"fault", "weather", "timeout", "user_change"}:
        target_weather_snapshot = None
        weather_summary: dict[str, Any] = {}
        assigned_weather_action = ""
        assigned_weather_reason = ""
        if event == "weather" and order.target_lng is not None and order.target_lat is not None:
            try:
                target_weather_snapshot = fetch_weather_snapshot(order.target_lng, order.target_lat, forecast_for=order.schedule_start)
                weather_summary = target_weather_snapshot.get("risk", {})
            except Exception:
                target_weather_snapshot = None
                weather_summary = {}

            if target_weather_snapshot and order.machine_id:
                machine = db.get(Machine, order.machine_id)
                if machine:
                    try:
                        source_snapshot = fetch_weather_snapshot(machine.lng, machine.lat, forecast_for=order.schedule_start)
                        comparison = compare_weather_context(
                            source_snapshot,
                            target_weather_snapshot,
                            _haversine_km(order.target_lat, order.target_lng, machine.lat, machine.lng),
                        )
                        assigned_weather_action = str(comparison.get("suggested_action", ""))
                        assigned_weather_reason = str(comparison.get("suggested_reason", ""))
                    except Exception:
                        assigned_weather_action = ""
                        assigned_weather_reason = ""

        proposal = build_dispatch_proposal(
            db,
            order,
            exclude_machine_id=order.machine_id,
            weather_summary=weather_summary,
            target_weather_snapshot=target_weather_snapshot,
            mode="reassign",
        )
        replacement = proposal.get("selected_machine_id")
        reason = f"event={event}; {description}".strip()
        action_type = "reassign" if replacement else "pause"
        suggested_status = OrderStatus.REASSIGN_PROPOSED if replacement else OrderStatus.ABNORMAL_PENDING
        if event == "weather" and weather_summary.get("risk_level") == "high":
            action_type = "refund"
            suggested_status = OrderStatus.ABNORMAL_PENDING
            replacement = None
            reason = f"{reason}; 目的地作业时段天气高风险，建议取消并退款".strip("; ")
        elif event == "weather":
            if assigned_weather_action == "reassign":
                if replacement:
                    action_type = "reassign"
                    suggested_status = OrderStatus.REASSIGN_PROPOSED
                    reason = f"{reason}; {assigned_weather_reason}".strip("; ")
                else:
                    action_type = "pause"
                    suggested_status = OrderStatus.ABNORMAL_PENDING
                    reason = f"{reason}; 目的地天气转差但暂无更优替补，建议暂停等待".strip("; ")
            elif assigned_weather_action in {"pause", "watch"}:
                action_type = "pause"
                suggested_status = OrderStatus.ABNORMAL_PENDING
                replacement = None
                if assigned_weather_reason:
                    reason = f"{reason}; {assigned_weather_reason}".strip("; ")
        return {
            "order_id": order.id,
            "event_type": event_type,
            "action_type": action_type,
            "suggested_status": suggested_status,
            "replacement_machine_id": replacement,
            "reason": reason,
            "need_human_approval": True,
            "proposal": proposal,
        }

    return {
        "order_id": order.id,
        "event_type": event_type,
        "action_type": "observe",
        "suggested_status": OrderStatus.ABNORMAL_PENDING,
        "replacement_machine_id": None,
        "reason": "不支持的异常类型",
        "need_human_approval": True,
        "proposal": {"selected_machine_id": None, "candidates": []},
    }


def explain_decision(decision_type: str, audience: str, payload: dict[str, Any]) -> str:
    if decision_type == "dispatch":
        machine_id = payload.get("selected_machine_id")
        score = payload.get("confidence")
        candidates = payload.get("candidates", [])
        top_reason = ""
        if candidates:
            top_reason = str(candidates[0].get("composite_reason", ""))
        if audience == "dispatcher":
            return f"派单建议选择农机 {machine_id}，置信度 {score}。核心优势是 {top_reason or '综合评分最高'}，请审核后确认。"
        if audience == "owner":
            return f"你被选中是因为当前综合评分在候选中最高，主要优势为 {top_reason or '机况和履约效率较好'}。"
        return f"系统推荐农机 {machine_id}。该方案在距离、响应速度、机况和天气风险之间取得了较好平衡。"

    if decision_type == "exception":
        action = payload.get("action_type")
        return f"异常处理建议执行动作“{action}”，执行前需要人工确认。"

    return "当前决策类型暂无可用解释。"
