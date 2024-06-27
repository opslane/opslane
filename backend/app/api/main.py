"""API Router"""

from fastapi import APIRouter

from app.api.routes.v1 import alerts

api_router = APIRouter()
api_router.include_router(alerts.router, prefix="/alerts", tags=["alerts"])
