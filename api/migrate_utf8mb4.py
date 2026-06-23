"""
One-shot migration: convert the appointment tables (and the database default)
to utf8mb4 so Bangla / other multibyte text is no longer stored as "?".

Idempotent: re-running on already-utf8mb4 tables is a no-op.
Safe to run while the API is up, though it briefly locks each table.

Usage:
    python -m api.migrate_utf8mb4
"""

import os
import sys

if __package__ is None or __package__ == "":
    sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from sqlalchemy import text

from api.database import engine


TABLES = (
    "users",
    "doctors",
    "messages",
    "staffs",
    "gallery",
    "machineries",
    "departments",
    "about",
    "appointment_users",
    "appointment_doctors",
    "categories",
    "notices",
    "appointment_bookings",
    "manual_sms",
)
TARGET_CHARSET = "utf8mb4"
TARGET_COLLATION = "utf8mb4_unicode_ci"


def migrate() -> None:
    if not engine.url.get_backend_name().startswith("mysql"):
        print("Not a MySQL connection — nothing to convert. Aborting.")
        return

    with engine.connect() as connection:
        db_name = connection.execute(text("SELECT DATABASE()")).scalar()
        if not db_name:
            print("Could not resolve current database name. Aborting.")
            return

        print(f"Database: {db_name}")
        print(f"Target:   {TARGET_CHARSET} / {TARGET_COLLATION}\n")

        default_charset = connection.execute(
            text(
                "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME "
                "FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = :db"
            ),
            {"db": db_name},
        ).first()
        if default_charset and default_charset[0] != TARGET_CHARSET:
            print(f"DB default: {default_charset[0]}/{default_charset[1]} → converting")
            connection.execute(
                text(
                    f"ALTER DATABASE `{db_name}` "
                    f"CHARACTER SET {TARGET_CHARSET} COLLATE {TARGET_COLLATION}"
                )
            )
            print(f"✓ Database default set to {TARGET_CHARSET}/{TARGET_COLLATION}")
        else:
            print(f"✓ Database default already {TARGET_CHARSET}")

        for table in TABLES:
            row = connection.execute(
                text(
                    "SELECT TABLE_COLLATION FROM information_schema.TABLES "
                    "WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :table"
                ),
                {"db": db_name, "table": table},
            ).first()
            if not row:
                print(f"– {table}: not found, skipping")
                continue

            current = row[0] or ""
            if current.startswith(TARGET_CHARSET):
                print(f"✓ {table}: already {current}")
                continue

            print(f"  {table}: {current} → converting…")
            connection.execute(
                text(
                    f"ALTER TABLE `{table}` "
                    f"CONVERT TO CHARACTER SET {TARGET_CHARSET} "
                    f"COLLATE {TARGET_COLLATION}"
                )
            )
            print(f"✓ {table}: converted to {TARGET_CHARSET}/{TARGET_COLLATION}")

        connection.commit()
        print("\n✅ utf8mb4 migration complete.")
        print(
            "Note: rows that already contain '?' were lossy-encoded at insert time "
            "and cannot be recovered. New inserts will round-trip correctly."
        )


if __name__ == "__main__":
    migrate()
