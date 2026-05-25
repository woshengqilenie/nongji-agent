from __future__ import annotations

from datetime import datetime, timedelta
import unittest
from unittest.mock import patch

import httpx

from app.services.weather_service import fetch_weather_snapshot


class _BrokenClient:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def get(self, *_args, **_kwargs):
        raise httpx.ConnectTimeout("tls handshake timed out")


class _ForecastClient:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def get(self, _url, params=None, **_kwargs):
        self.params = params or {}
        start = datetime(2026, 5, 25)
        times = [(start + timedelta(hours=idx)).strftime("%Y-%m-%dT%H:%M") for idx in range(72)]
        hourly = {
            "time": times,
            "temperature_2m": [24.0] * 72,
            "apparent_temperature": [25.0] * 72,
            "precipitation_probability": [10.0] * 72,
            "precipitation": [0.0] * 72,
            "weather_code": [1] * 72,
            "wind_speed_10m": [12.0] * 72,
        }
        current = {
            "time": times[0],
            "temperature_2m": 24.0,
            "apparent_temperature": 25.0,
            "precipitation": 0.0,
            "weather_code": 1,
            "wind_speed_10m": 12.0,
        }
        return httpx.Response(
            200,
            json={"current": current, "hourly": hourly},
            request=httpx.Request("GET", "https://api.open-meteo.com/v1/forecast"),
        )


class WeatherServiceTests(unittest.TestCase):
    def test_fetch_weather_snapshot_falls_back_on_timeout(self) -> None:
        with patch("app.services.weather_service.httpx.Client", return_value=_BrokenClient()):
            snapshot = fetch_weather_snapshot(119.12, 36.71)

        self.assertEqual(snapshot["provider"], "weather-fallback")
        self.assertEqual(snapshot["risk"]["risk_level"], "low")
        self.assertIn("外部天气服务不可用", snapshot["risk"]["flags"])
        self.assertEqual(len(snapshot["hourly"]), 6)

    def test_fetch_weather_snapshot_returns_three_day_three_hour_samples(self) -> None:
        client = _ForecastClient()
        with patch("app.services.weather_service.httpx.Client", return_value=client):
            snapshot = fetch_weather_snapshot(88.0, 22.0)

        self.assertEqual(snapshot["provider"], "open-meteo")
        self.assertEqual(client.params["forecast_days"], 3)
        self.assertEqual(len(snapshot["hourly"]), 24)
        hours = [datetime.fromisoformat(item["time"]).hour for item in snapshot["hourly"][:4]]
        self.assertEqual(hours, [0, 3, 6, 9])


if __name__ == "__main__":
    unittest.main()
