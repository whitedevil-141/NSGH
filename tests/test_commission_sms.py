"""Isolated API tests. No production database or real SMS gateway is used."""
import atexit
import os
import tempfile
import unittest
from datetime import datetime
from unittest.mock import patch
from uuid import uuid4

_temp = tempfile.TemporaryDirectory(prefix="nsgh-commission-tests-")
os.environ["DATABASE_URL"] = "sqlite:///" + _temp.name.replace("\\", "/") + "/test.db"
os.environ["JWT_SECRET"] = "commission-sms-tests-only-secret-at-least-32-bytes"

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from api.database import Base, engine, get_db
from api.limiter import limiter
from api.models import AppointmentUser, CommissionSmsHistory
from api.routers import appointment, commission_sms
from api.utils.deps import get_current_user
from api.utils.jwt_handler import create_access_token
from api.utils.security import hash_password

app = FastAPI()
app.state.limiter = limiter
limiter.enabled = False
app.include_router(appointment.router, prefix="/appointment")
app.include_router(commission_sms.router, prefix="/appointment")


def cleanup():
    engine.dispose()
    _temp.cleanup()


atexit.register(cleanup)


class CommissionSmsTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)
        self.client = TestClient(app)
        self.sms = patch.object(commission_sms, "send_sms", return_value={"success": True}).start()
        self.addCleanup(patch.stopall)
        self.admin = self.seed_user("admin", "admin", "admin")
        self.other = self.seed_user("other", "01712345679", "commission_sms")
        self.patient = self.seed_user("patient", "01712345670", "user")
        result = self.call("post", "/users", self.admin, json={"name": "Commission Operator", "phone": "01712345678", "password": "secret123"})
        self.assertEqual(result.status_code, 201, result.text)
        self.user = result.json()["id"]

    def seed_user(self, uid, phone, role):
        with Session(engine) as db:
            db.add(AppointmentUser(id=uid, name=uid, phone=phone, password=hash_password("secret123"), role=role))
            db.commit()
        return uid

    def headers(self, uid):
        with Session(engine) as db:
            user = db.get(AppointmentUser, uid)
            role = user.role if user else "commission_sms"
        token = create_access_token({"scope": "appointment", "user_id": uid, "role": role})
        return {"Authorization": "Bearer " + token}

    def call(self, method, path, uid=None, **kwargs):
        return getattr(self.client, method)("/appointment/commission-sms" + path, headers=self.headers(uid or self.user), **kwargs)

    def doctor(self, **changes):
        data = {"doctor_id": "DR-001", "name": "Dr. Rahman", "address": "Shafipur, Gazipur", "phone": "+8801712345678", **changes}
        response = self.call("post", "/doctors", json=data)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def send_data(self):
        doctor = self.doctor()
        template = self.call("get", "/templates").json()[0]
        return {"doctor_id": doctor["id"], "template_id": template["id"], "amount": "1250.50", "request_id": str(uuid4())}

    def test_login_bootstrap_and_admin_listing(self):
        response = self.client.post("/appointment/login", json={"phone": "01712345678", "password": "secret123"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user"]["role"], "commission_sms")
        self.assertNotIn("password", response.json()["user"])
        data = self.client.get("/appointment/data", headers=self.headers(self.user)).json()
        self.assertEqual(len(data["users"]), 1)
        self.assertEqual(data["doctors"], [])
        self.assertEqual(data["appointments"], [])
        admin_data = self.client.get("/appointment/data", headers=self.headers(self.admin)).json()
        self.assertIn(self.user, [u["id"] for u in admin_data["users"]])
        self.assertEqual(self.call("get", "/templates").json()[0]["body"], commission_sms.DEFAULT_TEMPLATE)

    def test_admin_account_crud_and_revocation(self):
        token = self.headers(self.user)
        result = self.call("put", "/users/" + self.user, self.admin, json={"name": "Updated Operator", "phone": "01712345678", "password": "changed123"})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(self.client.post("/appointment/login", json={"phone": "01712345678", "password": "secret123"}).status_code, 401)
        self.assertEqual(self.client.post("/appointment/login", json={"phone": "01712345678", "password": "changed123"}).status_code, 200)
        self.assertEqual(self.call("delete", "/users/" + self.user, self.admin).status_code, 200)
        self.assertEqual(self.client.get("/appointment/commission-sms/doctors", headers=token).status_code, 401)

    def test_only_admin_can_manage_accounts(self):
        for role in (self.user, self.other, self.patient):
            for method, path, kwargs in [("post", "/users", {"json": {"name": "A user", "phone": "01712345671", "password": "secret123"}}), ("put", "/users/" + self.user, {"json": {"name": "Changed", "phone": "01712345678"}}), ("delete", "/users/" + self.user, {})]:
                self.assertEqual(self.call(method, path, role, **kwargs).status_code, 403)

    def test_account_password_preserves_spaces_and_rejects_missing_password(self):
        body = {"name": "Another Operator", "phone": "01712345671"}
        self.assertEqual(self.call("post", "/users", self.admin, json=body).status_code, 422)
        response = self.call("post", "/users", self.admin, json={**body, "password": " secret123 "})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.client.post("/appointment/login", json={"phone": body["phone"], "password": " secret123 "}).status_code, 200)
        self.assertEqual(self.client.post("/appointment/login", json={"phone": body["phone"], "password": "secret123"}).status_code, 401)

    def test_admin_cannot_access_panel_records_or_send(self):
        data = self.send_data()
        doctor = self.call("get", "/doctors").json()[0]
        for path in ("/doctors", "/templates", "/history"):
            self.assertEqual(self.call("get", path, self.admin).status_code, 403)
        self.assertEqual(self.call("post", "/send", self.admin, json=data).status_code, 403)
        self.assertEqual(self.call("post", "/doctors", self.admin, json={k: v for k, v in doctor.items() if k != "id"}).status_code, 403)
        self.assertEqual(self.call("delete", "/doctors/" + str(doctor["id"]), self.admin).status_code, 403)
        self.sms.assert_not_called()

    def test_doctor_crud_uniqueness_and_isolation(self):
        doctor = self.doctor()
        self.assertEqual(doctor["phone"], "01712345678")
        body = {k: v for k, v in doctor.items() if k != "id"}
        self.assertEqual(self.call("post", "/doctors", json=body).status_code, 409)
        self.assertEqual(self.call("get", "/doctors", self.other).json(), [])
        for method in ("put", "delete"):
            kwargs = {"json": body} if method == "put" else {}
            self.assertEqual(self.call(method, f'/doctors/{doctor["id"]}', self.other, **kwargs).status_code, 404)
        body.update(doctor_id="DR-002", address="Dhaka")
        self.assertEqual(self.call("put", f'/doctors/{doctor["id"]}', json=body).json()["doctor_id"], "DR-002")
        self.assertEqual(self.call("delete", f'/doctors/{doctor["id"]}').status_code, 200)

    def test_templates_crud_and_placeholder_validation(self):
        body = {"name": "Custom", "body": "Hello {name}: BDT {amount} ({date}). {{Thank you}}"}
        template = self.call("post", "/templates", json=body).json()
        for text in ("{name.__class__}", "{amount:1000000f}", "{unknown}", "{", "{name!r}", "{name:}", " "):
            self.assertEqual(self.call("put", f'/templates/{template["id"]}', json={"name": "Bad", "body": text}).status_code, 422)
        self.assertEqual(self.call("put", f'/templates/{template["id"]}', self.other, json=body).status_code, 404)
        body["body"] = "Paid BDT {amount} to {name} on {date}."
        self.assertEqual(self.call("put", f'/templates/{template["id"]}', json=body).json()["body"], body["body"])
        self.assertEqual(self.call("delete", f'/templates/{template["id"]}').status_code, 200)

    def test_send_default_date_rendering_and_history_snapshot(self):
        data = self.send_data()
        response = self.call("post", "/send", json=data)
        self.assertEqual(response.status_code, 200, response.text)
        row = response.json()
        expected_date = datetime.now(commission_sms.DHAKA).date().isoformat()
        self.assertEqual(row["payment_date"], expected_date)
        self.assertIn(f"BDT 1250.50 for {expected_date}", row["message"])
        self.assertEqual(row["status"], "submitted")
        self.sms.assert_called_once_with(number="8801712345678", message=row["message"])
        self.call("delete", f'/doctors/{data["doctor_id"]}')
        self.call("delete", f'/templates/{data["template_id"]}')
        history = self.call("get", "/history").json()
        self.assertEqual(history["items"][0]["message"], row["message"])
        self.assertEqual(history["items"][0]["doctor_address"], "Shafipur, Gazipur")
        self.assertEqual(self.call("get", "/history", self.other).json()["total"], 0)

    def test_duplicate_request_and_conflicting_reuse(self):
        data = self.send_data()
        one = self.call("post", "/send", json=data)
        two = self.call("post", "/send", json=data)
        self.assertEqual(one.json()["id"], two.json()["id"])
        self.sms.assert_called_once()
        data["amount"] = "22.00"
        self.assertEqual(self.call("post", "/send", json=data).status_code, 409)

    def test_pending_attempt_does_not_resend(self):
        data = self.send_data()
        self.call("post", "/send", json=data)
        with Session(engine) as db:
            db.query(CommissionSmsHistory).update({"status": "pending"})
            db.commit()
        self.sms.reset_mock()
        self.assertEqual(self.call("post", "/send", json=data).json()["status"], "pending")
        self.sms.assert_not_called()

    def test_provider_rejection_and_uncertain_failures_are_recorded(self):
        data = self.send_data()
        for result, expected in (({"success": False}, "failed"), (HTTPException(502, "timeout"), "unknown"), (RuntimeError("network"), "unknown")):
            data["request_id"] = str(uuid4())
            self.sms.side_effect = result if isinstance(result, Exception) else None
            self.sms.return_value = result
            response = self.call("post", "/send", json=data)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["status"], expected)
        self.assertEqual(self.call("get", "/history").json()["total"], 3)

    def test_input_validation_and_cross_account_sending(self):
        data = self.send_data()
        for amount in ("0", "-2", "1.001", "NaN", "10000000000"):
            self.assertEqual(self.call("post", "/send", json={**data, "amount": amount}).status_code, 422)
        self.assertEqual(self.call("post", "/send", json={**data, "date": "invalid"}).status_code, 422)
        self.assertEqual(self.call("post", "/send", self.other, json=data).status_code, 404)
        self.sms.assert_not_called()

    def test_history_search_date_and_pagination(self):
        data = self.send_data()
        for day in ("2026-09-09", "2026-09-10"):
            self.call("post", "/send", json={**data, "date": day, "request_id": str(uuid4())})
        self.assertEqual(self.call("get", "/history?payment_date=2026-09-09").json()["total"], 1)
        page = self.call("get", "/history?search=Rahman&skip=1&limit=1").json()
        self.assertEqual(page["total"], 2)
        self.assertEqual(len(page["items"]), 1)
        self.assertEqual(self.call("get", "/history?search=nobody").json()["total"], 0)
        self.assertEqual(self.call("get", "/history?limit=101").status_code, 422)

    def test_no_access_to_appointments_or_legacy_management(self):
        self.assertEqual(self.client.get("/appointment/appointments", headers=self.headers(self.user)).status_code, 403)
        token = self.headers(self.user)["Authorization"].removeprefix("Bearer ")
        with self.assertRaises(HTTPException) as denied:
            get_current_user(token)
        self.assertEqual(denied.exception.status_code, 403)
        self.assertEqual(self.client.get("/appointment/commission-sms/doctors").status_code, 401)


if __name__ == "__main__":
    unittest.main()
