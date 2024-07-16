"""Routes for alerts."""

from fastapi import APIRouter, Request, BackgroundTasks

from app.tasks.alert import process_alert

router = APIRouter()


@router.post("/{source}")
async def receive(
    source: str,
    request: Request,
    background_tasks: BackgroundTasks,
) -> dict:
    """Receive an alert."""
    alert = await request.json()
    background_tasks.add_task(process_alert, source, alert)
    return {"message": "ok"}
