from __future__ import annotations

import unittest

from app.models import OrderStatus
from app.state_machine import assert_transition, can_transition, next_statuses


class StateMachineTests(unittest.TestCase):
    def test_valid_transition_created_to_paid(self) -> None:
        self.assertTrue(can_transition(OrderStatus.CREATED, OrderStatus.PAID_ESCROW))
        assert_transition(OrderStatus.CREATED, OrderStatus.PAID_ESCROW)

    def test_invalid_transition_created_to_in_service(self) -> None:
        self.assertFalse(can_transition(OrderStatus.CREATED, OrderStatus.IN_SERVICE))
        with self.assertRaises(ValueError):
            assert_transition(OrderStatus.CREATED, OrderStatus.IN_SERVICE)

    def test_next_statuses_for_in_service(self) -> None:
        statuses = {s.value for s in next_statuses(OrderStatus.IN_SERVICE)}
        self.assertEqual(statuses, {"TO_CONFIRM", "ABNORMAL_PENDING"})

    def test_pre_dispatch_weather_can_enter_abnormal_pending(self) -> None:
        self.assertTrue(can_transition(OrderStatus.PAID_ESCROW, OrderStatus.ABNORMAL_PENDING))
        self.assertTrue(can_transition(OrderStatus.DISPATCH_PROPOSED, OrderStatus.ABNORMAL_PENDING))
        self.assertTrue(can_transition(OrderStatus.REASSIGN_PROPOSED, OrderStatus.ABNORMAL_PENDING))

    def test_abnormal_pending_allows_resume_and_refunding(self) -> None:
        statuses = {s.value for s in next_statuses(OrderStatus.ABNORMAL_PENDING)}
        self.assertIn("IN_SERVICE", statuses)
        self.assertIn("REFUNDING", statuses)


if __name__ == "__main__":
    unittest.main()
