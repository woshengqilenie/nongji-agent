from __future__ import annotations

from .models import OrderStatus

ALLOWED_TRANSITIONS: dict[OrderStatus, set[OrderStatus]] = {
    OrderStatus.CREATED: {OrderStatus.PAID_ESCROW, OrderStatus.CANCELED},
    OrderStatus.PAID_ESCROW: {OrderStatus.DISPATCH_PROPOSED, OrderStatus.ABNORMAL_PENDING, OrderStatus.CANCELED, OrderStatus.REFUNDING},
    OrderStatus.DISPATCH_PROPOSED: {OrderStatus.DISPATCH_CONFIRMED, OrderStatus.ABNORMAL_PENDING, OrderStatus.CANCELED},
    OrderStatus.DISPATCH_CONFIRMED: {
        OrderStatus.DISPATCH_PROPOSED,
        OrderStatus.IN_SERVICE,
        OrderStatus.ABNORMAL_PENDING,
        OrderStatus.CANCELED,
    },
    OrderStatus.IN_SERVICE: {OrderStatus.TO_CONFIRM, OrderStatus.ABNORMAL_PENDING},
    OrderStatus.ABNORMAL_PENDING: {
        OrderStatus.IN_SERVICE,
        OrderStatus.REASSIGN_PROPOSED,
        OrderStatus.DISPUTE,
        OrderStatus.CANCELED,
        OrderStatus.REFUNDING,
    },
    OrderStatus.REASSIGN_PROPOSED: {OrderStatus.REASSIGN_CONFIRMED, OrderStatus.ABNORMAL_PENDING, OrderStatus.CANCELED},
    OrderStatus.REASSIGN_CONFIRMED: {
        OrderStatus.REASSIGN_PROPOSED,
        OrderStatus.IN_SERVICE,
        OrderStatus.ABNORMAL_PENDING,
    },
    OrderStatus.TO_CONFIRM: {OrderStatus.COMPLETED, OrderStatus.DISPUTE},
    OrderStatus.DISPUTE: {OrderStatus.REFUNDING, OrderStatus.COMPLETED},
    OrderStatus.REFUNDING: {OrderStatus.REFUNDED},
    OrderStatus.COMPLETED: set(),
    OrderStatus.CANCELED: set(),
    OrderStatus.REFUNDED: set(),
}


def can_transition(from_status: OrderStatus, to_status: OrderStatus) -> bool:
    return to_status in ALLOWED_TRANSITIONS.get(from_status, set())


def assert_transition(from_status: OrderStatus, to_status: OrderStatus) -> None:
    if not can_transition(from_status, to_status):
        raise ValueError(f"状态流转非法: {from_status.value} -> {to_status.value}")


def next_statuses(status: OrderStatus) -> list[OrderStatus]:
    return sorted(ALLOWED_TRANSITIONS.get(status, set()), key=lambda s: s.value)
