from typing import List, Optional
from pydantic import BaseModel

# Auth
class RegisterRequest(BaseModel):
    username: str
    password: str
    role: str | None = "admin"


# Doctor
class DoctorBase(BaseModel):
    name: str
    description: Optional[str] = ""
    hospital: str
    experience_yr: int
    room: str
    timing: str
    phone: Optional[str] = None
    specialization: List[str] = []
    qualifications: List[str] = []
    conditions: List[dict] = []
    category: List[str] = [] 


class DoctorOut(DoctorBase):
    id: int
    class Config:
        orm_mode = True


class DoctorPublic(BaseModel):
    id: int
    name: str
    specialization: Optional[str] = None
    description: Optional[str] = None
    category: List[str] = []           # <-- allow list
    phone: Optional[str] = None
    experience_yr: Optional[int] = 0
    photo_url: Optional[str] = None
    qualifications: List[str] = []
    conditions: List[dict] = []
    hospital: Optional[str] = None
    room: Optional[str] = None
    timing: Optional[str] = None

    class Config:
        orm_mode = True

class DoctorsDataResponse(BaseModel):
    doctors: List[DoctorPublic]
    categories: List[str]
    
# Gallery
class GalleryBase(BaseModel):
    image_url: str
    caption: str

class GalleryOut(GalleryBase):
    id: int
    class Config:
        orm_mode = True

# Machinery
class MachineryBase(BaseModel):
    name: str
    description: str
    image_url: str

class MachineryOut(MachineryBase):
    id: int
    class Config:
        orm_mode = True

# Department
class DepartmentBase(BaseModel):
    name: str
    description: str
    icon: str

class DepartmentOut(DepartmentBase):
    id: int
    class Config:
        orm_mode = True

# About
class AboutBase(BaseModel):
    title: str
    content: str
    image_url: str

class AboutOut(AboutBase):
    id: int
    class Config:
        orm_mode = True
