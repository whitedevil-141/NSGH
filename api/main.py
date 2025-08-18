from fastapi import FastAPI
from api.database import engine, Base
from api.routers import doctors, gallery, machineries, departments, about

# Create all tables
Base.metadata.create_all(bind=engine)

app = FastAPI(title="NSGH Hospital Backend API")

# Register routers
app.include_router(doctors.router)
# app.include_router(gallery.router)
# app.include_router(machineries.router)
# app.include_router(departments.router)
# app.include_router(about.router)
