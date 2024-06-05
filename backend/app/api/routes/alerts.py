"""Routes for alerts."""

from fastapi import APIRouter, Request

from app.integrations.factory import IntegrationSourceFactory

router = APIRouter()


@router.get("/")
async def get() -> dict:
    """Get all alerts."""
    return {"alerts": ["Alert 1", "Alert 2"]}


@router.post("/{source}")
async def receive(source: str, request: Request) -> dict:
    """Receive an alert."""
    alert = await request.json()
    try:
        integration = IntegrationSourceFactory.get_integration(source)
        integration.process_alert(alert)
        return {"message": "Alert received and processed!"}
    except ValueError as e:
        return {"error": str(e)}, 404
