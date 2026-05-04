import hashlib
import hmac
import json
import random
import re
import io
from datetime import date, datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import Optional
from uuid import uuid4

import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from models import AppointmentBooking, AppointmentDoctor, AppointmentUser
from schemas import (
    AppointmentCreate,
    AppointmentDataResponse,
    AppointmentDoctorCreate,
    AppointmentDoctorOut,
    AppointmentDoctorUpdate,
    AppointmentLoginRequest,
    AppointmentOut,
    AppointmentStatusUpdate,
    AppointmentStaffCreate,
    AppointmentSuccessResponse,
    AppointmentUserCreate,
    AppointmentUserOut,
    AppointmentUserPasswordChange,
    AppointmentUserPasswordReset,
    AppointmentUserUpdate,
    OtpSendRequest,
    OtpVerifyRequest,
)
from limiter import limiter
from utils.jwt_handler import JWT_ALGORITHM, JWT_SECRET, create_access_token
from utils.sms import send_sms
from utils.security import hash_password, verify_password


router = APIRouter(tags=["Appointment Portal"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="appointment/login")

VALID_ROLES = {"user", "doctor", "admin", "marketing", "commission_doctor"}
VALID_STATUSES = {"Booked", "Completed", "Cancelled"}
SLOT_INTERVAL_MINUTES = 30
BOOKING_WINDOW_DAYS = 1
TIME_RE = re.compile(r"^\d{2}:\d{2}$")
PHONE_RE = re.compile(r"^\+?\d{7,15}$|^admin$")
WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
DAY_ALIASES = {
    "mon": "Monday",
    "monday": "Monday",
    "tue": "Tuesday",
    "tues": "Tuesday",
    "tuesday": "Tuesday",
    "wed": "Wednesday",
    "wednesday": "Wednesday",
    "thu": "Thursday",
    "thur": "Thursday",
    "thurs": "Thursday",
    "thursday": "Thursday",
    "fri": "Friday",
    "friday": "Friday",
    "sat": "Saturday",
    "saturday": "Saturday",
    "sun": "Sunday",
    "sunday": "Sunday",
}
OTP_TTL_SECONDS = 300
OTP_RESEND_COOLDOWN_SECONDS = 60
OTP_MAX_VERIFY_ATTEMPTS = 3
OTP_VERIFIED_TTL_SECONDS = 600
_otp_store: dict[str, dict] = {}
_otp_verified_store: dict[str, datetime] = {}
_otp_daily_limits: dict[str, dict] = {}
_otp_lock = Lock()


def _normalize_phone(value: str) -> str:
    value = str(value or "").strip()
    if value.lower() == "admin":
        return "admin"
    return re.sub(r"[^\d+]", "", value)


def _require_phone(value: str) -> str:
    phone = _normalize_phone(value)
    if not PHONE_RE.match(phone):
        raise HTTPException(status_code=400, detail="Enter a valid phone number")
    if phone == "admin":
        raise HTTPException(status_code=400, detail="Enter a valid phone number")
    return phone


def _sms_phone_number(phone: str) -> str:
    if phone.startswith("+880"):
        return phone[1:]
    if phone.startswith("880"):
        return phone
    if phone.startswith("0"):
        return "88" + phone
    return phone


def _cleanup_expired_otps(now: datetime) -> None:
    expired = [
        phone
        for phone, entry in _otp_store.items()
        if entry["expires_at"] <= now
    ]
    for phone in expired:
        _otp_store.pop(phone, None)


def _cleanup_verified_otps(now: datetime) -> None:
    expired = [
        phone
        for phone, expires_at in _otp_verified_store.items()
        if expires_at <= now
    ]
    for phone in expired:
        _otp_verified_store.pop(phone, None)


def _cleanup_daily_limits(today: date) -> None:
    expired = [
        phone
        for phone, record in _otp_daily_limits.items()
        if record["date"] != today
    ]
    for phone in expired:
        _otp_daily_limits.pop(phone, None)


def _hash_otp(otp: str) -> str:
    return hashlib.sha256(otp.encode("utf-8")).hexdigest()


def _parse_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must use YYYY-MM-DD")


def _parse_time(value: str) -> int:
    if not TIME_RE.match(str(value or "")):
        raise HTTPException(status_code=400, detail="Time must use HH:MM")
    hours, minutes = [int(part) for part in value.split(":")]
    if hours > 23 or minutes > 59:
        raise HTTPException(status_code=400, detail="Time must be valid")
    return hours * 60 + minutes


def _format_time(total_minutes: int) -> str:
    return f"{total_minutes // 60:02d}:{total_minutes % 60:02d}"


def _normalize_working_days(days: Optional[list[str]]) -> list[str]:
    if not days:
        return WEEKDAY_NAMES.copy()

    normalized: list[str] = []
    seen = set()
    for raw_day in days:
        key = re.sub(r"[^a-z]", "", str(raw_day or "").strip().lower())
        day_name = DAY_ALIASES.get(key)
        if not day_name:
            raise HTTPException(status_code=400, detail=f"Invalid working day: {raw_day}")
        if day_name not in seen:
            normalized.append(day_name)
            seen.add(day_name)

    if not normalized:
        raise HTTPException(status_code=400, detail="At least one working day is required")

    order = {name: index for index, name in enumerate(WEEKDAY_NAMES)}
    normalized.sort(key=lambda name: order[name])
    return normalized


def _normalize_working_schedule(
    schedule: Optional[list],
    fallback_days: Optional[list[str]] = None,
    fallback_start: Optional[str] = None,
    fallback_end: Optional[str] = None,
) -> list[dict]:
    if not schedule:
        days = _normalize_working_days(fallback_days)
        if not days or not fallback_start or not fallback_end:
            raise HTTPException(status_code=400, detail="At least one working day and time range is required")
        return [
            {"day": day, "startTime": fallback_start, "endTime": fallback_end}
            for day in days
        ]

    normalized: list[dict] = []
    seen = set()
    for raw_item in schedule:
        day_value = None
        start_value = None
        end_value = None
        if isinstance(raw_item, dict):
            day_value = raw_item.get("day")
            start_value = raw_item.get("startTime")
            end_value = raw_item.get("endTime")
        else:
            day_value = getattr(raw_item, "day", None)
            start_value = getattr(raw_item, "startTime", None)
            end_value = getattr(raw_item, "endTime", None)

        key = re.sub(r"[^a-z]", "", str(day_value or "").strip().lower())
        day_name = DAY_ALIASES.get(key)
        if not day_name:
            raise HTTPException(status_code=400, detail=f"Invalid working day: {day_value}")
        if day_name in seen:
            continue
        if not start_value or not end_value:
            raise HTTPException(status_code=400, detail=f"Working time is required for {day_name}")
        _validate_schedule(str(start_value), str(end_value))
        seen.add(day_name)
        normalized.append({"day": day_name, "startTime": str(start_value), "endTime": str(end_value)})

    order = {name: index for index, name in enumerate(WEEKDAY_NAMES)}
    normalized.sort(key=lambda item: order[item["day"]])
    if not normalized:
        raise HTTPException(status_code=400, detail="At least one working day and time range is required")
    return normalized


def _doctor_working_days(doctor: AppointmentDoctor) -> list[str]:
    raw_days = getattr(doctor, "working_days", None)
    if not raw_days:
        return WEEKDAY_NAMES.copy()

    raw_days = str(raw_days).strip()
    if raw_days.startswith("["):
        try:
            parsed = json.loads(raw_days)
            if isinstance(parsed, list):
                return _normalize_working_days(parsed)
        except Exception:
            pass

    parsed_days = [item.strip() for item in raw_days.split(",") if item.strip()]
    return _normalize_working_days(parsed_days)


def _doctor_schedule_items(doctor: AppointmentDoctor) -> list[dict]:
    raw_schedule = getattr(doctor, "working_schedule", None)
    if raw_schedule:
        raw_schedule = str(raw_schedule).strip()
        try:
            parsed = json.loads(raw_schedule)
            if isinstance(parsed, list) and parsed:
                return _normalize_working_schedule(parsed)
        except Exception:
            pass

    days = _doctor_working_days(doctor)
    if days:
        return _normalize_working_schedule(
            None,
            fallback_days=days,
            fallback_start=getattr(doctor, "start_time", None),
            fallback_end=getattr(doctor, "end_time", None),
        )
    return []


def _doctor_schedule_for_date(doctor: AppointmentDoctor, selected_date: date) -> Optional[dict]:
    weekday_name = WEEKDAY_NAMES[selected_date.weekday()]
    for item in _doctor_schedule_items(doctor):
        if item["day"] == weekday_name:
            return item
    return None


def _previous_weekday_name(day_name: str) -> str:
    index = WEEKDAY_NAMES.index(day_name)
    return WEEKDAY_NAMES[(index - 1) % len(WEEKDAY_NAMES)]


def _is_allowed_booking_day(doctor: AppointmentDoctor, selected_date: date) -> bool:
    weekday_name = WEEKDAY_NAMES[selected_date.weekday()]
    working_days = {item["day"] for item in _doctor_schedule_items(doctor)}
    previous_days = {_previous_weekday_name(day) for day in working_days}
    return weekday_name in working_days or weekday_name in previous_days


def _doctor_schedule_summary(doctor: AppointmentDoctor) -> str:
    items = _doctor_schedule_items(doctor)
    if not items:
        return "Schedule not set"
    return ", ".join(
        f"{item['day'][:3]} {_display_time(item['startTime'])} - {_display_time(item['endTime'])}"
        for item in items
    )


def _display_time(value: str) -> str:
    minutes = _parse_time(value)
    suffix = "AM" if minutes < 720 else "PM"
    hour = (minutes // 60) % 12 or 12
    minute = minutes % 60
    return f"{hour:02d}:{minute:02d} {suffix}"


def _schedule_label(start_time: str, end_time: str) -> str:
    return f"{_display_time(start_time)} - {_display_time(end_time)}"


def _validate_schedule(start_time: str, end_time: str) -> None:
    if _parse_time(end_time) <= _parse_time(start_time):
        raise HTTPException(status_code=400, detail="End time must be after start time")


def _validate_booking_date(value: str) -> None:
    selected = _parse_date(value)
    today = date.today()
    max_day = today + timedelta(days=7)
    if selected < today:
        raise HTTPException(status_code=400, detail="Appointment date cannot be in the past")
    if selected > max_day:
        raise HTTPException(status_code=400, detail="Appointment date cannot be more than 7 days in advance")


def _user_out(user: AppointmentUser) -> AppointmentUserOut:
    return AppointmentUserOut(
        id=user.id,
        name=user.name,
        phone=user.phone,
        email=user.email,
        age=user.age,
        gender=user.gender,
        bloodGroup=user.blood_group,
        role=user.role,
        specialty=user.specialty,
        createdById=getattr(user, "created_by_id", None),
        createdByName=getattr(user, "created_by_name", None),
    )


def _doctor_out(doctor: AppointmentDoctor, email: Optional[str] = None) -> AppointmentDoctorOut:
    schedule_items = _doctor_schedule_items(doctor)
    working_days = [item["day"] for item in schedule_items] or WEEKDAY_NAMES.copy()
    first_item = schedule_items[0] if schedule_items else None
    return AppointmentDoctorOut(
        id=doctor.id,
        name=doctor.name,
        phone=doctor.phone,
        category=doctor.category,
        workingDays=working_days,
        workingSchedule=schedule_items,
        startTime=first_item["startTime"] if first_item else doctor.start_time,
        endTime=first_item["endTime"] if first_item else doctor.end_time,
        time=_doctor_schedule_summary(doctor),
        room=doctor.room,
        email=email,
        is_available=doctor.is_available,
    )


def _appointment_out(appointment: AppointmentBooking) -> AppointmentOut:
    return AppointmentOut(
        id=appointment.id,
        patientName=appointment.patient_name,
        patientPhone=appointment.patient_phone,
        docId=appointment.doctor_id,
        docName=appointment.doctor_name,
        date=appointment.date,
        time=appointment.time,
        room=appointment.room,
        status=appointment.status,
        reason=appointment.reason,
        serial_number=appointment.serial_number,
        bookedById=getattr(appointment, "booked_by_id", None),
        bookedByName=getattr(appointment, "booked_by_name", None),
        bookedByRole=getattr(appointment, "booked_by_role", None),
        marketingOfficerId=getattr(appointment, "marketing_officer_id", None),
        marketingOfficerName=getattr(appointment, "marketing_officer_name", None),
        commissionDoctorId=getattr(appointment, "commission_doctor_id", None),
        commissionDoctorName=getattr(appointment, "commission_doctor_name", None),
    )


def _current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> AppointmentUser:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("scope") != "appointment":
            raise credentials_exception
        user_id = payload.get("user_id")
    except jwt.PyJWTError:
        raise credentials_exception

    user = db.query(AppointmentUser).filter(AppointmentUser.id == user_id).first()
    if not user:
        raise credentials_exception
    return user


def _require_role(user: AppointmentUser, *roles: str) -> None:
    if user.role not in roles:
        raise HTTPException(status_code=403, detail="You do not have permission for this action")


def _seed_if_empty(db: Session) -> None:
    if db.query(AppointmentUser).first() or db.query(AppointmentDoctor).first():
        return

    seed_path = Path(__file__).resolve().parents[2] / "data" / "appointment-data.json"
    if not seed_path.exists():
        return

    with seed_path.open("r", encoding="utf-8") as seed_file:
        seed = json.load(seed_file)

    for item in seed.get("users", []):
        db.add(
            AppointmentUser(
                id=item["id"],
                name=item["name"],
                phone=_normalize_phone(item["phone"]),
                password=hash_password(item["password"]),
                email=item.get("email"),
                age=item.get("age"),
                gender=item.get("gender"),
                blood_group=item.get("bloodGroup"),
                role=item.get("role", "user"),
                specialty=item.get("specialty"),
            )
        )

    for item in seed.get("doctors", []):
        seed_working_schedule = _normalize_working_schedule(
            item.get("workingSchedule"),
            fallback_days=item.get("workingDays") or WEEKDAY_NAMES,
            fallback_start=item.get("startTime"),
            fallback_end=item.get("endTime"),
        )
        db.add(
            AppointmentDoctor(
                id=int(item["id"]),
                name=item["name"],
                phone=_normalize_phone(item["phone"]),
                category=item["category"],
                working_days=",".join([slot["day"] for slot in seed_working_schedule]) if seed_working_schedule else ",".join(_normalize_working_days(item.get("workingDays") or WEEKDAY_NAMES)),
                working_schedule=json.dumps(seed_working_schedule),
                start_time=item["startTime"],
                end_time=item["endTime"],
                room=item["room"],
                is_available=item.get("isAvailable", 1),
            )
        )

    for item in seed.get("appointments", []):
        db.add(
            AppointmentBooking(
                id=int(item["id"]),
                patient_name=item["patientName"],
                patient_phone=_normalize_phone(item["patientPhone"]),
                doctor_id=int(item["docId"]),
                doctor_name=item["docName"],
                date=item["date"],
                time=item.get("time"),  # Optional now
                room=item["room"],
                serial_number=item.get("serialNumber"),  # Optional
                status=item.get("status", "Booked"),
                reason=item.get("reason"),
            )
        )

    db.commit()


def _doctor_with_email(db: Session, doctor: AppointmentDoctor) -> AppointmentDoctorOut:
    linked_user = (
        db.query(AppointmentUser)
        .filter(AppointmentUser.phone == doctor.phone, AppointmentUser.role == "doctor")
        .first()
    )
    return _doctor_out(doctor, linked_user.email if linked_user else None)


def _create_staff_user(
    db: Session,
    data: AppointmentStaffCreate,
    role: str,
    created_by: Optional[AppointmentUser] = None,
) -> AppointmentUser:
    phone = _require_phone(data.phone)
    if len(data.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    if db.query(AppointmentUser).filter(AppointmentUser.phone == phone).first():
        raise HTTPException(status_code=400, detail="A user with this phone already exists")

    user = AppointmentUser(
        id="usr_" + uuid4().hex[:12],
        name=data.name.strip(),
        phone=phone,
        password=hash_password(data.password),
        email=data.email,
        role=role,
        specialty=data.specialty,
        created_by_id=created_by.id if created_by else None,
        created_by_name=created_by.name if created_by else None,
    )
    try:
        db.add(user)
        db.commit()
        db.refresh(user)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="This phone is already registered")
    return user


def _get_next_serial_number(db: Session, doctor_id: int, appointment_date: str) -> int:
    """Get the next serial number for a doctor on a given date. Starts from 1."""
    _validate_booking_date(appointment_date)

    max_serial = (
        db.query(func.max(AppointmentBooking.serial_number))
        .filter(
            AppointmentBooking.doctor_id == doctor_id,
            AppointmentBooking.date == appointment_date,
            AppointmentBooking.status == "Booked",
            AppointmentBooking.serial_number.isnot(None),
        )
        .scalar()
    )
    return int(max_serial or 0) + 1


@router.post("/otp/send")
@limiter.limit("5/minute")
def send_otp(request: Request, data: OtpSendRequest):
    phone = _require_phone(data.phone)
    now = datetime.utcnow()
    today = now.date()

    with _otp_lock:
        _cleanup_expired_otps(now)
        _cleanup_daily_limits(today)

        record = _otp_daily_limits.get(phone)
        if record and record["count"] >= 2:
            raise HTTPException(status_code=429, detail="Daily OTP limit reached for this number (Max 2 per day)")

        existing = _otp_store.get(phone)
        if existing and existing["last_sent_at"] + timedelta(seconds=OTP_RESEND_COOLDOWN_SECONDS) > now:
            raise HTTPException(status_code=429, detail="Please wait before requesting another OTP")

        if not record:
            _otp_daily_limits[phone] = {"date": today, "count": 1}
        else:
            record["count"] += 1

        otp = f"{random.SystemRandom().randint(0, 999999):06d}"
        _otp_store[phone] = {
            "otp_hash": _hash_otp(otp),
            "expires_at": now + timedelta(seconds=OTP_TTL_SECONDS),
            "last_sent_at": now,
            "attempts": 0,
        }

    try:
        send_sms(
            number=_sms_phone_number(phone),
            message=f"Your NSGH verification code is {otp}. It expires in 5 minutes.",
        )
    except Exception:
        with _otp_lock:
            rec = _otp_daily_limits.get(phone)
            if rec and rec["date"] == today and rec["count"] > 0:
                rec["count"] -= 1
            existing = _otp_store.get(phone)
            if existing and hmac.compare_digest(existing["otp_hash"], _hash_otp(otp)):
                _otp_store.pop(phone, None)
        raise

    return {"message": "OTP sent successfully", "expiresIn": OTP_TTL_SECONDS}


@router.post("/otp/verify")
@limiter.limit("10/minute")
def verify_otp(request: Request, data: OtpVerifyRequest):
    phone = _require_phone(data.phone)
    otp = str(data.otp or "").strip()
    if not re.match(r"^\d{6}$", otp):
        raise HTTPException(status_code=400, detail="OTP must be 6 digits")

    now = datetime.utcnow()
    with _otp_lock:
        _cleanup_expired_otps(now)
        entry = _otp_store.get(phone)
        if not entry:
            raise HTTPException(status_code=400, detail="OTP expired or not requested")

        entry["attempts"] += 1
        if entry["attempts"] > OTP_MAX_VERIFY_ATTEMPTS:
            _otp_store.pop(phone, None)
            raise HTTPException(status_code=429, detail="Too many OTP attempts")

        if not hmac.compare_digest(entry["otp_hash"], _hash_otp(otp)):
            raise HTTPException(status_code=400, detail="Invalid OTP")

        _otp_store.pop(phone, None)
        _otp_verified_store[phone] = now + timedelta(seconds=OTP_VERIFIED_TTL_SECONDS)

    return {"message": "OTP verified successfully"}


@router.post("/login")
def login(data: AppointmentLoginRequest, db: Session = Depends(get_db)):
    _seed_if_empty(db)
    phone = _normalize_phone(data.phone)
    user = db.query(AppointmentUser).filter(AppointmentUser.phone == phone).first()
    if not user or not verify_password(data.password, user.password):
        raise HTTPException(status_code=401, detail="Invalid phone or password")

    token = create_access_token(
        data={"sub": user.phone, "user_id": user.id, "role": user.role, "scope": "appointment"},
        expires_delta=timedelta(hours=8),
    )
    return {"access_token": token, "token_type": "bearer", "user": _user_out(user)}


@router.get("/data", response_model=AppointmentDataResponse)
def get_data(db: Session = Depends(get_db), current_user: AppointmentUser = Depends(_current_user)):
    _seed_if_empty(db)
    users = []
    if current_user.role == "admin":
        users = [_user_out(user) for user in db.query(AppointmentUser).all()]
    elif current_user.role == "marketing":
        users = [_user_out(user) for user in db.query(AppointmentUser).filter(
            (AppointmentUser.id == current_user.id) | (AppointmentUser.created_by_id == current_user.id)
        ).all()]
    else:
        users = [_user_out(current_user)]

    doctors = [_doctor_with_email(db, doctor) for doctor in db.query(AppointmentDoctor).all()]

    appointments_query = db.query(AppointmentBooking)
    if current_user.role == "user":
        appointments_query = appointments_query.filter(AppointmentBooking.patient_phone == current_user.phone)
    elif current_user.role == "doctor":
        doctor = db.query(AppointmentDoctor).filter(AppointmentDoctor.phone == current_user.phone).first()
        appointments_query = appointments_query.filter(AppointmentBooking.doctor_id == (doctor.id if doctor else -1))
    elif current_user.role == "marketing":
        appointments_query = appointments_query.filter(
            (AppointmentBooking.marketing_officer_id == current_user.id)
            | (AppointmentBooking.booked_by_id == current_user.id)
        )
    elif current_user.role == "commission_doctor":
        appointments_query = appointments_query.filter(
            (AppointmentBooking.commission_doctor_id == current_user.id)
            | (AppointmentBooking.booked_by_id == current_user.id)
        )

    return AppointmentDataResponse(
        users=users,
        doctors=doctors,
        appointments=[],
    )


@router.post("/users", response_model=AppointmentUserOut, status_code=status.HTTP_201_CREATED)
def create_patient(data: AppointmentUserCreate, db: Session = Depends(get_db)):
    _seed_if_empty(db)
    phone = _require_phone(data.phone)
    if data.role != "user":
        raise HTTPException(status_code=400, detail="Use the doctors endpoint to create doctor accounts")
    if len(data.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    user = AppointmentUser(
        id="usr_" + uuid4().hex[:12],
        name=data.name.strip(),
        phone=phone,
        password=hash_password(data.password),
        email=data.email,
        age=data.age,
        gender=data.gender,
        blood_group=data.bloodGroup,
        role="user",
    )
    try:
        db.add(user)
        db.commit()
        db.refresh(user)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="This phone is already registered")
    return _user_out(user)


@router.put("/users/{user_id}", response_model=AppointmentUserOut)
def update_patient(
    user_id: str,
    data: AppointmentUserUpdate,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    _require_role(current_user, "admin")
    user = db.query(AppointmentUser).filter(AppointmentUser.id == user_id, AppointmentUser.role == "user").first()
    if not user:
        raise HTTPException(status_code=404, detail="Patient not found")

    user.name = data.name.strip()
    user.email = data.email
    user.age = data.age
    user.gender = data.gender
    user.blood_group = data.bloodGroup
    db.query(AppointmentBooking).filter(AppointmentBooking.patient_phone == user.phone).update(
        {AppointmentBooking.patient_name: user.name}
    )
    db.commit()
    db.refresh(user)
    return _user_out(user)


@router.delete("/users/{user_id}")
def delete_patient(
    user_id: str,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    _require_role(current_user, "admin")
    user = db.query(AppointmentUser).filter(AppointmentUser.id == user_id, AppointmentUser.role == "user").first()
    if not user:
        raise HTTPException(status_code=404, detail="Patient not found")

    db.query(AppointmentBooking).filter(AppointmentBooking.patient_phone == user.phone).delete()
    db.delete(user)
    db.commit()
    return {"message": "Patient deleted successfully"}


@router.post("/password/reset")
def reset_password(data: AppointmentUserPasswordReset, db: Session = Depends(get_db)):
    _seed_if_empty(db)
    phone = _normalize_phone(data.phone)
    if phone == "admin":
        raise HTTPException(status_code=400, detail="Admin password cannot be reset here")

    now = datetime.utcnow()
    with _otp_lock:
        _cleanup_verified_otps(now)
        expires_at = _otp_verified_store.get(phone)
        if not expires_at or expires_at <= now:
            raise HTTPException(status_code=400, detail="OTP verification required")
        _otp_verified_store.pop(phone, None)
    user = db.query(AppointmentUser).filter(AppointmentUser.phone == phone).first()
    if not user:
        raise HTTPException(status_code=404, detail="No account found with this phone")
    if len(data.newPassword) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    user.password = hash_password(data.newPassword)
    db.commit()
    return {"message": "Password reset successfully"}


@router.post("/password/change")
def change_own_password(
    data: AppointmentUserPasswordChange,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    _require_role(current_user, "marketing")
    if not verify_password(data.currentPassword, current_user.password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if len(data.newPassword) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    current_user.password = hash_password(data.newPassword)
    db.commit()
    return {"message": "Password changed successfully"}


@router.post("/marketing-officers", response_model=AppointmentUserOut, status_code=status.HTTP_201_CREATED)
def create_marketing_officer(
    data: AppointmentStaffCreate,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    _require_role(current_user, "admin")
    return _user_out(_create_staff_user(db, data, "marketing"))


@router.get("/doctors", response_model=list[AppointmentDoctorOut])
def list_doctors(db: Session = Depends(get_db), current_user: AppointmentUser = Depends(_current_user)):
    _seed_if_empty(db)
    return [_doctor_with_email(db, doctor) for doctor in db.query(AppointmentDoctor).all()]


@router.post("/doctors", response_model=AppointmentDoctorOut, status_code=status.HTTP_201_CREATED)
def create_doctor(
    data: AppointmentDoctorCreate,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    _require_role(current_user, "admin")
    phone = _require_phone(data.phone)
    working_schedule = _normalize_working_schedule(
        data.workingSchedule,
        fallback_days=data.workingDays,
        fallback_start=data.startTime,
        fallback_end=data.endTime,
    )
    if len(data.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    if db.query(AppointmentUser).filter(AppointmentUser.phone == phone).first():
        raise HTTPException(status_code=400, detail="A user with this phone already exists")

    doctor = AppointmentDoctor(
        name=data.name.strip(),
        phone=phone,
        category=data.category,
        working_days=",".join([slot["day"] for slot in working_schedule]),
        working_schedule=json.dumps(working_schedule),
        start_time=working_schedule[0]["startTime"] if working_schedule else (data.startTime or "09:00"),
        end_time=working_schedule[0]["endTime"] if working_schedule else (data.endTime or "17:00"),
        room=data.room.strip(),
        is_available=1,  # Default to available
    )
    doctor_user = AppointmentUser(
        id="usr_" + uuid4().hex[:12],
        name=data.name.strip(),
        phone=phone,
        password=hash_password(data.password),
        email=data.email,
        role="doctor",
        specialty=data.category,
    )
    try:
        db.add(doctor)
        db.flush()
        db.add(doctor_user)
        db.commit()
        db.refresh(doctor)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="Doctor phone is already registered")
    return _doctor_out(doctor, data.email)


@router.put("/doctors/{doctor_id}", response_model=AppointmentDoctorOut)
def update_doctor(
    doctor_id: int,
    data: AppointmentDoctorUpdate,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    _require_role(current_user, "admin")
    working_schedule = _normalize_working_schedule(
        data.workingSchedule,
        fallback_days=data.workingDays,
        fallback_start=data.startTime,
        fallback_end=data.endTime,
    )
    doctor = db.query(AppointmentDoctor).filter(AppointmentDoctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")

    doctor.name = data.name.strip()
    doctor.category = data.category
    doctor.working_days = ",".join([slot["day"] for slot in working_schedule])
    doctor.working_schedule = json.dumps(working_schedule)
    doctor.start_time = working_schedule[0]["startTime"] if working_schedule else (data.startTime or doctor.start_time)
    doctor.end_time = working_schedule[0]["endTime"] if working_schedule else (data.endTime or doctor.end_time)
    doctor.room = data.room.strip()
    linked_user = (
        db.query(AppointmentUser)
        .filter(AppointmentUser.phone == doctor.phone, AppointmentUser.role == "doctor")
        .first()
    )
    if linked_user:
        linked_user.name = doctor.name
        linked_user.email = data.email
        linked_user.specialty = doctor.category

    db.query(AppointmentBooking).filter(
        AppointmentBooking.doctor_id == doctor.id,
        AppointmentBooking.status == "Booked",
    ).update({AppointmentBooking.doctor_name: doctor.name, AppointmentBooking.room: doctor.room})
    db.commit()
    db.refresh(doctor)
    return _doctor_out(doctor, data.email)


@router.delete("/doctors/{doctor_id}")
def delete_doctor(
    doctor_id: int,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    _require_role(current_user, "admin")
    doctor = db.query(AppointmentDoctor).filter(AppointmentDoctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")

    db.query(AppointmentUser).filter(AppointmentUser.phone == doctor.phone, AppointmentUser.role == "doctor").delete()
    db.query(AppointmentBooking).filter(
        AppointmentBooking.doctor_id == doctor.id,
        AppointmentBooking.status == "Booked",
    ).update({AppointmentBooking.status: "Cancelled"})
    db.delete(doctor)
    db.commit()
    return {"message": "Doctor deleted and active appointments cancelled"}


@router.patch("/doctors/{doctor_id}/availability", response_model=AppointmentDoctorOut)
def toggle_doctor_availability(
    doctor_id: int,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    """Toggle doctor availability (admin only)"""
    _require_role(current_user, "admin")
    doctor = db.query(AppointmentDoctor).filter(AppointmentDoctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    
    # Toggle availability: if 1, make 0; if 0, make 1
    doctor.is_available = 0 if doctor.is_available else 1
    db.commit()
    db.refresh(doctor)
    return _doctor_out(doctor)


@router.get("/appointments", response_model=list[AppointmentOut])
def list_appointments(
    date: Optional[str] = None,
    doctor_id: Optional[int] = None,
    status: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db), 
    current_user: AppointmentUser = Depends(_current_user)
):
    query = db.query(AppointmentBooking)
    if current_user.role == "user":
        query = query.filter(AppointmentBooking.patient_phone == current_user.phone)
    elif current_user.role == "doctor":
        doctor = db.query(AppointmentDoctor).filter(AppointmentDoctor.phone == current_user.phone).first()
        query = query.filter(AppointmentBooking.doctor_id == (doctor.id if doctor else -1))
    elif current_user.role == "marketing":
        query = query.filter(
            (AppointmentBooking.marketing_officer_id == current_user.id)
            | (AppointmentBooking.booked_by_id == current_user.id)
        )
    elif current_user.role == "commission_doctor":
        query = query.filter(
            (AppointmentBooking.commission_doctor_id == current_user.id)
            | (AppointmentBooking.booked_by_id == current_user.id)
        )
    elif current_user.role != "admin":
        raise HTTPException(status_code=403, detail="You do not have permission for this action")

    if date:
        query = query.filter(AppointmentBooking.date == date)
    if doctor_id:
        query = query.filter(AppointmentBooking.doctor_id == doctor_id)
    if status:
        query = query.filter(AppointmentBooking.status == status)

    if date:
        query = query.order_by(AppointmentBooking.serial_number.asc())
    else:
        query = query.order_by(AppointmentBooking.date.desc(), AppointmentBooking.serial_number.asc())

    return [_appointment_out(appointment) for appointment in query.offset(skip).limit(limit).all()]


@router.post("/appointments", response_model=AppointmentSuccessResponse)
def create_appointment(
    data: AppointmentCreate,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    """Create a new appointment using queue system"""
    _require_role(current_user, "user", "admin", "marketing", "commission_doctor")
    _validate_booking_date(data.date)
    selected_date = _parse_date(data.date)
    
    doctor = db.query(AppointmentDoctor).filter(AppointmentDoctor.id == data.docId).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    
    if not doctor.is_available:
        raise HTTPException(status_code=400, detail="This doctor is currently unavailable")

    schedule_item = _doctor_schedule_for_date(doctor, selected_date)
    weekday_name = WEEKDAY_NAMES[selected_date.weekday()]
    if not _is_allowed_booking_day(doctor, selected_date):
        raise HTTPException(status_code=400, detail=f"Doctor does not take appointments on {weekday_name}")

    if schedule_item and selected_date == date.today():
        now = datetime.now()
        now_minutes = now.hour * 60 + now.minute
        start_minutes = _parse_time(schedule_item["startTime"])
        if now_minutes >= start_minutes:
            raise HTTPException(
                status_code=400,
                detail="Booking for today is closed. You can book only before the doctor's start time",
            )

    if current_user.role == "user":
        patient_name = current_user.name
        patient_phone = current_user.phone
    else:
        patient_name = (data.patientName or "").strip()
        if len(patient_name) < 2:
            raise HTTPException(status_code=400, detail="Patient name is required")
        patient_phone = _require_phone(data.patientPhone or "")

    # Check if patient already has an appointment with this doctor on this date
    patient_conflict = (
        db.query(AppointmentBooking)
        .filter(
            AppointmentBooking.patient_phone == patient_phone,
            AppointmentBooking.doctor_id == doctor.id,
            AppointmentBooking.date == data.date,
            AppointmentBooking.status == "Booked",
        )
        .first()
    )
    if patient_conflict:
        raise HTTPException(status_code=409, detail="This patient already has an appointment with this doctor on this date")

    # Get next serial number for the queue
    serial_number = _get_next_serial_number(db, doctor.id, data.date)

    marketing_officer_id = None
    marketing_officer_name = None
    commission_doctor_id = None
    commission_doctor_name = None
    if current_user.role == "marketing":
        marketing_officer_id = current_user.id
        marketing_officer_name = current_user.name
    elif current_user.role == "commission_doctor":
        commission_doctor_id = current_user.id
        commission_doctor_name = current_user.name
        marketing_officer_id = current_user.created_by_id
        marketing_officer_name = current_user.created_by_name

    appointment = AppointmentBooking(
        patient_name=patient_name,
        patient_phone=patient_phone,
        doctor_id=doctor.id,
        doctor_name=doctor.name,
        date=data.date,
        time=None,  # No time selection anymore, queue based
        room=doctor.room,
        serial_number=serial_number,
        status="Booked",
        reason=(data.reason or "")[:180],
        booked_by_id=current_user.id,
        booked_by_name=current_user.name,
        booked_by_role=current_user.role,
        marketing_officer_id=marketing_officer_id,
        marketing_officer_name=marketing_officer_name,
        commission_doctor_id=commission_doctor_id,
        commission_doctor_name=commission_doctor_name,
    )
    db.add(appointment)
    db.commit()
    db.refresh(appointment)
    
    appointment_out = _appointment_out(appointment)
    
    try:
        sms_message = (
            f"NSGH Appointment Confirmed.\n"
            f"Patient: {patient_name}\n"
            f"Dr: {doctor.name}\n"
            f"Date: {data.date}\n"
            f"Serial: #{serial_number}"
        )
        send_sms(number=_sms_phone_number(patient_phone), message=sms_message)
    except Exception as e:
        # Log the SMS failure so it can be debugged, but don't fail the booking
        print(f"Failed to send booking SMS to {patient_phone}: {str(e)}")

    return AppointmentSuccessResponse(
        message=f"Appointment booked successfully for {patient_name}",
        details=appointment_out,
        serial_number=serial_number,
        queue_position=f"Position #{serial_number} in queue"
    )


@router.patch("/appointments/{appointment_id}/status", response_model=AppointmentOut)
def update_appointment_status(
    appointment_id: int,
    data: AppointmentStatusUpdate,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    if data.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid appointment status")

    appointment = db.query(AppointmentBooking).filter(AppointmentBooking.id == appointment_id).first()
    if not appointment:
        raise HTTPException(status_code=404, detail="Appointment not found")

    if current_user.role == "doctor":
        doctor = db.query(AppointmentDoctor).filter(AppointmentDoctor.phone == current_user.phone).first()
        if not doctor or appointment.doctor_id != doctor.id:
            raise HTTPException(status_code=403, detail="You can only update your own appointments")
    else:
        _require_role(current_user, "admin")

    appointment.status = data.status
    db.commit()
    db.refresh(appointment)
    return _appointment_out(appointment)


@router.get("/appointments/{appointment_id}/pdf")
def generate_appointment_pdf(
    appointment_id: int,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user)
):
    appointment = db.query(AppointmentBooking).filter(AppointmentBooking.id == appointment_id).first()
    if not appointment:
        raise HTTPException(status_code=404, detail="Appointment not found")

    if current_user.role == "user" and appointment.patient_phone != current_user.phone:
        raise HTTPException(status_code=403, detail="Not authorized to view this appointment")
    elif current_user.role == "doctor":
        doctor = db.query(AppointmentDoctor).filter(AppointmentDoctor.phone == current_user.phone).first()
        if not doctor or appointment.doctor_id != doctor.id:
            raise HTTPException(status_code=403, detail="Not authorized to view this appointment")
    elif current_user.role in ["marketing", "commission_doctor"]:
        if appointment.marketing_officer_id != current_user.id and \
           appointment.commission_doctor_id != current_user.id and \
           appointment.booked_by_id != current_user.id:
            raise HTTPException(status_code=403, detail="Not authorized to view this appointment")

    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas
        from reportlab.lib import colors
        import textwrap
    except ImportError:
        raise HTTPException(status_code=500, detail="PDF generation library (reportlab) not installed. Please install it using 'pip install reportlab'.")

    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4

    c.setFont("Helvetica-Bold", 24)
    c.setFillColor(colors.HexColor("#241d4e"))
    c.drawCentredString(width / 2.0, height - 50, "New Shafipur General Hospital")
    
    c.setFont("Helvetica", 10)
    c.setFillColor(colors.darkgray)
    c.drawCentredString(width / 2.0, height - 65, "Shafipur Bazar, Kaliakair, Gazipur-1751")
    c.drawCentredString(width / 2.0, height - 77, "Phone: +880 1711-902062 | Email: support@nsgh.com")
    
    c.setLineWidth(1)
    c.setStrokeColor(colors.lightgrey)
    c.line(50, height - 90, width - 50, height - 90)

    c.setFont("Helvetica-Bold", 16)
    c.setFillColor(colors.black)
    c.drawCentredString(width / 2.0, height - 120, "APPOINTMENT SLIP")

    start_y = height - 160
    col1_x = 50
    col2_x = width / 2.0 + 10
    line_height = 25
    
    def draw_field(c, x, y, label, value):
        c.setFont("Helvetica-Bold", 11)
        c.setFillColor(colors.HexColor("#4a5764"))
        c.drawString(x, y, f"{label}:")
        c.setFont("Helvetica", 11)
        c.setFillColor(colors.black)
        c.drawString(x + 120, y, str(value) if value else "-")

    draw_field(c, col1_x, start_y, "Appointment ID", f"#{appointment.id:06d}")
    draw_field(c, col2_x, start_y, "Status", appointment.status)
    
    start_y -= line_height
    draw_field(c, col1_x, start_y, "Date", appointment.date)
    if appointment.serial_number:
        draw_field(c, col2_x, start_y, "Serial", f"#{appointment.serial_number}")
    else:
        draw_field(c, col2_x, start_y, "Time", appointment.time or "-")

    start_y -= line_height
    draw_field(c, col1_x, start_y, "Doctor Name", appointment.doctor_name)
    draw_field(c, col2_x, start_y, "Room", appointment.room)
    
    start_y -= 15
    c.setLineWidth(0.5)
    c.setStrokeColor(colors.lightgrey)
    c.line(50, start_y, width - 50, start_y)
    
    start_y -= 20
    draw_field(c, col1_x, start_y, "Patient Name", appointment.patient_name)
    draw_field(c, col2_x, start_y, "Patient Phone", appointment.patient_phone)
    
    start_y -= line_height
    booked_by = "Patient self-booking"
    if appointment.booked_by_name and appointment.booked_by_role != "user":
        booked_by = f"{appointment.booked_by_name} ({appointment.booked_by_role})"
    draw_field(c, col1_x, start_y, "Booked By", booked_by)
    if appointment.marketing_officer_name:
        draw_field(c, col2_x, start_y, "Marketing Officer", appointment.marketing_officer_name)
    elif appointment.commission_doctor_name:
        draw_field(c, col2_x, start_y, "Commission Doctor", appointment.commission_doctor_name)
        
    start_y -= line_height
    reason = appointment.reason or "Not provided"
    wrapped_reason = textwrap.wrap(reason, width=80)
    c.setFont("Helvetica-Bold", 11)
    c.setFillColor(colors.HexColor("#4a5764"))
    c.drawString(col1_x, start_y, "Reason:")
    
    c.setFont("Helvetica", 11)
    c.setFillColor(colors.black)
    if wrapped_reason:
        for line in wrapped_reason:
            c.drawString(col1_x + 120, start_y, line)
            start_y -= 15
    else:
        c.drawString(col1_x + 120, start_y, "-")
        start_y -= 15
        
    start_y -= 20
    c.setFont("Helvetica", 10)
    c.setFillColor(colors.gray)
    c.drawString(col1_x, start_y, f"Issued At: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}")
    
    c.setFont("Helvetica-Oblique", 10)
    c.setFillColor(colors.gray)
    c.drawCentredString(width / 2.0, 50, "Please bring this slip and arrive 15 minutes before your appointment.")
    
    c.showPage()
    c.save()
    
    buffer.seek(0)
    
    patient_clean = re.sub(r'[^a-zA-Z0-9]+', '-', appointment.patient_name or 'patient').strip('-').lower()
    filename = f"appointment-{appointment.id:06d}-{patient_clean}.pdf"
    
    headers = {
        "Content-Disposition": f'inline; filename="{filename}"'
    }
    return StreamingResponse(buffer, media_type="application/pdf", headers=headers)


@router.post("/appointments/{appointment_id}/cancel", response_model=AppointmentOut)
def cancel_appointment(
    appointment_id: int,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    _require_role(current_user, "admin", "marketing", "commission_doctor", "user")
    appointment = db.query(AppointmentBooking).filter(AppointmentBooking.id == appointment_id).first()
    if not appointment:
        raise HTTPException(status_code=404, detail="Appointment not found")
    if current_user.role == "user" and appointment.patient_phone != current_user.phone:
        raise HTTPException(status_code=403, detail="You can only cancel your own appointments")
    if current_user.role == "marketing" and not (
        appointment.marketing_officer_id == current_user.id or appointment.booked_by_id == current_user.id
    ):
        raise HTTPException(status_code=403, detail="You can only cancel your own serials")
    if current_user.role == "commission_doctor" and not (
        appointment.commission_doctor_id == current_user.id or appointment.booked_by_id == current_user.id
    ):
        raise HTTPException(status_code=403, detail="You can only cancel your own serials")

    appointment.status = "Cancelled"
    db.commit()
    db.refresh(appointment)
    return _appointment_out(appointment)