from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.main import app


def main() -> None:
    client = TestClient(app)
    print("== Smoke Test Start ==")

    r = client.get("/health")
    print("health:", r.status_code, r.json())

    create_payload = {
        "buyer_id": 1,
        "sku_id": 2001,
        "area_mu": 72,
        "urgency_level": "high",
        "quality_constraints": "loss<=2%",
        "target_lng": 119.120,
        "target_lat": 36.710,
    }
    r = client.post("/api/orders", json=create_payload)
    if r.status_code != 200:
        raise RuntimeError(f"create order failed: {r.status_code} {r.text}")
    order = r.json()
    order_id = order["id"]
    print("create:", order_id, order["status"])

    r = client.post(f"/api/orders/{order_id}/pay?operator_id=21")
    print("pay:", r.status_code, r.json())

    r = client.post("/api/agents/dispatch/propose", json={"order_id": order_id, "auto_transition": True})
    proposal = r.json()
    print("dispatch:", r.status_code, proposal)

    machine_id = proposal.get("selected_machine_id")
    if machine_id:
        r = client.post(
            f"/api/orders/{order_id}/transition",
            json={"to_status": "DISPATCH_CONFIRMED", "operator_id": 21, "payload": {"machine_id": machine_id}},
        )
        print("dispatch_confirm:", r.status_code, r.json())

    print("start:", client.post(f"/api/orders/{order_id}/start?operator_id=21").status_code)
    print("finish:", client.post(f"/api/orders/{order_id}/finish?operator_id=21").status_code)
    print("confirm:", client.post(f"/api/orders/{order_id}/confirm?operator_id=1").status_code)

    metrics = client.get("/api/dashboard/metrics")
    print("metrics:", metrics.status_code, metrics.json())

    ui = client.get("/ui")
    print("ui:", ui.status_code, "title_ok=", "农机速配调度平台" in ui.text)

    print("== Smoke Test Passed ==")


if __name__ == "__main__":
    main()
