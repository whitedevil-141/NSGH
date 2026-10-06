"""Exercise all protected routers using only the existing isolated test database."""
import os
import re
import unittest
from datetime import timedelta
from unittest.mock import patch

# Reuse the test database configured before any API imports.
from test_commission_sms import Base, engine, hash_password, limiter

for key in ("SFTP_HOST", "SFTP_USERNAME", "SFTP_PASSWORD"):
    os.environ[key] = "test-only"

import jwt
import paramiko
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from api.models import AppointmentUser, Doctor, Staff, User
from api.routers import appointment, auth, commission_sms, doctors, notice, public, staffs
from api.utils import image_handler
from api.utils.jwt_handler import JWT_ALGORITHM, JWT_SECRET, create_access_token

app = FastAPI()
app.state.limiter = limiter
limiter.enabled = False
for router, prefix in (
    (auth.router, "/auth"), (appointment.router, "/appointment"),
    (commission_sms.router, "/appointment"), (notice.router, "/appointment"),
    (doctors.router, "/doctors"), (staffs.router, "/staffs"), (public.router, "/public"),
):
    app.include_router(router, prefix=prefix)


class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)
        self.client = TestClient(app)
        password = hash_password("secret123")
        with Session(engine) as db:
            db.add_all([
                User(user_id="web-admin", username="admin", password=password, role="admin"),
                User(user_id="web-user", username="patient", password=password, role="user"),
                AppointmentUser(id="portal-admin", name="Admin", phone="admin", password=password, role="admin"),
                AppointmentUser(id="portal-user", name="Patient", phone="01712345678", password=password, role="user"),
            ])
            db.commit()

    def headers(self, user_id="web-admin", scope="dashboard", **claims):
        data = {"user_id": user_id, "role": "admin", **claims}
        if scope is not None:
            data["scope"] = scope
        return {"Authorization": "Bearer " + create_access_token(data)}

    def website_management_routes(self):
        for router, prefix in ((doctors.router, "/doctors"), (staffs.router, "/staffs"),
                               (auth.router, "/auth"), (notice.router, "/appointment")):
            for route in router.routes:
                path = prefix + route.path
                if prefix == "/auth" and route.path != "/register":
                    continue
                if path.endswith("/active"):
                    continue
                for method in route.methods:
                    yield method, re.sub(r"\{[^}]+\}", "999", path)

    def test_all_website_management_endpoints_require_admin(self):
        count = 0
        for method, path in self.website_management_routes():
            for headers, status in (({}, 401), (self.headers("web-user"), 403),
                                    (self.headers("portal-user", "appointment"), 403)):
                with self.subTest(method=method, path=path, status=status):
                    result = self.client.request(method, path, headers=headers, json={})
                    self.assertEqual(result.status_code, status, result.text)
                    count += 1
        self.assertGreater(count, 40)

    def test_all_appointment_protected_endpoints_reject_missing_tokens(self):
        def has_identity(dependency):
            return (getattr(dependency.call, "__name__", "") == "_current_user"
                    or any(has_identity(child) for child in dependency.dependencies))

        count = 0
        for route in [*appointment.router.routes, *commission_sms.router.routes]:
            if hasattr(route, "dependant") and has_identity(route.dependant):
                path = "/appointment" + re.sub(r"\{[^}]+\}", "999", route.path)
                for method in route.methods:
                    with self.subTest(method=method, path=path):
                        result = self.client.request(method, path, json={})
                        self.assertEqual(result.status_code, 401, result.text)
                        count += 1
        self.assertGreater(count, 40)

    def test_real_admin_logins_authorize_management_and_doctor_delete(self):
        web = self.client.post("/auth/login", data={"username": "admin", "password": "secret123"})
        portal = self.client.post("/appointment/login", json={"phone": "admin", "password": "secret123"})
        for login in (web, portal):
            self.assertEqual(login.status_code, 200, login.text)
            headers = {"Authorization": "Bearer " + login.json()["access_token"]}
            self.assertEqual(self.client.get("/auth/me", headers=headers).json()["role"], "admin")
            doctor = self.client.post("/doctors/add", headers=headers, data={
                "name": "Test Doctor", "hospital": "NSGH", "room": "1", "timing": "09:00",
                "specialization": "Medicine", "qualifications": "[]", "conditions": "[]",
            })
            self.assertEqual(doctor.status_code, 200, doctor.text)
            self.assertEqual(self.client.delete(f'/doctors/{doctor.json()["doctor_id"]}', headers=headers).status_code, 200)
            staff = self.client.post("/staffs/add", headers=headers, data={"name": "Test Staff"})
            self.assertEqual(staff.status_code, 200, staff.text)
            self.assertEqual(self.client.delete(f'/staffs/{staff.json()["staff_id"]}', headers=headers).status_code, 200)
            category = self.client.post("/doctors/categories", headers=headers, json={"name": "Test"})
            self.assertEqual(category.status_code, 201, category.text)
            self.assertEqual(self.client.delete(f'/doctors/categories/{category.json()["id"]}', headers=headers).status_code, 200)
            entry = self.client.post("/appointment/notices", headers=headers, json={"title": "Test", "content": "Test", "is_active": True})
            self.assertEqual(entry.status_code, 201, entry.text)
            self.assertEqual(self.client.delete(f'/appointment/notices/{entry.json()["id"]}', headers=headers).status_code, 200)

    def test_legacy_unscoped_tokens_work_and_account_permissions_are_current(self):
        headers = self.headers(scope=None)
        self.assertEqual(self.client.get("/doctors/categories", headers=headers).status_code, 200)
        with Session(engine) as db:
            db.get(User, "web-admin").role = "user"
            db.commit()
        self.assertEqual(self.client.get("/doctors/categories", headers=headers).status_code, 403)
        with Session(engine) as db:
            db.delete(db.get(User, "web-admin"))
            db.commit()
        self.assertEqual(self.client.get("/doctors/categories", headers=headers).status_code, 401)

    def test_bad_tokens_return_401_with_bearer_challenge(self):
        claims = {"user_id": "web-admin", "role": "admin", "scope": "dashboard"}
        tokens = [
            "not-a-token",
            create_access_token(claims, expires_delta=timedelta(seconds=-1)),
            jwt.encode(claims, JWT_SECRET, algorithm=JWT_ALGORITHM),  # no expiry
            create_access_token({"role": "admin"}),  # no account identifier
            create_access_token({**claims, "scope": "unknown"}),
            create_access_token({**claims, "user_id": "deleted"}),
            jwt.encode({**claims, "exp": 9999999999}, "wrong-test-secret-at-least-32-bytes", algorithm=JWT_ALGORITHM),
        ]
        for token in tokens:
            with self.subTest(token=token[:20]):
                result = self.client.get("/doctors/categories", headers={"Authorization": "Bearer " + token})
                self.assertEqual(result.status_code, 401, result.text)
                self.assertEqual(result.headers.get("www-authenticate"), "Bearer")

    def test_token_scope_does_not_confuse_account_tables(self):
        self.assertEqual(self.client.get("/doctors/categories", headers=self.headers("portal-admin", "dashboard")).status_code, 401)
        self.assertEqual(self.client.get("/appointment/data", headers=self.headers()).status_code, 401)
        self.assertEqual(self.client.get("/appointment/data", headers=self.headers("portal-admin", "appointment")).status_code, 200)

    def test_registration_requires_admin_and_accepts_an_authorized_admin(self):
        body = {"username": "new-admin", "password": "secret123", "role": "admin"}
        self.assertEqual(self.client.post("/auth/register", json=body).status_code, 401)
        self.assertEqual(self.client.post("/auth/register", headers=self.headers(), json=body).status_code, 201)

    def test_public_reads_remain_available(self):
        for path in ("/public/doctors/data", "/public/staffs/data", "/public/categories",
                     "/public/notices", "/appointment/notices/active", "/appointment/categories"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)

    def test_sftp_authentication_failures_are_502_and_preserve_records(self):
        with Session(engine) as db:
            db.add_all([
                Doctor(id=7, name="Doctor", hospital="NSGH", specialization="[]", category="[]", photo_url="https://www.nsghbd.com/img/team/test.jpg"),
                Staff(id=7, name="Staff", photo_url="https://www.nsghbd.com/img/team/test.jpg"),
            ])
            db.commit()
        with patch.object(image_handler.paramiko, "Transport") as transport:
            transport.return_value.connect.side_effect = paramiko.AuthenticationException("bad SFTP credentials")
            for path in ("/doctors/7", "/staffs/7"):
                result = self.client.delete(path, headers=self.headers())
                self.assertEqual(result.status_code, 502, result.text)
                self.assertIn("SFTP credentials", result.json()["detail"])
            for path, data in (("/staffs/add", {"name": "Staff"}), ("/doctors/add", {
                "name": "Doctor", "hospital": "NSGH", "room": "1", "timing": "09:00",
                "specialization": "Medicine", "qualifications": "[]", "conditions": "[]",
            })):
                result = self.client.post(path, headers=self.headers(), data=data, files={"photo": ("test.jpg", b"test", "image/jpeg")})
                self.assertEqual(result.status_code, 502, result.text)
            self.assertEqual(transport.return_value.close.call_count, 4)
        with Session(engine) as db:
            self.assertIsNotNone(db.get(Doctor, 7))
            self.assertIsNotNone(db.get(Staff, 7))


if __name__ == "__main__":
    unittest.main()
