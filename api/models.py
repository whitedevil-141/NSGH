from sqlalchemy import Column, Integer, String, Text
from database import Base

class User(Base):
    __tablename__ = "users"

    user_id = Column(String(32), primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password = Column(String(255), nullable=False)
    role = Column(String(20), default="admin")  #


class Doctor(Base):
    __tablename__ = "doctors"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    description = Column(String(500), nullable=True)
    hospital = Column(String(100), nullable=False)
    room = Column(String(10), nullable=True)
    timing = Column(String(500), nullable=True)
    phone = Column(String(20), nullable=True)
    specialization = Column(Text, nullable=False)
    qualifications = Column(Text, nullable=True)
    conditions = Column(Text, nullable=True)
    category = Column(Text, nullable=False)
    photo_url = Column(String(255), nullable=True) 

class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    phone = Column(String(20), nullable=False)
    subject = Column(String(100), nullable=False)
    message = Column(Text, nullable=False)
    

class Staff(Base):
    __tablename__ = "staffs"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    designation = Column(String(100), nullable=True)
    phone = Column(String(20), nullable=True)
    photo_url = Column(String(255), nullable=True)
    


class Gallery(Base):
    __tablename__ = "gallery"
    id = Column(Integer, primary_key=True, index=True)
    image_url = Column(String(255))
    caption = Column(String(255))

class Machinery(Base):
    __tablename__ = "machineries"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100))
    description = Column(Text)
    image_url = Column(String(255))

class Department(Base):
    __tablename__ = "departments"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100))
    description = Column(Text)
    icon = Column(String(100))  # optional

class About(Base):
    __tablename__ = "about"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(150))
    content = Column(Text)
    image_url = Column(String(255))


class AppointmentUser(Base):
    __tablename__ = "appointment_users"

    id = Column(String(32), primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    phone = Column(String(20), unique=True, index=True, nullable=False)
    password = Column(String(255), nullable=False)
    email = Column(String(120), nullable=True)
    age = Column(Integer, nullable=True)
    gender = Column(String(20), nullable=True)
    blood_group = Column(String(5), nullable=True)
    role = Column(String(20), nullable=False, default="user")
    specialty = Column(String(100), nullable=True)
    created_by_id = Column(String(32), nullable=True, index=True)
    created_by_name = Column(String(100), nullable=True)


class AppointmentDoctor(Base):
    __tablename__ = "appointment_doctors"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    phone = Column(String(20), unique=True, index=True, nullable=False)
    category = Column(String(100), nullable=False)
    start_time = Column(String(5), nullable=False)
    end_time = Column(String(5), nullable=False)
    room = Column(String(20), nullable=False)
    is_available = Column(Integer, nullable=False, default=1)  # 1 for available, 0 for unavailable


class AppointmentBooking(Base):
    __tablename__ = "appointment_bookings"

    id = Column(Integer, primary_key=True, index=True)
    patient_name = Column(String(100), nullable=False)
    patient_phone = Column(String(20), index=True, nullable=False)
    doctor_id = Column(Integer, index=True, nullable=False)
    doctor_name = Column(String(100), nullable=False)
    date = Column(String(10), index=True, nullable=False)
    time = Column(String(5), index=True, nullable=True)  # Made nullable for backward compatibility
    room = Column(String(20), nullable=False)
    serial_number = Column(Integer, nullable=True)  # Queue position for the day
    status = Column(String(20), nullable=False, default="Booked")
    reason = Column(Text, nullable=True)
    booked_by_id = Column(String(32), nullable=True, index=True)
    booked_by_name = Column(String(100), nullable=True)
    booked_by_role = Column(String(20), nullable=True)
    marketing_officer_id = Column(String(32), nullable=True, index=True)
    marketing_officer_name = Column(String(100), nullable=True)
    commission_doctor_id = Column(String(32), nullable=True, index=True)
    commission_doctor_name = Column(String(100), nullable=True)
