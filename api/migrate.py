"""
Database migration script to add new columns for queue-based appointment system.
Run this script to update existing database tables with missing columns.
"""

from sqlalchemy import text
from database import engine

def migrate():
    """Add missing columns to appointment_doctors and appointment_bookings tables"""
    
    with engine.connect() as connection:
        try:
            # Add is_available column to appointment_doctors if it doesn't exist
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
            # Make time column nullable in appointment_bookings
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
            # Add serial_number column to appointment_bookings if it doesn't exist
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
        
        connection.commit()
        print("\n✅ Migration completed successfully!")

if __name__ == "__main__":
    migrate()
