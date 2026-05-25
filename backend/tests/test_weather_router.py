from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Order
from app.main import app
from tests.test_api_flow import ensure_seed_minimum


class WeatherRouterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        ensure_seed_minimum()
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()

    def setUp(self) -> None:
        self.client.delete("/api/weather/demo/overrides")

    def test_order_weather_returns_snapshot(self) -> None:
        with patch("app.routers.weather.fetch_weather_snapshot") as mocked_fetch:
            target_snapshot = {
                "provider": "open-meteo",
                "current": {
                    "time": "2026-04-16T09:00",
                    "temperature_2m": 22.5,
                    "apparent_temperature": 23.1,
                    "precipitation": 0.0,
                    "weather_code": 1,
                    "weather_text": "大部晴朗",
                    "wind_speed_10m": 18.0,
                },
                "hourly": [
                    {
                        "time": "2026-04-16T10:00",
                        "precipitation_probability": 10.0,
                        "precipitation": 0.0,
                        "weather_code": 1,
                        "weather_text": "大部晴朗",
                        "wind_speed_10m": 20.0,
                    }
                ],
                "risk": {
                    "risk_level": "low",
                    "risk_score": 12.0,
                    "dispatch_penalty": 6.0,
                    "max_precip_probability": 10.0,
                    "max_precipitation": 0.0,
                    "max_wind_speed": 20.0,
                    "weather_code": 1,
                    "weather_text": "大部晴朗",
                    "flags": [],
                    "recommendation": "天气整体可接受，可按常规规则派单。",
                },
            }
            machine_snapshot = {
                "provider": "open-meteo",
                "current": {
                    "time": "2026-04-16T09:00",
                    "temperature_2m": 28.5,
                    "apparent_temperature": 29.1,
                    "precipitation": 0.0,
                    "weather_code": 0,
                    "weather_text": "晴朗",
                    "wind_speed_10m": 10.0,
                },
                "hourly": [
                    {
                        "time": "2026-04-16T10:00",
                        "precipitation_probability": 0.0,
                        "precipitation": 0.0,
                        "weather_code": 0,
                        "weather_text": "晴朗",
                        "wind_speed_10m": 11.0,
                    }
                ],
                "risk": {
                    "risk_level": "low",
                    "risk_score": 0.0,
                    "dispatch_penalty": 6.0,
                    "max_precip_probability": 0.0,
                    "max_precipitation": 0.0,
                    "max_wind_speed": 11.0,
                    "weather_code": 0,
                    "weather_text": "晴朗",
                    "flags": [],
                    "recommendation": "天气整体可接受，可按常规规则派单。",
                },
            }
            mocked_fetch.side_effect = [target_snapshot, machine_snapshot]

            create_resp = self.client.post(
                "/api/orders",
                json={
                    "buyer_id": 1,
                    "sku_id": 2001,
                    "area_mu": 88,
                    "urgency_level": "medium",
                    "quality_constraints": "demo",
                    "target_lng": 119.120,
                    "target_lat": 36.710,
                },
            )
            self.assertEqual(create_resp.status_code, 200)
            order_id = create_resp.json()["id"]
            db = SessionLocal()
            try:
                order = db.get(Order, order_id)
                order.machine_id = 1001
                db.commit()
            finally:
                db.close()

            resp = self.client.get(f"/api/weather/order/{order_id}")
            self.assertEqual(resp.status_code, 200)
            body = resp.json()
            self.assertEqual(body["provider"], "open-meteo")
            self.assertEqual(body["risk"]["risk_level"], "low")
            self.assertEqual(body["suggested_action"], "continue")
            self.assertIsNotNone(body["machine_context"])

    def test_demo_weather_scenario_overrides_order_weather(self) -> None:
        create_resp = self.client.post(
            "/api/orders",
            json={
                "buyer_id": 1,
                "sku_id": 2001,
                "area_mu": 96,
                "urgency_level": "high",
                "quality_constraints": "demo-weather",
                "schedule_start": "2026-05-25T23:00:00",
                "target_lng": 118.856,
                "target_lat": 36.362,
            },
        )
        self.assertEqual(create_resp.status_code, 200)
        order_id = create_resp.json()["id"]

        db = SessionLocal()
        try:
            order = db.get(Order, order_id)
            order.machine_id = 1001
            db.commit()
        finally:
            db.close()

        apply_resp = self.client.post(
            f"/api/weather/demo/order/{order_id}/scenario",
            json={
                "target_scene": "severe_storm",
                "machine_scene": "clear",
                "apply_current_machine": True,
                "clear_existing": True,
            },
        )
        self.assertEqual(apply_resp.status_code, 200)
        self.assertEqual(apply_resp.json()["target"]["risk_level"], "high")

        weather_resp = self.client.get(f"/api/weather/order/{order_id}")
        self.assertEqual(weather_resp.status_code, 200)
        body = weather_resp.json()
        self.assertEqual(body["provider"], "demo-weather")
        self.assertEqual(body["risk"]["risk_level"], "high")
        self.assertEqual(body["suggested_action"], "refund")
        self.assertEqual(body["current"]["time"], "2026-05-25T23:00")
        self.assertEqual(len(body["hourly"]), 24)
        self.assertEqual(body["hourly"][0]["time"], "2026-05-25T23:00")
        self.assertEqual(body["hourly"][1]["time"], "2026-05-26T02:00")

        clear_resp = self.client.delete(f"/api/weather/demo/order/{order_id}/scenario")
        self.assertEqual(clear_resp.status_code, 200)
        self.assertGreaterEqual(clear_resp.json()["cleared"], 1)


if __name__ == "__main__":
    unittest.main()
