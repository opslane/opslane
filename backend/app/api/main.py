"""API Router"""

from fastapi import APIRouter

from app.api.routes.v1 import admin, alerts, integrations

api_router = APIRouter()

api_router.include_router(admin.router, prefix="/admin", tags=["admin"])
api_router.include_router(alerts.router, prefix="/alerts", tags=["alerts"])
api_router.include_router(
    integrations.router, prefix="/integrations", tags=["integrations"]
)
