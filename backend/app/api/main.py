"""API Router"""

from fastapi import APIRouter

from app.api.routes.v1 import admin, alerts

api_router = APIRouter()

api_router.include_router(admin.router, prefix="/admin", tags=["admin"])
api_router.include_router(alerts.router, prefix="/alerts", tags=["alerts"])
