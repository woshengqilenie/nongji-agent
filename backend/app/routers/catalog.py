from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Machine, ServiceSKU, User
from ..schemas import MachineOut, SKUOut, UserOut

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db)) -> list[User]:
    return db.query(User).order_by(User.id.asc()).all()


@router.get("/machines", response_model=list[MachineOut])
def list_machines(db: Session = Depends(get_db)) -> list[Machine]:
    return db.query(Machine).order_by(Machine.id.asc()).all()


@router.get("/skus", response_model=list[SKUOut])
def list_skus(db: Session = Depends(get_db)) -> list[ServiceSKU]:
    return db.query(ServiceSKU).order_by(ServiceSKU.id.asc()).all()
