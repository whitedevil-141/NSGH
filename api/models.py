from sqlalchemy import Column, Integer, String, Text
from api.database import Base

class Doctor(Base):
    __tablename__ = "doctors"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100))
    specialization = Column(String(100))
    category = Column(String(50))
    experience = Column(Integer)
    photo = Column(String(255))
    description = Column(Text)
    phone = Column(String(20))

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
