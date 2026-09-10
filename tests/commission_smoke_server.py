import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
sys.path.insert(0, str(root / "tests"))
from test_commission_sms import CommissionSmsTests, app
from fastapi.staticfiles import StaticFiles
import uvicorn

case = CommissionSmsTests()
case.setUp()
@app.post("/__test/reset")
def reset():
    case.doCleanups()
    case.setUp()
    return {"ok": True}

app.mount("/", StaticFiles(directory=str(root), html=True))
uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
