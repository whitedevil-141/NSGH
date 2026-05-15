import os

import requests
from fastapi import HTTPException

from api.utils.config import load_env


BULKSMSBD_SMS_URL = "https://bulksmsbd.net/api/smsapi"


def send_sms(number: str, message: str) -> dict:
    load_env()
    api_key = os.getenv("BULKSMSBD_API_KEY")
    senderid = os.getenv("BULKSMSBD_SENDER_ID")
    if not api_key or not senderid:
        raise HTTPException(status_code=500, detail="SMS provider is not configured")

    payload = {
        "api_key": api_key,
        "senderid": senderid,
        "number": number,
        "message": message,
    }

    try:
        response = requests.post(BULKSMSBD_SMS_URL, data=payload, timeout=10)
        response.raise_for_status()
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="SMS provider request failed")

    try:
        provider_response = response.json()
    except ValueError:
        provider_response = {"raw": response.text}

    response_code = str(provider_response.get("response_code", ""))
    if response_code and response_code not in {"200", "202"}:
        raise HTTPException(status_code=502, detail="SMS provider rejected the request")

    return provider_response
