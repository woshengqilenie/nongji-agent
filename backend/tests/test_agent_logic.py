from __future__ import annotations

import unittest
from datetime import UTC, datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base
from app.models import Machine, MachineStatus, Order, OrderStatus, ServiceSKU, User, UserRole
from app.services.agent_logic import build_dispatch_proposal, explain_decision, handle_exception, parse_demand_text


class AgentLogicTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(bind=self.engine, autocommit=False, autoflush=False, class_=Session)
        self.db = self.SessionLocal()
        self._seed_minimal_data()

    def tearDown(self) -> None:
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _seed_minimal_data(self) -> None:
        buyer = User(id=1, role=UserRole.buyer, name="BuyerA", phone="13800138000", rating=4.6, region="A")
        owner = User(id=11, role=UserRole.owner, name="OwnerA", phone="13900139000", rating=4.8, region="A")
        machine = Machine(
            id=1001,
            owner_id=11,
            machine_type="联合收割机",
            capacity_mu_per_hour=18,
            lng=119.12,
            lat=36.71,
            status=MachineStatus.idle,
            health_score=92,
        )
        backup_machine = Machine(
            id=1002,
            owner_id=11,
            machine_type="联合收割机",
            capacity_mu_per_hour=20,
            lng=119.128,
            lat=36.716,
            status=MachineStatus.idle,
            health_score=95,
        )
        sku = ServiceSKU(
            id=2001,
            owner_id=11,
            machine_id=1001,
            work_type="收割",
            title="小麦收割",
            unit="亩",
            unit_price=68,
            radius_km=30,
            min_area=50,
            is_active=1,
        )
        backup_sku = ServiceSKU(
            id=2002,
            owner_id=11,
            machine_id=1002,
            work_type="收割",
            title="应急收割",
            unit="亩",
            unit_price=70,
            radius_km=30,
            min_area=50,
            is_active=1,
        )
        order = Order(
            id=3001,
            order_no="OD_TEST_001",
            buyer_id=1,
            sku_id=2001,
            machine_id=1001,
            area_mu=120,
            amount=8160,
            status=OrderStatus.DISPATCH_CONFIRMED,
            urgency_level="high",
            quality_constraints="loss<=2%",
            schedule_start=datetime.now(UTC),
            schedule_end=datetime.now(UTC),
            target_lng=119.125,
            target_lat=36.715,
        )
        self.db.add_all([buyer, owner, machine, backup_machine, sku, backup_sku, order])
        self.db.commit()

    def test_parse_demand_text_extracts_area_and_work_type(self) -> None:
        result = parse_demand_text("明天上午收割300亩小麦，预算20000", now=datetime(2026, 4, 23, 9, 30, tzinfo=ZoneInfo("Asia/Shanghai")))
        self.assertEqual(result["work_type"], "harvest")
        self.assertEqual(result["area_mu"], 300.0)
        self.assertEqual(result["urgency_level"], "medium")
        self.assertEqual(result["schedule_hint"], "2026-04-24 早上8点")

    def test_parse_demand_text_resolves_day_after_tomorrow_to_concrete_time(self) -> None:
        result = parse_demand_text("大后天早上去收割120亩", now=datetime(2026, 4, 23, 15, 0, tzinfo=ZoneInfo("Asia/Shanghai")))
        self.assertEqual(result["schedule_hint"], "2026-04-26 早上8点")

    def test_build_dispatch_proposal_returns_candidate(self) -> None:
        order = self.db.get(Order, 3001)
        proposal = build_dispatch_proposal(self.db, order)
        self.assertIsNotNone(proposal["selected_machine_id"])
        self.assertGreaterEqual(len(proposal["candidates"]), 1)
        self.assertGreater(proposal["confidence"], 0.0)
        self.assertIn("weather_risk_score", proposal["candidates"][0])

    def test_explain_decision_for_dispatch(self) -> None:
        message = explain_decision(
            "dispatch",
            "buyer",
            {"selected_machine_id": 1001, "confidence": 0.93},
        )
        self.assertIn("农机", message)

    def test_handle_weather_exception_pauses_on_high_target_risk(self) -> None:
        order = self.db.get(Order, 3001)
        target_snapshot = {
            "provider": "open-meteo",
            "current": {"time": None, "temperature_2m": 18.0, "apparent_temperature": 18.0, "precipitation": 4.0, "weather_code": 65, "weather_text": "大雨", "wind_speed_10m": 32.0},
            "hourly": [],
            "risk": {
                "risk_level": "high",
                "risk_score": 82.0,
                "dispatch_penalty": 34.0,
                "max_precip_probability": 88.0,
                "max_precipitation": 12.0,
                "max_wind_speed": 32.0,
                "weather_code": 65,
                "weather_text": "大雨",
                "flags": ["未来6小时可能出现大雨"],
                "recommendation": "天气风险高，建议暂停派单或等待窗口改善。",
            },
        }
        source_snapshot = {
            "provider": "open-meteo",
            "current": {"time": None, "temperature_2m": 24.0, "apparent_temperature": 24.0, "precipitation": 0.0, "weather_code": 0, "weather_text": "晴朗", "wind_speed_10m": 12.0},
            "hourly": [],
            "risk": {
                "risk_level": "low",
                "risk_score": 4.0,
                "dispatch_penalty": 6.0,
                "max_precip_probability": 0.0,
                "max_precipitation": 0.0,
                "max_wind_speed": 12.0,
                "weather_code": 0,
                "weather_text": "晴朗",
                "flags": [],
                "recommendation": "天气整体可接受，可按常规规则派单。",
            },
        }

        with patch("app.services.agent_logic.fetch_weather_snapshot", side_effect=[target_snapshot, source_snapshot, source_snapshot]):
            result = handle_exception(self.db, order, "weather", "目的地下大雨")

        self.assertEqual(result["action_type"], "refund")
        self.assertEqual(result["suggested_status"], OrderStatus.ABNORMAL_PENDING)
        self.assertIsNone(result["replacement_machine_id"])

    def test_handle_weather_exception_reassigns_when_target_worse_than_source(self) -> None:
        order = self.db.get(Order, 3001)
        assigned_machine = self.db.get(Machine, 1001)
        assigned_machine.lng = 118.780
        assigned_machine.lat = 36.180
        self.db.commit()
        target_snapshot = {
            "provider": "open-meteo",
            "current": {"time": None, "temperature_2m": 21.0, "apparent_temperature": 21.0, "precipitation": 2.0, "weather_code": 63, "weather_text": "中雨", "wind_speed_10m": 20.0},
            "hourly": [],
            "risk": {
                "risk_level": "medium",
                "risk_score": 46.0,
                "dispatch_penalty": 18.0,
                "max_precip_probability": 75.0,
                "max_precipitation": 5.0,
                "max_wind_speed": 20.0,
                "weather_code": 63,
                "weather_text": "中雨",
                "flags": ["未来6小时可能出现明显降水"],
                "recommendation": "天气存在波动，建议优先近距离、健康分较高的农机。",
            },
        }
        assigned_source_snapshot = {
            "provider": "open-meteo",
            "current": {"time": None, "temperature_2m": 28.0, "apparent_temperature": 28.0, "precipitation": 0.0, "weather_code": 0, "weather_text": "晴朗", "wind_speed_10m": 10.0},
            "hourly": [],
            "risk": {
                "risk_level": "low",
                "risk_score": 6.0,
                "dispatch_penalty": 6.0,
                "max_precip_probability": 0.0,
                "max_precipitation": 0.0,
                "max_wind_speed": 10.0,
                "weather_code": 0,
                "weather_text": "晴朗",
                "flags": [],
                "recommendation": "天气整体可接受，可按常规规则派单。",
            },
        }
        backup_source_snapshot = {
            "provider": "open-meteo",
            "current": {"time": None, "temperature_2m": 22.0, "apparent_temperature": 22.0, "precipitation": 1.0, "weather_code": 61, "weather_text": "小雨", "wind_speed_10m": 14.0},
            "hourly": [],
            "risk": {
                "risk_level": "medium",
                "risk_score": 28.0,
                "dispatch_penalty": 18.0,
                "max_precip_probability": 40.0,
                "max_precipitation": 1.0,
                "max_wind_speed": 14.0,
                "weather_code": 61,
                "weather_text": "小雨",
                "flags": [],
                "recommendation": "天气存在波动，建议优先近距离、健康分较高的农机。",
            },
        }

        with patch(
            "app.services.agent_logic.fetch_weather_snapshot",
            side_effect=[target_snapshot, assigned_source_snapshot, backup_source_snapshot],
        ):
            result = handle_exception(self.db, order, "weather", "目的地下雨，建议择近改派")

        self.assertEqual(result["action_type"], "reassign")
        self.assertEqual(result["suggested_status"], OrderStatus.REASSIGN_PROPOSED)
        self.assertEqual(result["replacement_machine_id"], 1002)


if __name__ == "__main__":
    unittest.main()
