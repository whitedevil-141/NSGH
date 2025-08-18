from pydantic import BaseModel

# Doctor
class DoctorBase(BaseModel):
    name: str
    specialization: str
    category: str
    experience: int
    photo: str
    description: str
    phone: str

class DoctorOut(DoctorBase):
    id: int
    class Config:
        orm_mode = True

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
