"""Routes for alerts."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/")
async def get() -> dict:
    """Get all alerts."""
    return {"alerts": ["Alert 1", "Alert 2"]}
