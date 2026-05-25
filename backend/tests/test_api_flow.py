from __future__ import annotations

import unittest
from datetime import UTC, datetime
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.db import SessionLocal
from app.models import Machine, MachineStatus, ServiceSKU, User, UserRole


def ensure_seed_minimum() -> None:
    db = SessionLocal()
    try:
        buyer = db.get(User, 1)
        if not buyer:
            db.add(User(id=1, role=UserRole.buyer, name="Buyer1", phone="13811110001", rating=4.5, region="A"))

        owner = db.get(User, 11)
        if not owner:
            db.add(User(id=11, role=UserRole.owner, name="Owner11", phone="13911110011", rating=4.7, region="A"))

        machine = db.get(Machine, 1001)
        if not machine:
            db.add(
                Machine(
                    id=1001,
                    owner_id=11,
                    machine_type="联合收割机",
                    capacity_mu_per_hour=18,
                    lng=119.12,
                    lat=36.71,
                    status=MachineStatus.idle,
                    health_score=90,
                )
            )

        sku = db.get(ServiceSKU, 2001)
        if not sku:
            db.add(
                ServiceSKU(
                    id=2001,
                    owner_id=11,
                    machine_id=1001,
                    work_type="收割",
                    title="测试收割服务",
                    unit="亩",
                    unit_price=68,
                    radius_km=30,
                    min_area=20,
                    is_active=1,
                    created_at=datetime.now(UTC),
                )
            )

        db.commit()
    finally:
        db.close()


class ApiFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        ensure_seed_minimum()
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()

    @staticmethod
    def _low_risk_snapshot() -> dict:
        return {
            "provider": "open-meteo",
            "current": {
                "time": "2026-04-16T09:00",
                "temperature_2m": 24.0,
                "apparent_temperature": 24.0,
                "precipitation": 0.0,
                "weather_code": 1,
                "weather_text": "大部晴朗",
                "wind_speed_10m": 12.0,
            },
            "hourly": [],
            "risk": {
                "risk_level": "low",
                "risk_score": 8.0,
                "dispatch_penalty": 6.0,
                "max_precip_probability": 10.0,
                "max_precipitation": 0.0,
                "max_wind_speed": 12.0,
                "weather_code": 1,
                "weather_text": "大部晴朗",
                "flags": [],
                "recommendation": "天气整体可接受，可按常规规则派单。",
            },
        }

    @staticmethod
    def _high_risk_weather_snapshot() -> dict:
        return {
            "provider": "open-meteo",
            "current": {
                "time": "2026-05-25T23:00",
                "temperature_2m": 18.0,
                "apparent_temperature": 18.0,
                "precipitation": 9.5,
                "weather_code": 95,
                "weather_text": "雷暴",
                "wind_speed_10m": 56.0,
            },
            "hourly": [],
            "risk": {
                "risk_level": "high",
                "risk_score": 88.0,
                "dispatch_penalty": 34.0,
                "max_precip_probability": 96.0,
                "max_precipitation": 14.0,
                "max_wind_speed": 58.0,
                "weather_code": 95,
                "weather_text": "雷暴",
                "flags": ["降水概率高", "未来6小时可能出现大雨", "风力较强", "存在雷暴风险"],
                "recommendation": "天气风险高，建议取消并退款。",
            },
        }

    def test_order_flow_from_create_to_completed(self) -> None:
        create_payload = {
            "buyer_id": 1,
            "sku_id": 2001,
            "area_mu": 66,
            "urgency_level": "medium",
            "quality_constraints": "demo",
            "target_lng": 119.120,
            "target_lat": 36.710,
        }
        resp = self.client.post("/api/orders", json=create_payload)
        self.assertEqual(resp.status_code, 200)
        order = resp.json()
        order_id = order["id"]

        resp = self.client.post(f"/api/orders/{order_id}/pay?operator_id=21")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["to_status"], "PAID_ESCROW")

        with patch(
            "app.routers.agents.fetch_weather_snapshot",
            side_effect=[self._low_risk_snapshot(), self._low_risk_snapshot()],
        ):
            resp = self.client.post(
                "/api/agents/dispatch/propose",
                json={"order_id": order_id, "auto_transition": True},
            )
        self.assertEqual(resp.status_code, 200)
        proposal = resp.json()
        self.assertIsNotNone(proposal.get("selected_machine_id"))

        resp = self.client.post(
            f"/api/orders/{order_id}/transition",
            json={
                "to_status": "DISPATCH_CONFIRMED",
                "operator_id": 21,
                "payload": {"machine_id": proposal["selected_machine_id"]},
            },
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["to_status"], "DISPATCH_CONFIRMED")

        self.assertEqual(
            self.client.post(f"/api/orders/{order_id}/start?operator_id=21").status_code,
            200,
        )
        self.assertEqual(
            self.client.post(f"/api/orders/{order_id}/finish?operator_id=21").status_code,
            200,
        )

        resp = self.client.post(f"/api/orders/{order_id}/confirm?operator_id=1")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["to_status"], "COMPLETED")

    def test_exception_handle_returns_proposal_for_map_scene(self) -> None:
        create_payload = {
            "buyer_id": 1,
            "sku_id": 2001,
            "area_mu": 80,
            "urgency_level": "high",
            "quality_constraints": "demo",
            "target_lng": 119.120,
            "target_lat": 36.710,
        }
        create_resp = self.client.post("/api/orders", json=create_payload)
        self.assertEqual(create_resp.status_code, 200)
        order_id = create_resp.json()["id"]

        self.assertEqual(self.client.post(f"/api/orders/{order_id}/pay?operator_id=21").status_code, 200)

        with patch(
            "app.routers.agents.fetch_weather_snapshot",
            side_effect=[self._low_risk_snapshot(), self._low_risk_snapshot()],
        ):
            dispatch_resp = self.client.post(
              "/api/agents/dispatch/propose",
              json={"order_id": order_id, "auto_transition": True},
            )
        self.assertEqual(dispatch_resp.status_code, 200)
        selected_machine_id = dispatch_resp.json()["selected_machine_id"]

        confirm_resp = self.client.post(
            f"/api/orders/{order_id}/transition",
            json={
                "to_status": "DISPATCH_CONFIRMED",
                "operator_id": 21,
                "payload": {"machine_id": selected_machine_id},
            },
        )
        self.assertEqual(confirm_resp.status_code, 200)

        start_resp = self.client.post(f"/api/orders/{order_id}/start?operator_id=21")
        self.assertEqual(start_resp.status_code, 200)

        abnormal_resp = self.client.post(
            f"/api/orders/{order_id}/transition",
            json={
                "to_status": "ABNORMAL_PENDING",
                "operator_id": 21,
                "note": "发动机温度异常",
            },
        )
        self.assertEqual(abnormal_resp.status_code, 200)

        exception_resp = self.client.post(
            "/api/agents/exception/handle",
            json={
                "order_id": order_id,
                "event_type": "fault",
                "description": "发动机温度异常，建议改派",
                "auto_transition": True,
            },
        )
        self.assertEqual(exception_resp.status_code, 200)
        payload = exception_resp.json()
        self.assertIn("proposal", payload)
        self.assertIn("candidates", payload["proposal"])

    def test_weather_exception_auto_transition_enters_abnormal_pending(self) -> None:
        create_payload = {
            "buyer_id": 1,
            "sku_id": 2001,
            "area_mu": 72,
            "urgency_level": "high",
            "quality_constraints": "天气敏感",
            "target_lng": 119.120,
            "target_lat": 36.710,
        }
        create_resp = self.client.post("/api/orders", json=create_payload)
        self.assertEqual(create_resp.status_code, 200)
        order_id = create_resp.json()["id"]

        self.assertEqual(self.client.post(f"/api/orders/{order_id}/pay?operator_id=21").status_code, 200)
        with patch(
            "app.routers.agents.fetch_weather_snapshot",
            side_effect=[self._low_risk_snapshot(), self._low_risk_snapshot()],
        ):
            dispatch_resp = self.client.post(
                "/api/agents/dispatch/propose",
                json={"order_id": order_id, "auto_transition": True},
            )
        self.assertEqual(dispatch_resp.status_code, 200)
        selected_machine_id = dispatch_resp.json()["selected_machine_id"]

        confirm_resp = self.client.post(
            f"/api/orders/{order_id}/transition",
            json={
                "to_status": "DISPATCH_CONFIRMED",
                "operator_id": 21,
                "payload": {"machine_id": selected_machine_id},
            },
        )
        self.assertEqual(confirm_resp.status_code, 200)

        target_snapshot = {
            "provider": "open-meteo",
            "current": {
                "time": "2026-04-16T09:00",
                "temperature_2m": 18.0,
                "apparent_temperature": 18.0,
                "precipitation": 6.0,
                "weather_code": 65,
                "weather_text": "大雨",
                "wind_speed_10m": 30.0,
            },
            "hourly": [],
            "risk": {
                "risk_level": "high",
                "risk_score": 84.0,
                "dispatch_penalty": 34.0,
                "max_precip_probability": 90.0,
                "max_precipitation": 10.0,
                "max_wind_speed": 30.0,
                "weather_code": 65,
                "weather_text": "大雨",
                "flags": ["未来6小时可能出现大雨"],
                "recommendation": "天气风险高，建议暂停派单或等待窗口改善。",
            },
        }
        source_snapshot = {
            "provider": "open-meteo",
            "current": {
                "time": "2026-04-16T09:00",
                "temperature_2m": 26.0,
                "apparent_temperature": 26.0,
                "precipitation": 0.0,
                "weather_code": 0,
                "weather_text": "晴朗",
                "wind_speed_10m": 10.0,
            },
            "hourly": [],
            "risk": {
                "risk_level": "low",
                "risk_score": 2.0,
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
        with patch("app.services.agent_logic.fetch_weather_snapshot", side_effect=[target_snapshot, source_snapshot]):
            exception_resp = self.client.post(
                "/api/agents/exception/handle",
                json={
                    "order_id": order_id,
                    "event_type": "weather",
                    "description": "目的地下雨，自动暂停",
                    "auto_transition": True,
                },
            )

        self.assertEqual(exception_resp.status_code, 200)
        payload = exception_resp.json()
        self.assertEqual(payload["action_type"], "refund")
        self.assertEqual(payload["suggested_status"], "ABNORMAL_PENDING")

        order_resp = self.client.get(f"/api/orders/{order_id}")
        self.assertEqual(order_resp.status_code, 200)
        self.assertEqual(order_resp.json()["status"], "ABNORMAL_PENDING")

    def test_weather_exception_from_dispatch_proposed_enters_abnormal_pending(self) -> None:
        create_resp = self.client.post(
            "/api/orders",
            json={
                "buyer_id": 1,
                "sku_id": 2001,
                "area_mu": 88,
                "urgency_level": "high",
                "quality_constraints": "派单前目的地暴雨",
                "target_lng": 119.120,
                "target_lat": 36.710,
            },
        )
        self.assertEqual(create_resp.status_code, 200)
        order_id = create_resp.json()["id"]

        self.assertEqual(self.client.post(f"/api/orders/{order_id}/pay?operator_id=21").status_code, 200)
        with patch(
            "app.routers.agents.fetch_weather_snapshot",
            side_effect=[self._low_risk_snapshot(), self._low_risk_snapshot()],
        ):
            dispatch_resp = self.client.post(
                "/api/agents/dispatch/propose",
                json={"order_id": order_id, "auto_transition": True},
            )
        self.assertEqual(dispatch_resp.status_code, 200)

        with patch("app.services.agent_logic.fetch_weather_snapshot", return_value=self._high_risk_weather_snapshot()):
            exception_resp = self.client.post(
                "/api/agents/exception/handle",
                json={
                    "order_id": order_id,
                    "event_type": "weather",
                    "description": "目的地作业时段雷暴",
                    "auto_transition": True,
                },
            )

        self.assertEqual(exception_resp.status_code, 200)
        self.assertEqual(exception_resp.json()["action_type"], "refund")
        order_resp = self.client.get(f"/api/orders/{order_id}")
        self.assertEqual(order_resp.status_code, 200)
        self.assertEqual(order_resp.json()["status"], "ABNORMAL_PENDING")

    def test_weather_exception_from_reassign_proposed_enters_abnormal_pending(self) -> None:
        create_resp = self.client.post(
            "/api/orders",
            json={
                "buyer_id": 1,
                "sku_id": 2001,
                "area_mu": 90,
                "urgency_level": "high",
                "quality_constraints": "改派候选后目的地暴雨",
                "target_lng": 119.120,
                "target_lat": 36.710,
            },
        )
        self.assertEqual(create_resp.status_code, 200)
        order_id = create_resp.json()["id"]

        self.assertEqual(self.client.post(f"/api/orders/{order_id}/pay?operator_id=21").status_code, 200)
        with patch(
            "app.routers.agents.fetch_weather_snapshot",
            side_effect=[self._low_risk_snapshot(), self._low_risk_snapshot()],
        ):
            dispatch_resp = self.client.post(
                "/api/agents/dispatch/propose",
                json={"order_id": order_id, "auto_transition": True},
            )
        selected_machine_id = dispatch_resp.json()["selected_machine_id"]

        self.assertEqual(
            self.client.post(
                f"/api/orders/{order_id}/transition",
                json={
                    "to_status": "DISPATCH_CONFIRMED",
                    "operator_id": 21,
                    "payload": {"machine_id": selected_machine_id},
                },
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.post(
                f"/api/orders/{order_id}/transition",
                json={"to_status": "ABNORMAL_PENDING", "operator_id": 21, "note": "先进入异常池"},
            ).status_code,
            200,
        )
        with patch(
            "app.routers.agents.fetch_weather_snapshot",
            side_effect=[self._low_risk_snapshot(), self._low_risk_snapshot()],
        ):
            reassign_resp = self.client.post(
                "/api/agents/dispatch/propose",
                json={"order_id": order_id, "auto_transition": True},
            )
        self.assertEqual(reassign_resp.status_code, 200)

        order_resp = self.client.get(f"/api/orders/{order_id}")
        self.assertEqual(order_resp.status_code, 200)
        self.assertEqual(order_resp.json()["status"], "REASSIGN_PROPOSED")

        with patch("app.services.agent_logic.fetch_weather_snapshot", return_value=self._high_risk_weather_snapshot()):
            exception_resp = self.client.post(
                "/api/agents/exception/handle",
                json={
                    "order_id": order_id,
                    "event_type": "weather",
                    "description": "改派候选阶段目的地雷暴",
                    "auto_transition": True,
                },
            )

        self.assertEqual(exception_resp.status_code, 200)
        self.assertEqual(exception_resp.json()["action_type"], "refund")
        order_resp = self.client.get(f"/api/orders/{order_id}")
        self.assertEqual(order_resp.status_code, 200)
        self.assertEqual(order_resp.json()["status"], "ABNORMAL_PENDING")

    def test_abnormal_pending_can_resume_to_in_service(self) -> None:
        create_resp = self.client.post(
            "/api/orders",
            json={
                "buyer_id": 1,
                "sku_id": 2001,
                "area_mu": 75,
                "urgency_level": "high",
                "quality_constraints": "天气复检恢复",
                "target_lng": 119.120,
                "target_lat": 36.710,
            },
        )
        self.assertEqual(create_resp.status_code, 200)
        order_id = create_resp.json()["id"]

        self.assertEqual(self.client.post(f"/api/orders/{order_id}/pay?operator_id=21").status_code, 200)
        with patch(
            "app.routers.agents.fetch_weather_snapshot",
            side_effect=[self._low_risk_snapshot(), self._low_risk_snapshot()],
        ):
            dispatch_resp = self.client.post(
                "/api/agents/dispatch/propose",
                json={"order_id": order_id, "auto_transition": True},
            )
        selected_machine_id = dispatch_resp.json()["selected_machine_id"]

        self.assertEqual(
            self.client.post(
                f"/api/orders/{order_id}/transition",
                json={
                    "to_status": "DISPATCH_CONFIRMED",
                    "operator_id": 21,
                    "payload": {"machine_id": selected_machine_id},
                },
            ).status_code,
            200,
        )
        self.assertEqual(self.client.post(f"/api/orders/{order_id}/start?operator_id=21").status_code, 200)
        self.assertEqual(
            self.client.post(
                f"/api/orders/{order_id}/transition",
                json={"to_status": "ABNORMAL_PENDING", "operator_id": 21, "note": "暴雨暂停"},
            ).status_code,
            200,
        )

        resume_resp = self.client.post(
            f"/api/orders/{order_id}/transition",
            json={"to_status": "IN_SERVICE", "operator_id": 21, "note": "天气恢复，恢复作业"},
        )
        self.assertEqual(resume_resp.status_code, 200)
        self.assertEqual(resume_resp.json()["to_status"], "IN_SERVICE")

    def test_abnormal_pending_can_refund_to_refunded(self) -> None:
        create_resp = self.client.post(
            "/api/orders",
            json={
                "buyer_id": 1,
                "sku_id": 2001,
                "area_mu": 92,
                "urgency_level": "high",
                "quality_constraints": "天气取消退款",
                "target_lng": 119.120,
                "target_lat": 36.710,
            },
        )
        self.assertEqual(create_resp.status_code, 200)
        order_id = create_resp.json()["id"]

        self.assertEqual(self.client.post(f"/api/orders/{order_id}/pay?operator_id=21").status_code, 200)
        with patch(
            "app.routers.agents.fetch_weather_snapshot",
            side_effect=[self._low_risk_snapshot(), self._low_risk_snapshot()],
        ):
            dispatch_resp = self.client.post(
                "/api/agents/dispatch/propose",
                json={"order_id": order_id, "auto_transition": True},
            )
        selected_machine_id = dispatch_resp.json()["selected_machine_id"]

        self.assertEqual(
            self.client.post(
                f"/api/orders/{order_id}/transition",
                json={
                    "to_status": "DISPATCH_CONFIRMED",
                    "operator_id": 21,
                    "payload": {"machine_id": selected_machine_id},
                },
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.post(
                f"/api/orders/{order_id}/transition",
                json={"to_status": "ABNORMAL_PENDING", "operator_id": 21, "note": "持续强降雨"},
            ).status_code,
            200,
        )

        refunding_resp = self.client.post(
            f"/api/orders/{order_id}/transition",
            json={"to_status": "REFUNDING", "operator_id": 21, "note": "取消并退款"},
        )
        self.assertEqual(refunding_resp.status_code, 200)
        self.assertEqual(refunding_resp.json()["to_status"], "REFUNDING")

        refunded_resp = self.client.post(
            f"/api/orders/{order_id}/transition",
            json={"to_status": "REFUNDED", "operator_id": 21, "note": "退款完成"},
        )
        self.assertEqual(refunded_resp.status_code, 200)
        self.assertEqual(refunded_resp.json()["to_status"], "REFUNDED")


if __name__ == "__main__":
    unittest.main()
