"""Routes for alerts."""

from fastapi import APIRouter, Request, BackgroundTasks, Depends

from app.dependencies import get_notification_manager
from app.managers.notification_manager import NotificationManager
from app.tasks.alert import process_alert

router = APIRouter()


@router.post("/{source}")
async def receive(
    source: str,
    request: Request,
    background_tasks: BackgroundTasks,
    notification_manager: NotificationManager = Depends(get_notification_manager),
) -> dict:
    """Receive an alert."""
    alert = await request.json()
    background_tasks.add_task(process_alert, source, alert, notification_manager)
    return {"message": "Alert received and processed!"}
