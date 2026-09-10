"""Private commission SMS workspace; admin manages accounts only."""
import hashlib
import json
import re
from datetime import date as Date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.database import get_db
from api.limiter import limiter
from api.models import AppointmentUser, CommissionSmsDoctor, CommissionSmsTemplate, CommissionSmsHistory
from api.routers.appointment import _current_user, _require_role, _user_out
from api.schemas import AppointmentUserOut
from api.utils.security import hash_password
from api.utils.sms import send_sms

router = APIRouter(prefix="/commission-sms", tags=["Commission SMS"])
ROLE = "commission_sms"
DHAKA = timezone(timedelta(hours=6))
DEFAULT_TEMPLATE = "Dear {name}, your commission payment of BDT {amount} for {date} has been sent. Thank you for your partnership."


def today():
    return datetime.now(DHAKA).date()


class CleanModel(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid", from_attributes=True)


def normalize_phone(value):
    value = re.sub(r"[\s()-]", "", value)
    if not re.fullmatch(r"(?:\+?88)?01[3-9][0-9]{8}", value):
        raise ValueError("Enter a valid Bangladesh mobile number")
    return value[-11:]


class AccountInput(CleanModel):
    name: str = Field(min_length=2, max_length=100)
    phone: str = Field(max_length=20)
    email: str | None = Field(default=None, max_length=120)
    password: Annotated[str, StringConstraints(strip_whitespace=False, min_length=6, max_length=72)] | None = None

    _phone = field_validator("phone")(normalize_phone)


class DoctorInput(CleanModel):
    doctor_id: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=2, max_length=100)
    address: str = Field(min_length=1, max_length=500)
    phone: str = Field(max_length=20)

    _phone = field_validator("phone")(normalize_phone)


class DoctorOut(DoctorInput):
    id: int


class TemplateInput(CleanModel):
    name: str = Field(min_length=1, max_length=100)
    body: str = Field(min_length=1, max_length=1000)

    @field_validator("body")
    @classmethod
    def validate_body(cls, value):
        if not re.fullmatch(r"(?:[^{}]|\{\{|\}\}|\{(?:name|amount|date)\})+", value):
            raise ValueError("Use valid placeholders: {name}, {amount}, {date}")
        return value


class TemplateOut(TemplateInput):
    id: int


class SendInput(CleanModel):
    doctor_id: int = Field(gt=0)
    template_id: int = Field(gt=0)
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    date: Date = Field(default_factory=today)
    request_id: UUID


class HistoryOut(CleanModel):
    id: int
    doctor_id: str
    doctor_name: str
    doctor_address: str
    phone: str
    template_name: str
    amount: Decimal
    payment_date: str
    message: str
    status: str
    status_detail: str | None
    sent_by_name: str
    created_at: str


class HistoryPage(BaseModel):
    items: list[HistoryOut]
    total: int


def operator(user: AppointmentUser = Depends(_current_user)):
    _require_role(user, ROLE)
    return user


def admin(user: AppointmentUser = Depends(_current_user)):
    _require_role(user, "admin")
    return user


def owned(db, model, record_id, user):
    record = db.query(model).filter(model.id == record_id, model.owner_id == user.id).first()
    if not record:
        raise HTTPException(404, "Record not found")
    return record


def commit(db, detail):
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, detail)


@router.post("/users", response_model=AppointmentUserOut, status_code=201)
def create_account(data: AccountInput, db: Session = Depends(get_db), user=Depends(admin)):
    if not data.password:
        raise HTTPException(422, "An initial password is required")
    account = AppointmentUser(id="usr_" + uuid4().hex[:12], name=data.name, phone=data.phone,
                              email=data.email, password=hash_password(data.password), role=ROLE)
    db.add(account)
    db.add(CommissionSmsTemplate(owner_id=account.id, name="Commission payment", body=DEFAULT_TEMPLATE))
    commit(db, "This phone is already registered")
    return _user_out(account)


@router.put("/users/{user_id}", response_model=AppointmentUserOut)
def update_account(user_id: str, data: AccountInput, db: Session = Depends(get_db), user=Depends(admin)):
    account = db.query(AppointmentUser).filter_by(id=user_id, role=ROLE).first()
    if not account:
        raise HTTPException(404, "Commission SMS user not found")
    account.name, account.phone, account.email = data.name, data.phone, data.email
    if data.password:
        account.password = hash_password(data.password)
    commit(db, "This phone is already registered")
    return _user_out(account)


@router.delete("/users/{user_id}")
def delete_account(user_id: str, db: Session = Depends(get_db), user=Depends(admin)):
    account = db.query(AppointmentUser).filter_by(id=user_id, role=ROLE).first()
    if not account:
        raise HTTPException(404, "Commission SMS user not found")
    # Retain private directory, templates and immutable SMS history for audit.
    db.delete(account)
    db.commit()
    return {"message": "Commission SMS user deleted"}


@router.get("/doctors", response_model=list[DoctorOut])
def list_doctors(db: Session = Depends(get_db), user=Depends(operator)):
    return db.query(CommissionSmsDoctor).filter_by(owner_id=user.id).order_by(CommissionSmsDoctor.name).all()


@router.post("/doctors", response_model=DoctorOut, status_code=201)
def create_doctor(data: DoctorInput, db: Session = Depends(get_db), user=Depends(operator)):
    doctor = CommissionSmsDoctor(owner_id=user.id, **data.model_dump())
    db.add(doctor)
    commit(db, "Doctor ID already exists in your directory")
    return doctor


@router.put("/doctors/{doctor_id}", response_model=DoctorOut)
def update_doctor(doctor_id: int, data: DoctorInput, db: Session = Depends(get_db), user=Depends(operator)):
    doctor = owned(db, CommissionSmsDoctor, doctor_id, user)
    for key, value in data.model_dump().items():
        setattr(doctor, key, value)
    commit(db, "Doctor ID already exists in your directory")
    return doctor


@router.delete("/doctors/{doctor_id}")
def delete_doctor(doctor_id: int, db: Session = Depends(get_db), user=Depends(operator)):
    db.delete(owned(db, CommissionSmsDoctor, doctor_id, user))
    db.commit()
    return {"message": "Doctor deleted; SMS history retained"}


@router.get("/templates", response_model=list[TemplateOut])
def list_templates(db: Session = Depends(get_db), user=Depends(operator)):
    return db.query(CommissionSmsTemplate).filter_by(owner_id=user.id).order_by(CommissionSmsTemplate.id).all()


@router.post("/templates", response_model=TemplateOut, status_code=201)
def create_template(data: TemplateInput, db: Session = Depends(get_db), user=Depends(operator)):
    template = CommissionSmsTemplate(owner_id=user.id, **data.model_dump())
    db.add(template)
    db.commit()
    return template


@router.put("/templates/{template_id}", response_model=TemplateOut)
def update_template(template_id: int, data: TemplateInput, db: Session = Depends(get_db), user=Depends(operator)):
    template = owned(db, CommissionSmsTemplate, template_id, user)
    template.name, template.body = data.name, data.body
    db.commit()
    return template


@router.delete("/templates/{template_id}")
def delete_template(template_id: int, db: Session = Depends(get_db), user=Depends(operator)):
    db.delete(owned(db, CommissionSmsTemplate, template_id, user))
    db.commit()
    return {"message": "Template deleted; SMS history retained"}


@router.post("/send", response_model=HistoryOut)
@limiter.limit("20/minute")
def send_commission_sms(request: Request, data: SendInput, db: Session = Depends(get_db), user=Depends(operator)):
    request_id = str(data.request_id)
    fingerprint = hashlib.sha256(json.dumps(data.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()

    def previous_attempt():
        previous = db.query(CommissionSmsHistory).filter_by(owner_id=user.id, request_id=request_id).first()
        if previous and previous.request_hash != fingerprint:
            raise HTTPException(409, "This request ID was already used for another message")
        return previous

    previous = previous_attempt()
    if previous:
        return previous
    doctor = owned(db, CommissionSmsDoctor, data.doctor_id, user)
    template = owned(db, CommissionSmsTemplate, data.template_id, user)
    message = template.body.format(name=doctor.name, amount=f"{data.amount:.2f}", date=data.date.isoformat())
    if len(message) > 1600:
        raise HTTPException(422, "Rendered SMS must be no longer than 1600 characters")
    record = CommissionSmsHistory(owner_id=user.id, request_id=request_id, request_hash=fingerprint,
        doctor_id=doctor.doctor_id, doctor_name=doctor.name, doctor_address=doctor.address,
        phone=doctor.phone, template_name=template.name, amount=data.amount, payment_date=data.date.isoformat(),
        message=message, sent_by_name=user.name, created_at=datetime.now(DHAKA).isoformat(timespec="seconds"),
        status="pending", status_detail="Submission in progress. Do not resend until checked.")
    db.add(record)
    try:
        # Claim the request durably before contacting the provider, including concurrent retries.
        db.commit()
    except IntegrityError:
        db.rollback()
        previous = previous_attempt()
        if previous:
            return previous
        raise
    try:
        result = send_sms(number="88" + doctor.phone, message=message)
        # The existing gateway helper has no documented delivery receipt contract.
        # HTTP success records submission only; never claim handset delivery.
        rejected = isinstance(result, dict) and (
            str(result.get("success", "")).lower() in {"false", "0"}
            or str(result.get("status", "")).lower() in {"failed", "error", "rejected"}
            or bool(result.get("error"))
        )
        record.status = "failed" if rejected else "submitted"
        record.status_detail = "SMS gateway rejected the message." if rejected else "Request submitted to SMS gateway. Acceptance and delivery are unconfirmed."
    except HTTPException as exc:
        record.status = "failed" if exc.status_code == 500 else "unknown"
        record.status_detail = "SMS provider is not configured." if exc.status_code == 500 else "Gateway request failed. Check with the provider before sending again; delivery is unknown."
    except Exception:
        record.status = "unknown"
        record.status_detail = "Submission could not be confirmed. Check with the provider before sending again."
    db.commit()
    return record


@router.get("/history", response_model=HistoryPage)
def history(search: str = Query("", max_length=100), payment_date: Date | None = None,
            skip: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100),
            db: Session = Depends(get_db), user=Depends(operator)):
    query = db.query(CommissionSmsHistory).filter_by(owner_id=user.id)
    if search.strip():
        query = query.filter(or_(*(column.contains(search.strip(), autoescape=True) for column in (
            CommissionSmsHistory.doctor_id, CommissionSmsHistory.doctor_name, CommissionSmsHistory.phone))))
    if payment_date:
        query = query.filter_by(payment_date=payment_date.isoformat())
    return {"total": query.count(), "items": query.order_by(CommissionSmsHistory.id.desc()).offset(skip).limit(limit).all()}
