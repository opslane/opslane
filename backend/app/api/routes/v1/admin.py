"""Routes for admin endpoints."""

from fastapi import APIRouter, Depends
from app.api.deps import get_current_admin_user
from app.schemas.user import User

router = APIRouter()


@router.get("/test", response_model=dict)
async def test(current_admin: User = Depends(get_current_admin_user)):
    return {"message": f"Hello, Admin {current_admin.full_name}!"}
