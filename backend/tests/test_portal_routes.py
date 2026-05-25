from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from tests.test_api_flow import ensure_seed_minimum


def low_risk_snapshot() -> dict:
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


class PortalRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        ensure_seed_minimum()
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()

    def test_market_home_and_services(self) -> None:
        home_resp = self.client.get("/api/market/home")
        self.assertEqual(home_resp.status_code, 200)
        home = home_resp.json()
        self.assertIn("featured_services", home)
        self.assertGreaterEqual(len(home["featured_services"]), 1)

        services_resp = self.client.get("/api/market/services?work_type=收割")
        self.assertEqual(services_resp.status_code, 200)
        services = services_resp.json()
        self.assertGreaterEqual(len(services), 1)
        self.assertEqual(services[0]["work_type"], "收割")

    def test_dashboard_map_overview_returns_map_layers(self) -> None:
        create_resp = self.client.post(
            "/api/orders",
            json={
                "buyer_id": 1,
                "sku_id": 2001,
                "area_mu": 90,
                "urgency_level": "medium",
                "quality_constraints": "地图总览测试",
                "target_lng": 119.138,
                "target_lat": 36.718,
            },
        )
        self.assertEqual(create_resp.status_code, 200)

        overview_resp = self.client.get("/api/dashboard/map-overview")
        self.assertEqual(overview_resp.status_code, 200)
        overview = overview_resp.json()

        self.assertIn("metrics", overview)
        self.assertIn("machines", overview)
        self.assertIn("fields", overview)
        self.assertIn("service_coverage", overview)
        self.assertIn("routes", overview)
        self.assertIn("weather_alerts", overview)
        self.assertGreaterEqual(len(overview["machines"]), 1)
        self.assertGreaterEqual(len(overview["fields"]), 1)
        self.assertGreaterEqual(len(overview["service_coverage"]), 1)
        self.assertIn("lng", overview["machines"][0])
        self.assertIn("plot_radius_m", overview["fields"][0])

    def test_supervisor_orders_status_filter_accepts_queue_keys(self) -> None:
        create_resp = self.client.post(
            "/api/orders",
            json={
                "buyer_id": 1,
                "sku_id": 2001,
                "area_mu": 88,
                "urgency_level": "medium",
                "quality_constraints": "主管队列状态筛选测试",
                "target_lng": 119.120,
                "target_lat": 36.710,
            },
        )
        self.assertEqual(create_resp.status_code, 200)
        order_id = create_resp.json()["id"]

        self.assertEqual(self.client.post(f"/api/orders/{order_id}/pay?operator_id=21").status_code, 200)

        queue_resp = self.client.get("/api/supervisor/orders?status=waiting_dispatch")
        self.assertEqual(queue_resp.status_code, 200)
        self.assertIn(order_id, [item["id"] for item in queue_resp.json()])

        raw_status_resp = self.client.get("/api/supervisor/orders?status=PAID_ESCROW")
        self.assertEqual(raw_status_resp.status_code, 200)
        self.assertIn(order_id, [item["id"] for item in raw_status_resp.json()])

    def test_supervisor_confirm_and_machine_accept_flow(self) -> None:
        create_resp = self.client.post(
            "/api/orders",
            json={
                "buyer_id": 1,
                "sku_id": 2001,
                "area_mu": 120,
                "urgency_level": "high",
                "quality_constraints": "门户路由测试",
                "target_lng": 119.120,
                "target_lat": 36.710,
            },
        )
        self.assertEqual(create_resp.status_code, 200)
        order_id = create_resp.json()["id"]

        self.assertEqual(self.client.post(f"/api/orders/{order_id}/pay?operator_id=21").status_code, 200)

        with patch("app.routers.agents.fetch_weather_snapshot", side_effect=[low_risk_snapshot(), low_risk_snapshot()]):
            proposal_resp = self.client.post(
                "/api/agents/dispatch/propose",
                json={"order_id": order_id, "auto_transition": True},
            )
        self.assertEqual(proposal_resp.status_code, 200)
        proposal = proposal_resp.json()
        self.assertIsNotNone(proposal["selected_machine_id"])

        confirm_resp = self.client.post(
            f"/api/supervisor/orders/{order_id}/dispatch/confirm",
            json={"operator_id": 21, "machine_id": proposal["selected_machine_id"], "note": "主管确认测试派单"},
        )
        self.assertEqual(confirm_resp.status_code, 200)
        self.assertEqual(confirm_resp.json()["status"], "DISPATCH_CONFIRMED")

        accept_resp = self.client.post(
            f"/api/machine/orders/{order_id}/accept",
            json={"operator_id": 11, "note": "机主确认接单"},
        )
        self.assertEqual(accept_resp.status_code, 200)
        self.assertEqual(accept_resp.json()["stage_label"], "机主已接单")

        owner_dashboard = self.client.get("/api/machine/orders?owner_id=11")
        self.assertEqual(owner_dashboard.status_code, 200)
        groups = owner_dashboard.json()["groups"]
        self.assertTrue(any(item["id"] == order_id for item in groups["accepted"]))


if __name__ == "__main__":
    unittest.main()
