"""
Database migration script to add new columns for queue-based appointment system.
Run this script to update existing database tables with missing columns.
"""

import json
import os
import sys

if __package__ is None or __package__ == "":
    sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from sqlalchemy import inspect, text

from api.database import engine

WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _parse_working_days(raw_days):
    if not raw_days:
        return WEEKDAY_NAMES.copy()
    if isinstance(raw_days, str):
        value = raw_days.strip()
        if value.startswith("["):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, list) and parsed:
                    return [str(day).strip() for day in parsed if str(day).strip()]
            except Exception:
                pass
        parts = [item.strip() for item in value.split(",") if item.strip()]
        return parts or WEEKDAY_NAMES.copy()
    if isinstance(raw_days, list):
        parts = [str(item).strip() for item in raw_days if str(item).strip()]
        return parts or WEEKDAY_NAMES.copy()
    return WEEKDAY_NAMES.copy()


def _build_working_schedule(raw_days, start_time, end_time):
    days = _parse_working_days(raw_days)
    if not start_time or not end_time:
        return []
    return [
        {"day": day, "startTime": str(start_time), "endTime": str(end_time)}
        for day in days
    ]


def migrate():
    """Add missing columns and backfill appointment_doctors working_schedule."""

    with engine.connect() as connection:
        inspector = inspect(connection)

        try:
            print("Checking appointment_doctors table...")
            connection.execute(text("""
                ALTER TABLE appointment_doctors
                ADD COLUMN is_available INT NOT NULL DEFAULT 1
            """))
            print("✓ Added is_available column to appointment_doctors")
        except Exception as e:
            if "Duplicate column name" in str(e) or "is_available" in str(e):
                print("✓ is_available column already exists in appointment_doctors")
            else:
                print(f"Error adding is_available column: {e}")

        try:
            print("Checking working_schedule column on appointment_doctors...")
            connection.execute(text("""
                ALTER TABLE appointment_doctors
                ADD COLUMN working_schedule VARCHAR(2000) NOT NULL DEFAULT '[]'
            """))
            print("✓ Added working_schedule column to appointment_doctors")
        except Exception as e:
            if "Duplicate column name" in str(e) or "working_schedule" in str(e):
                print("✓ working_schedule column already exists in appointment_doctors")
            else:
                print(f"Error adding working_schedule column: {e}")

        doctor_columns = {column["name"] for column in inspector.get_columns("appointment_doctors")}
        has_working_days = "working_days" in doctor_columns
        has_start_time = "start_time" in doctor_columns
        has_end_time = "end_time" in doctor_columns

        if "working_schedule" in doctor_columns and (has_working_days or has_start_time or has_end_time):
            select_columns = ["id", "working_schedule"]
            if has_working_days:
                select_columns.append("working_days")
            if has_start_time:
                select_columns.append("start_time")
            if has_end_time:
                select_columns.append("end_time")

            rows = connection.execute(text(f"SELECT {', '.join(select_columns)} FROM appointment_doctors")).mappings().all()
            updated_count = 0
            for row in rows:
                current_schedule = str(row.get("working_schedule") or "").strip()
                if current_schedule and current_schedule != "[]":
                    continue

                legacy_days = row.get("working_days") if has_working_days else None
                legacy_start = row.get("start_time") if has_start_time else None
                legacy_end = row.get("end_time") if has_end_time else None
                working_schedule = _build_working_schedule(legacy_days, legacy_start, legacy_end)
                if not working_schedule:
                    continue

                connection.execute(
                    text("UPDATE appointment_doctors SET working_schedule = :working_schedule WHERE id = :id"),
                    {"working_schedule": json.dumps(working_schedule), "id": row["id"]},
                )
                updated_count += 1

            if updated_count:
                print(f"✓ Backfilled working_schedule for {updated_count} appointment_doctors row(s)")
            else:
                print("✓ No appointment_doctors rows needed working_schedule backfill")

        try:
            print("Checking appointment_bookings table...")
            connection.execute(text("""
                ALTER TABLE appointment_bookings
                MODIFY COLUMN time VARCHAR(5) NULL
            """))
            print("✓ Made time column nullable in appointment_bookings")
        except Exception as e:
            if "Duplicate" in str(e):
                print("✓ time column already nullable in appointment_bookings")
            else:
                print(f"Note: {e}")

        try:
            print("Checking patient_age column...")
            connection.execute(text("""
                ALTER TABLE appointment_bookings
                ADD COLUMN patient_age INT NULL
            """))
            print("✓ Added patient_age column to appointment_bookings")
        except Exception as e:
            if "Duplicate column name" in str(e) or "patient_age" in str(e):
                print("✓ patient_age column already exists in appointment_bookings")
            else:
                print(f"Error adding patient_age column: {e}")

        try:
            print("Checking serial_number column...")
            connection.execute(text("""
                ALTER TABLE appointment_bookings
                ADD COLUMN serial_number INT NULL
            """))
            print("✓ Added serial_number column to appointment_bookings")
        except Exception as e:
            if "Duplicate column name" in str(e) or "serial_number" in str(e):
                print("✓ serial_number column already exists in appointment_bookings")
            else:
                print(f"Error adding serial_number column: {e}")

        try:
            print("Checking doctor_status_changed column...")
            connection.execute(text("""
                ALTER TABLE appointment_bookings
                ADD COLUMN doctor_status_changed INT NOT NULL DEFAULT 0
            """))
            print("✓ Added doctor_status_changed column to appointment_bookings")
        except Exception as e:
            if "Duplicate column name" in str(e) or "doctor_status_changed" in str(e):
                print("✓ doctor_status_changed column already exists in appointment_bookings")
            else:
                print(f"Error adding doctor_status_changed column: {e}")

        user_columns = {column["name"] for column in inspector.get_columns("appointment_users")}
        if "blood_group" in user_columns:
            try:
                print("Dropping legacy blood_group column from appointment_users...")
                connection.execute(text("ALTER TABLE appointment_users DROP COLUMN blood_group"))
                print("✓ Dropped blood_group column from appointment_users")
            except Exception as e:
                print(f"Error dropping blood_group column: {e}")
        else:
            print("✓ blood_group column already absent from appointment_users")

        connection.commit()
        print("\n✅ Migration completed successfully!")


if __name__ == "__main__":
    migrate()
