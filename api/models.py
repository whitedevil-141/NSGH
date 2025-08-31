from sqlalchemy import Column, Integer, String, Text
from api.database import Base

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
    experience_yr = Column(Integer, default=0)
    room = Column(String(10), nullable=True)
    timing = Column(String(50), nullable=True)
    phone = Column(String(20), nullable=True)
    specialization = Column(Text, nullable=False)
    qualifications = Column(Text, nullable=True)
    conditions = Column(Text, nullable=True)
    category = Column(Text, nullable=False)
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
