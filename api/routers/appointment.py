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
BOOKING_WINDOW_DAYS = 90
TIME_RE = re.compile(r"^\d{2}:\d{2}$")
PHONE_RE = re.compile(r"^\+?\d{7,15}$|^admin$")
OTP_TTL_SECONDS = 300
OTP_RESEND_COOLDOWN_SECONDS = 60
OTP_MAX_VERIFY_ATTEMPTS = 3
OTP_VERIFIED_TTL_SECONDS = 600
_otp_store: dict[str, dict] = {}
_otp_verified_store: dict[str, datetime] = {}
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
    if selected < today or selected > today + timedelta(days=BOOKING_WINDOW_DAYS):
        raise HTTPException(
            status_code=400,
            detail=f"Appointment date must be within the next {BOOKING_WINDOW_DAYS} days",
        )


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
    return AppointmentDoctorOut(
        id=doctor.id,
        name=doctor.name,
        phone=doctor.phone,
        category=doctor.category,
        startTime=doctor.start_time,
        endTime=doctor.end_time,
        time=_schedule_label(doctor.start_time, doctor.end_time),
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
        db.add(
            AppointmentDoctor(
                id=int(item["id"]),
                name=item["name"],
                phone=_normalize_phone(item["phone"]),
                category=item["category"],
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

    with _otp_lock:
        _cleanup_expired_otps(now)
        existing = _otp_store.get(phone)
        if existing and existing["last_sent_at"] + timedelta(seconds=OTP_RESEND_COOLDOWN_SECONDS) > now:
            raise HTTPException(status_code=429, detail="Please wait before requesting another OTP")

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
    except HTTPException:
        with _otp_lock:
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
        appointments=[_appointment_out(appointment) for appointment in appointments_query.all()],
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
    _validate_schedule(data.startTime, data.endTime)
    if len(data.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    if db.query(AppointmentUser).filter(AppointmentUser.phone == phone).first():
        raise HTTPException(status_code=400, detail="A user with this phone already exists")

    doctor = AppointmentDoctor(
        name=data.name.strip(),
        phone=phone,
        category=data.category,
        start_time=data.startTime,
        end_time=data.endTime,
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
    _validate_schedule(data.startTime, data.endTime)
    doctor = db.query(AppointmentDoctor).filter(AppointmentDoctor.id == doctor_id).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")

    doctor.name = data.name.strip()
    doctor.category = data.category
    doctor.start_time = data.startTime
    doctor.end_time = data.endTime
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

    if date:
        query = query.order_by(AppointmentBooking.serial_number.asc())
    else:
        query = query.order_by(AppointmentBooking.date.desc(), AppointmentBooking.serial_number.asc())

    return [_appointment_out(appointment) for appointment in query.all()]


@router.post("/appointments", response_model=AppointmentSuccessResponse)
def create_appointment(
    data: AppointmentCreate,
    db: Session = Depends(get_db),
    current_user: AppointmentUser = Depends(_current_user),
):
    """Create a new appointment using queue system"""
    _require_role(current_user, "user", "admin", "marketing", "commission_doctor")
    _validate_booking_date(data.date)
    
    doctor = db.query(AppointmentDoctor).filter(AppointmentDoctor.id == data.docId).first()
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    
    if not doctor.is_available:
        raise HTTPException(status_code=400, detail="This doctor is currently unavailable")

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
    c.setFillColor(colors.HexColor("#1e0b9b"))
    c.drawCentredString(width / 2.0, height - 50, "NSGH Care")
    
    c.setFont("Helvetica", 10)
    c.setFillColor(colors.darkgray)
    c.drawCentredString(width / 2.0, height - 65, "123 Health Avenue, Medical District, City, Country")
    c.drawCentredString(width / 2.0, height - 77, "Phone: +880 123 456 789 | Email: info@nsghcare.com")
    
    c.setLineWidth(1)
    c.setStrokeColor(colors.lightgrey)
    c.line(50, height - 90, width - 50, height - 90)

    c.setFont("Helvetica-Bold", 16)
    c.setFillColor(colors.black)
    c.drawCentredString(width / 2.0, height - 120, "APPOINTMENT SLIP")

    text_obj = c.beginText(50, height - 160)
    text_obj.setLeading(22)
    
    def add_field(label, value):
        text_obj.setFont("Helvetica-Bold", 12)
        text_obj.setFillColor(colors.HexColor("#4a5764"))
        text_obj.textOut(f"{label}: ")
        text_obj.setFont("Helvetica", 12)
        text_obj.setFillColor(colors.black)
        text_obj.textLine(str(value) if value else "-")

    add_field("Appointment ID", f"#{appointment.id:06d}")
    add_field("Status", appointment.status)
    add_field("Date", appointment.date)
    if appointment.serial_number:
        add_field("Serial", f"#{appointment.serial_number}")
    else:
        add_field("Time", appointment.time or "-")
    add_field("Room", appointment.room)
    text_obj.textLine("")
    add_field("Patient Name", appointment.patient_name)
    add_field("Patient Phone", appointment.patient_phone)
    text_obj.textLine("")
    add_field("Doctor Name", appointment.doctor_name)
    
    booked_by = "Patient self-booking"
    if appointment.booked_by_name and appointment.booked_by_role != "user":
        booked_by = f"{appointment.booked_by_name} ({appointment.booked_by_role})"
    add_field("Booked By", booked_by)
    if appointment.marketing_officer_name:
        add_field("Marketing Officer", appointment.marketing_officer_name)
    if appointment.commission_doctor_name:
        add_field("Commission Doctor", appointment.commission_doctor_name)
        
    reason = appointment.reason or "Not provided"
    wrapped_reason = textwrap.wrap(reason, width=60)
    text_obj.setFont("Helvetica-Bold", 12)
    text_obj.setFillColor(colors.HexColor("#4a5764"))
    text_obj.textOut("Reason: ")
    text_obj.setFont("Helvetica", 12)
    text_obj.setFillColor(colors.black)
    if wrapped_reason:
        text_obj.textLine(wrapped_reason[0])
        for line in wrapped_reason[1:]:
            text_obj.textOut("        ")
            text_obj.textLine(line)
    else:
        text_obj.textLine("-")
        
    text_obj.textLine("")
    add_field("Issued At", datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC"))
    
    c.drawText(text_obj)
    
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
    _require_role(current_user, "admin", "marketing", "commission_doctor")
    appointment = db.query(AppointmentBooking).filter(AppointmentBooking.id == appointment_id).first()
    if not appointment:
        raise HTTPException(status_code=404, detail="Appointment not found")
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