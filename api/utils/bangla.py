"""Helpers for formatting Bangla SMS strings (digits, time-of-day, date)."""

from datetime import date as _date
from typing import Iterable, Optional


_BN_DIGIT_MAP = str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯")

_BN_DAY_SHORT = {
    "Monday": "সোম",
    "Tuesday": "মঙ্গল",
    "Wednesday": "বুধ",
    "Thursday": "বৃহঃ",
    "Friday": "শুক্র",
    "Saturday": "শনি",
    "Sunday": "রবি",
}


def to_bn_digits(value) -> str:
    """Translate any ASCII digits in ``value`` to Bangla digits."""
    return str(value).translate(_BN_DIGIT_MAP)


def _period_label(hour_24: int) -> str:
    """Return the Bangla period name for a 24-hour clock hour."""
    if 4 <= hour_24 < 6:
        return "ভোর"
    if 6 <= hour_24 < 12:
        return "সকাল"
    if 12 <= hour_24 < 15:
        return "দুপুর"
    if 15 <= hour_24 < 18:
        return "বিকাল"
    if 18 <= hour_24 < 20:
        return "সন্ধ্যা"
    return "রাত"


def bn_time(hh_mm: Optional[str]) -> Optional[str]:
    """Format an ``HH:MM`` string as e.g. ``সকাল ১০টা`` or ``বিকাল ৩টা ৩০ মিনিট``."""
    if not hh_mm or ":" not in hh_mm:
        return None
    try:
        hour_24, minute = (int(part) for part in hh_mm.split(":", 1))
    except ValueError:
        return None
    period = _period_label(hour_24)
    hour_12 = hour_24 % 12 or 12
    if minute:
        return f"{period} {to_bn_digits(hour_12)}টা {to_bn_digits(minute)} মিনিট"
    return f"{period} {to_bn_digits(hour_12)}টা"


def bn_time_range(start: Optional[str], end: Optional[str]) -> Optional[str]:
    """Format a doctor's schedule window as ``সকাল ১০টা - বিকাল ৩টা``."""
    start_bn = bn_time(start)
    end_bn = bn_time(end)
    if start_bn and end_bn:
        return f"{start_bn} - {end_bn}"
    return start_bn or end_bn


def bn_day_short(day_name: Optional[str]) -> str:
    """Return the short Bangla day name (e.g. ``সোম``) for an English weekday."""
    if not day_name:
        return ""
    return _BN_DAY_SHORT.get(day_name.strip().title(), day_name)


def bn_schedule_summary(items: Iterable[dict]) -> str:
    """Format a doctor's working schedule as ``সোম সকাল ৮টা - দুপুর ২টা, …``."""
    parts = []
    for item in items or []:
        day = bn_day_short(item.get("day"))
        time_range = bn_time_range(item.get("startTime"), item.get("endTime"))
        if not day or not time_range:
            continue
        parts.append(f"{day} {time_range}")
    return ", ".join(parts)


def bn_date(value) -> Optional[str]:
    """Format a date as ``DD-MM-YYYY`` with Bangla digits."""
    if isinstance(value, _date):
        return to_bn_digits(value.strftime("%d-%m-%Y"))
    if isinstance(value, str) and len(value) >= 10:
        try:
            parsed = _date.fromisoformat(value[:10])
        except ValueError:
            return None
        return to_bn_digits(parsed.strftime("%d-%m-%Y"))
    return None
