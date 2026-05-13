from typing import List, Optional
from pydantic import BaseModel, Field

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
    room: str
    timing: str
    phone: Optional[str] = None
    specialization: List[str] = []
    qualifications: List[str] = []
    conditions: List[dict] = []
    category: List[str] = [] 
    photo_url: Optional[str] = None


class DoctorOut(DoctorBase):
    id: int
    class Config:
        from_attributes = True


class DoctorPublic(BaseModel):
    id: int
    name: str
    specialization: Optional[str] = None
    description: Optional[str] = None
    category: List[str] = []           # <-- allow list
    phone: Optional[str] = None
    photo_url: Optional[str] = None
    qualifications: List[str] = []
    conditions: List[dict] = []
    hospital: Optional[str] = None
    room: Optional[str] = None
    timing: Optional[str] = None

    class Config:
        from_attributes = True

class DoctorsDataResponse(BaseModel):
    doctors: List[DoctorPublic]
    categories: List[str]
    

# staff
class StaffBase(BaseModel):
    name: str
    designation: str
    phone: str

class StaffOut(StaffBase):
    id: int
    class Config:
        from_attributes = True
        
class StaffPublic(BaseModel):
    id: int
    name: str
    designation: Optional[str] = None
    photo_url: Optional[str] = None
    phone: Optional[str] = None

    class Config:
        from_attributes = True
        

class StaffsDataResponse(BaseModel):
    staffs: List[StaffPublic]


# Gallery
class GalleryBase(BaseModel):
    image_url: str
    caption: str

# Machinery
class MachineryBase(BaseModel):
    name: str
    description: str
    image_url: str

class MachineryOut(MachineryBase):
    id: int
    class Config:
        from_attributes = True

# Department
class DepartmentBase(BaseModel):
    name: str
    description: str
    icon: str

class DepartmentOut(DepartmentBase):
    id: int
    class Config:
        from_attributes = True

# About
class AboutBase(BaseModel):
    title: str
    content: str
    image_url: str

class AboutOut(AboutBase):
    id: int
    class Config:
        from_attributes = True


class ContactBase(BaseModel):
    name: str
    phone: str
    subject: str
    message: str
    
class ContactOut(ContactBase):
    id: int
    class Config:
        from_attributes = True


# Appointment portal
class AppointmentLoginRequest(BaseModel):
    phone: str
    password: str


class AppointmentUserBase(BaseModel):
    name: str
    phone: str
    email: Optional[str] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    bloodGroup: Optional[str] = None
    role: str = "user"
    specialty: Optional[str] = None
    createdById: Optional[str] = None
    createdByName: Optional[str] = None


class AppointmentUserCreate(AppointmentUserBase):
    password: str


class AppointmentUserUpdate(BaseModel):
    name: str
    email: Optional[str] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    bloodGroup: Optional[str] = None


class AppointmentUserPasswordReset(BaseModel):
    phone: str
    newPassword: str


class AppointmentUserPasswordChange(BaseModel):
    currentPassword: str
    newPassword: str


class AppointmentStaffCreate(BaseModel):
    name: str
    phone: str
    password: str
    email: Optional[str] = None
    specialty: Optional[str] = None


class OtpSendRequest(BaseModel):
    phone: str


class OtpVerifyRequest(BaseModel):
    phone: str
    otp: str


class AppointmentUserOut(AppointmentUserBase):
    id: str


class AppointmentDoctorScheduleItem(BaseModel):
    day: str
    startTime: str
    endTime: str


class AppointmentDoctorBase(BaseModel):
    name: str
    phone: str
    category: str
    workingDays: List[str] = Field(default_factory=list)
    workingSchedule: List[AppointmentDoctorScheduleItem] = Field(default_factory=list)
    startTime: Optional[str] = None
    endTime: Optional[str] = None
    room: str
    email: Optional[str] = None


class AppointmentDoctorCreate(AppointmentDoctorBase):
    password: str


class AppointmentDoctorUpdate(BaseModel):
    name: str
    category: str
    workingDays: List[str] = Field(default_factory=list)
    workingSchedule: List[AppointmentDoctorScheduleItem] = Field(default_factory=list)
    startTime: Optional[str] = None
    endTime: Optional[str] = None
    room: str
    email: Optional[str] = None


class AppointmentDoctorOut(AppointmentDoctorBase):
    id: int
    time: str
    is_available: Optional[int] = 1


class AppointmentCreate(BaseModel):
    docId: int
    date: str
    patientName: Optional[str] = None
    patientAge: Optional[int] = None
    patientAddress: Optional[str] = None
    patientPhone: Optional[str] = None
    reason: Optional[str] = None


class AppointmentStatusUpdate(BaseModel):
    status: str


class AppointmentOut(BaseModel):
    id: int
    patientName: str
    patientPhone: str
    patientAge: Optional[int] = None
    patientAddress: Optional[str] = None
    docId: int
    docName: str
    date: str
    time: Optional[str] = None
    room: Optional[str] = None
    status: str
    reason: Optional[str] = None
    serial_number: Optional[int] = None
    bookedById: Optional[str] = None
    bookedByName: Optional[str] = None
    bookedByRole: Optional[str] = None
    marketingOfficerId: Optional[str] = None
    marketingOfficerName: Optional[str] = None
    commissionDoctorId: Optional[str] = None
    commissionDoctorName: Optional[str] = None


class AppointmentSuccessResponse(BaseModel):
    message: str
    details: AppointmentOut
    serial_number: int
    queue_position: str

class AppointmentSlotOut(BaseModel):
    value: str
    label: str


class AppointmentDataResponse(BaseModel):
    users: List[AppointmentUserOut]
    doctors: List[AppointmentDoctorOut]
    appointments: List[AppointmentOut]
