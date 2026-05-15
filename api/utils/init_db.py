"""
One-time database initialization on app startup.
Creates tables and minimal dummy data only if they don't exist.
"""
import json
import os
import sys
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

if __package__ is None or __package__ == "":
    sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from api.database import engine, Base
from api.models import AppointmentUser, AppointmentDoctor, AppointmentBooking
from api.utils.security import hash_password


def _normalize_phone(phone: str) -> str:
    """Normalize phone number for storage."""
    if not phone:
        return phone
    if phone.lower() == "admin":
        return "admin"
    # Remove non-digit characters except leading +
    cleaned = "".join(c for c in phone if c.isdigit() or c == "+")
    return cleaned if cleaned else phone


def _get_minimal_dummy_data():
    """Generate minimal dummy data for testing."""
    today = datetime.now().date()
    tomorrow = today + timedelta(days=1)
    
    return {
        "users": [
            {
                "id": "usr_admin",
                "name": "System Admin",
                "phone": "admin",
                "password": "admin123",
                "email": "admin@nsghcare.com",
                "role": "admin"
            },
            {
                "id": "usr_001",
                "name": "Test Patient",
                "phone": "9801234567",
                "password": "password123",
                "age": 30,
                "gender": "Male",
                "email": "patient@example.com",
                "role": "user"
            },
            {
                "id": "usr_doc_001",
                "name": "Dr. Sample",
                "phone": "9809999991",
                "password": "doctor123",
                "email": "doctor@hospital.com",
                "role": "doctor",
                "specialty": "General"
            }
        ],
        "doctors": [
            {
                "id": 1,
                "name": "Dr. Sample",
                "phone": "9809999991",
                "category": "General Physician",
                "startTime": "09:00",
                "endTime": "17:00",
                "room": "101"
            }
        ],
        "appointments": []
    }


def initialize_database() -> None:
    """
    Initialize database on app startup.
    - Creates all tables if they don't exist
    - Seeds minimal dummy data only if tables are empty
    """
    # Create all tables
    Base.metadata.create_all(bind=engine)
    
    # Check if data already exists
    db = Session(bind=engine)
    try:
        existing_users = db.query(AppointmentUser).first()
        if existing_users:
            # Database already has data, skip seeding
            return
        
        # Seed minimal dummy data
        seed_data = _get_minimal_dummy_data()
        
        # Add users
        for item in seed_data.get("users", []):
            user = AppointmentUser(
                id=item["id"],
                name=item["name"],
                phone=_normalize_phone(item["phone"]),
                password=hash_password(item["password"]),
                email=item.get("email"),
                age=item.get("age"),
                gender=item.get("gender"),
                role=item.get("role", "user"),
                specialty=item.get("specialty"),
            )
            db.add(user)
        
        # Add doctors
        for item in seed_data.get("doctors", []):
            doctor = AppointmentDoctor(
                id=int(item["id"]),
                name=item["name"],
                phone=_normalize_phone(item["phone"]),
                category=item["category"],
                working_schedule=json.dumps([
                    {
                        "day": day,
                        "startTime": item["startTime"],
                        "endTime": item["endTime"],
                    }
                    for day in (
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Saturday",
                        "Sunday",
                    )
                ]),
                room=item["room"],
                is_available=1,
            )
            db.add(doctor)
        
        db.commit()
        print("✓ Database initialized with minimal dummy data")
        
    except Exception as e:
        db.rollback()
        print(f"Error initializing database: {e}")
    finally:
        db.close()
