"""PDF helpers with bilingual (English + Bangla) text rendering for ReportLab."""

import os
from typing import Optional

from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

_FONT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fonts")
_BN_REGULAR = "NotoSansBengali"
_BN_BOLD = "NotoSansBengali-Bold"
_EN_REGULAR = "Helvetica"
_EN_BOLD = "Helvetica-Bold"
_EN_OBLIQUE = "Helvetica-Oblique"
_fonts_registered = False
_bn_regular_ok = False
_bn_bold_ok = False


def register_fonts() -> None:
    """Register Noto Sans Bengali fonts with ReportLab. Safe to call repeatedly.

    If the TTF files are not present (e.g. not deployed to the host), the
    module falls back to Helvetica for Bangla runs instead of crashing later
    when the canvas tries to setFont("NotoSansBengali", ...).
    """
    global _fonts_registered, _bn_regular_ok, _bn_bold_ok
    if _fonts_registered:
        return
    regular_path = os.path.join(_FONT_DIR, "NotoSansBengali-Regular.ttf")
    bold_path = os.path.join(_FONT_DIR, "NotoSansBengali-Bold.ttf")
    if os.path.isfile(regular_path):
        try:
            pdfmetrics.registerFont(TTFont(_BN_REGULAR, regular_path))
            _bn_regular_ok = True
        except Exception:
            _bn_regular_ok = False
    if os.path.isfile(bold_path):
        try:
            pdfmetrics.registerFont(TTFont(_BN_BOLD, bold_path))
            _bn_bold_ok = True
        except Exception:
            _bn_bold_ok = False
    _fonts_registered = True


def _is_bangla_char(ch: str) -> bool:
    if not ch:
        return False
    code = ord(ch)
    return 0x0980 <= code <= 0x09FF


def _contains_bangla(text: str) -> bool:
    return any(_is_bangla_char(ch) for ch in text or "")


def _segment_runs(text: str):
    """Split text into runs of (is_bangla, segment). Spaces/punctuation join the previous run."""
    if not text:
        return []
    runs = []
    current_bangla: Optional[bool] = None
    buffer = []
    for ch in text:
        if _is_bangla_char(ch):
            kind = True
        elif ch.isspace() or not ch.isalnum():
            # Neutral character: stay with the current run if any.
            if current_bangla is None:
                kind = False
            else:
                kind = current_bangla
        else:
            kind = False
        if current_bangla is None:
            current_bangla = kind
            buffer.append(ch)
        elif kind == current_bangla:
            buffer.append(ch)
        else:
            runs.append((current_bangla, "".join(buffer)))
            current_bangla = kind
            buffer = [ch]
    if buffer:
        runs.append((current_bangla, "".join(buffer)))
    return runs


def _font_name(is_bangla: bool, bold: bool, oblique: bool = False) -> str:
    if is_bangla:
        if bold and _bn_bold_ok:
            return _BN_BOLD
        if not bold and _bn_regular_ok:
            return _BN_REGULAR
        # Fonts not registered — fall back so the canvas keeps drawing.
        return _EN_BOLD if bold else _EN_REGULAR
    if oblique:
        return _EN_OBLIQUE
    return _EN_BOLD if bold else _EN_REGULAR


def bilingual_string_width(text: str, font_size: float, bold: bool = False) -> float:
    """Measure the width of a mixed English/Bangla string in PDF points."""
    if not text:
        return 0.0
    total = 0.0
    for is_bangla, segment in _segment_runs(text):
        total += pdfmetrics.stringWidth(segment, _font_name(is_bangla, bold), font_size)
    return total


def draw_bilingual_string(
    c: Canvas,
    x: float,
    y: float,
    text: str,
    font_size: float,
    bold: bool = False,
    oblique: bool = False,
) -> float:
    """Draw a mixed English/Bangla string left-aligned at (x, y). Returns the end x."""
    if not text:
        return x
    cursor = x
    for is_bangla, segment in _segment_runs(text):
        font = _font_name(is_bangla, bold, oblique)
        c.setFont(font, font_size)
        c.drawString(cursor, y, segment)
        cursor += pdfmetrics.stringWidth(segment, font, font_size)
    return cursor


def draw_bilingual_centered(
    c: Canvas,
    cx: float,
    y: float,
    text: str,
    font_size: float,
    bold: bool = False,
    oblique: bool = False,
) -> None:
    """Draw a mixed English/Bangla string horizontally centered at cx."""
    width = bilingual_string_width(text, font_size, bold)
    draw_bilingual_string(c, cx - width / 2.0, y, text, font_size, bold, oblique)


def wrap_bilingual(text: str, max_width: float, font_size: float, bold: bool = False) -> list[str]:
    """Word-wrap text honoring mixed-script widths. Returns list of lines."""
    if not text:
        return []
    words = text.split()
    if not words:
        return []
    space_w_en = pdfmetrics.stringWidth(" ", _EN_BOLD if bold else _EN_REGULAR, font_size)
    lines: list[str] = []
    current = ""
    current_w = 0.0
    for word in words:
        word_w = bilingual_string_width(word, font_size, bold)
        if not current:
            current = word
            current_w = word_w
            continue
        if current_w + space_w_en + word_w <= max_width:
            current += " " + word
            current_w += space_w_en + word_w
        else:
            lines.append(current)
            current = word
            current_w = word_w
    if current:
        lines.append(current)
    return lines


__all__ = [
    "register_fonts",
    "draw_bilingual_string",
    "draw_bilingual_centered",
    "bilingual_string_width",
    "wrap_bilingual",
    "colors",
]
