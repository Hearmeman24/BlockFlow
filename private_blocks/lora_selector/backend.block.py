from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from backend import services

router = APIRouter()


@router.get("/loras")
def get_loras(refresh: int = Query(0)) -> JSONResponse:
    loras, error, from_cache = services._get_loras(refresh=bool(refresh))
    resp: dict[str, Any] = {
        "ok": True,
        "high": loras.get("high", []),
        "low": loras.get("low", []),
        "from_cache": from_cache,
    }
    if error:
        resp["warning"] = error
    return JSONResponse(resp)
