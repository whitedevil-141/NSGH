from fastapi import FastAPI, Response
from api.database import engine, Base
from api.routers import auth, public, doctors, gallery, machineries, departments, about
from api.limiter import limiter
from slowapi.errors import RateLimitExceeded
from fastapi.middleware.cors import CORSMiddleware

# Create all tables
Base.metadata.create_all(bind=engine)

app = FastAPI(title="NSGH Hospital Backend API")


# attach limiter
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, lambda request, exc: Response(
    "Too Many Requests", status_code=429
))

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # or ["*"] to allow all origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Register routers
app.include_router(auth.router, prefix="/auth")
app.include_router(public.router, prefix="/public")
app.include_router(doctors.router, prefix="/doctors")
# app.include_router(gallery.router)
# app.include_router(machineries.router)
# app.include_router(departments.router)
# app.include_router(about.router)



