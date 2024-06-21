"""Routes for alerts."""

from fastapi import APIRouter, Request, Depends

from app.dependencies import get_notification_manager
from app.managers.notification_manager import NotificationManager
from app.integrations.factory import IntegrationSourceFactory

router = APIRouter()


@router.get("/")
async def get() -> dict:
    """Get all alerts."""
    return {"alerts": ["Alert 1", "Alert 2"]}


@router.post("/{source}")
async def receive(
    source: str,
    request: Request,
    notification_manager: NotificationManager = Depends(get_notification_manager),
) -> dict:
    """Receive an alert."""
    alert = await request.json()
    try:
        integration = IntegrationSourceFactory.get_integration(source)
        processed_alert = integration.process_alert(alert)
        notification_manager.send_notifications(processed_alert)
        return {"message": "Alert received and processed!"}
    except ValueError as e:
        return {"error": str(e)}, 404
