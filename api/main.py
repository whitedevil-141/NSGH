import os
import sys

if __package__ is None or __package__ == "":
    sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from fastapi import FastAPI, Request, Response
from api.database import engine, Base
from sqlalchemy import inspect, text
from api.routers import auth, public, doctors, staffs, appointment
from api.limiter import limiter
from api.utils.init_db import initialize_database
from slowapi.errors import RateLimitExceeded
from fastapi.middleware.cors import CORSMiddleware

# Initialize database (creates tables & minimal seed data if needed)
initialize_database()


def ensure_appointment_schema() -> None:
    columns_to_add = {
        "appointment_users": {
            "created_by_id": "VARCHAR(32) NULL",
            "created_by_name": "VARCHAR(100) NULL",
        },
        "appointment_bookings": {
            "time": "VARCHAR(5) NULL",
            "patient_age": "INT NULL",
            "booked_by_id": "VARCHAR(32) NULL",
            "booked_by_name": "VARCHAR(100) NULL",
            "booked_by_role": "VARCHAR(20) NULL",
            "marketing_officer_id": "VARCHAR(32) NULL",
            "marketing_officer_name": "VARCHAR(100) NULL",
            "commission_doctor_id": "VARCHAR(32) NULL",
            "commission_doctor_name": "VARCHAR(100) NULL",
            "serial_number": "INT NULL",
        },
        "appointment_doctors": {
            "is_available": "INT NOT NULL DEFAULT 1",
            "working_schedule": "VARCHAR(2000) NOT NULL DEFAULT '[]'",
        },
    }
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    with engine.begin() as conn:
        for table_name, columns in columns_to_add.items():
            if table_name not in table_names:
                continue
            existing_columns = {column["name"] for column in inspector.get_columns(table_name)}
            for column_name, column_sql in columns.items():
                if column_name not in existing_columns:
                    conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_sql}"))

        if "appointment_bookings" in table_names:
            try:
                booking_columns = {col["name"]: col for col in inspector.get_columns("appointment_bookings")}
                time_column = booking_columns.get("time")
                if time_column and not time_column.get("nullable", True):
                    dialect = engine.dialect.name
                    if dialect == "mysql":
                        conn.execute(text("ALTER TABLE appointment_bookings MODIFY COLUMN time VARCHAR(5) NULL"))
                    elif dialect == "postgresql":
                        conn.execute(text("ALTER TABLE appointment_bookings ALTER COLUMN time DROP NOT NULL"))
            except Exception:
                pass


ensure_appointment_schema()

app = FastAPI(
    title="NSGH Hospital Backend API",
)


# attach limiter
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, lambda request, exc: Response(
    "Too Many Requests", status_code=429
))





app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(auth.router, prefix="/auth")
app.include_router(public.router, prefix="/public")
app.include_router(doctors.router, prefix="/doctors")
app.include_router(staffs.router, prefix="/staffs")
app.include_router(appointment.router, prefix="/appointment")
# app.include_router(gallery.router)
# app.include_router(machineries.router)
# app.include_router(departments.router)
# app.include_router(about.router)


@app.get("/", tags=["root"])
@limiter.limit("30/minute")  # Optional per-route limit
def root(request: Request):
    return {
        "message": "Welcome to NSGH API 🚀",
        "docs_url": "/docs",
        "redoc_url": "/redoc",
        "version": "1.0.0"
    }


@app.on_event("startup")
def run_auto_migrations():
    """Run idempotent migrations once at API startup.

    This will attempt to apply schema migrations and utf8mb4 conversions.
    Errors are caught and logged but won't stop the app from starting.
    """
    try:
        import api.migrate as _migrate
        _migrate.migrate()
    except Exception as e:
        print(f"Migration error: {e}")

    try:
        import api.migrate_utf8mb4 as _migrateutf
        _migrateutf.migrate()
    except Exception as e:
        print(f"utf8mb4 migration error: {e}")

    # Run a read-only schema check and print a report for operator review.
    try:
        from api.utils.db_check import check_schema
        from api.database import Base as _Base
        # apply=True will attempt safe automatic fixes (ADD COLUMN, nullability)
        check_schema(engine, _Base, apply=True)
    except Exception as e:
        print(f"DB schema check error: {e}")
