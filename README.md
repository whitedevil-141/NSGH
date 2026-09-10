# NSGH
New Shafipur General Hospital Official Website

Commission SMS panel is available in `appointment.html` using the existing appointment login.

- An appointment admin can open **Commission SMS Users** to create, edit, reset passwords for, or delete accounts. The new role is `commission_sms`.
- These users land directly on **Send SMS**, with **Doctors**, **SMS Templates**, and **SMS History** in the sidebar. There is no overview dashboard.
- Each account has its own doctor directory: `doctor_id`, doctor name, doctor address, and Bangladesh mobile number. These are separate from website and appointment doctors. Admin and other accounts cannot access or manage this directory, its templates, or its messages.
- A default template is created with each account: `Dear {name}, your commission payment of BDT {amount} for {date} has been sent. Thank you for your partnership.` Templates can be added, edited, or deleted. Supported placeholders are `{name}`, `{amount}`, and `{date}`; `{{` and `}}` produce literal braces.
- Payment dates default to today in Bangladesh (`UTC+06:00`). Amounts must be positive BDT values with at most two decimal places. The panel previews the message before sending; it does not transfer money.
- SMS history supports doctor/phone search, payment-date filtering, and pagination. It retains original doctor details, message, amount, template name, operator name, and submission status even after doctor/template deletion.

Deploy the updated static files and restart the FastAPI app (`uvicorn api.main:app`). The existing startup initialization automatically creates `commission_sms_doctors`, `commission_sms_templates`, and `commission_sms_history`; no existing doctor tables need changes. Create the operator's actual login through the admin panel after deployment. No new production account or password is seeded.

The API lives under `/appointment/commission-sms`. Account mutations use `/users`; operator endpoints use `/doctors`, `/templates`, `/send`, and `/history`. Sending uses the existing `api/utils/sms.py` gateway. The send request includes the internal doctor/template IDs, `amount`, optional `date`, and a UUID `request_id`. Reusing the same request ID returns the original attempt without another gateway call; reusing it with different details returns 409. History is saved before contacting the gateway. `submitted` means the gateway request completed, with acceptance and delivery unconfirmed; explicit rejection is `failed`, and transport failures are `unknown`. A pending or unknown attempt should be checked with the provider before submitting a new request. No delivery receipt integration is available in the existing gateway helper.

Run the isolated backend tests with `python -m pip install -r api/requirements.txt httpx`, then `python -m unittest discover -s tests -v`. Tests use a temporary SQLite database and mocked SMS calls, including account permissions, login, doctor/template CRUD, date defaults, history snapshots, validation, and duplicate-request handling.
