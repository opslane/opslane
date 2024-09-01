"""
This module provides dependency functions for user authentication and authorization.

It includes functions to get mock users, current users, and admin users,
which can be used as dependencies in FastAPI route handlers.
"""

from typing import Generator

from fastapi import Depends, HTTPException, status
from sqlmodel import Session

from app.core.auth.config import auth_settings, AuthType
from app.db.base import get_session
from app.schemas.user import User, UserRole
from app.services import tenant as tenant_service


def get_db() -> Generator:
    try:
        db = get_session()
        yield next(db)
    finally:
        db.close()


async def get_current_tenant_id(db: Session = Depends(get_db)) -> str:
    opslane_tenant = tenant_service.get_tenant_by_name(db, "Opslane")
    if opslane_tenant:
        return str(opslane_tenant.id)
    raise HTTPException(status_code=404, detail="Opslane tenant not found")


def get_mock_user() -> User:
    """
    Create and return a mock user for testing purposes.

    Returns:
        User: A mock User object with admin privileges.
    """
    return User(
        id=1,
        email="admin@example.com",
        full_name="Mock Admin",
        role=UserRole.ADMIN,
        is_active=True,
    )


async def get_current_user() -> User:
    """
    Get the current authenticated user.

    Args:
        session (Session, optional): The database session. Defaults to Depends(get_session).

    Returns:
        User: The authenticated user.

    Raises:
        HTTPException: If authentication fails or is not implemented for the current auth type.
    """
    if auth_settings.AUTH_TYPE == AuthType.DISABLED:
        return get_mock_user()

    # Add logic for other auth types in the future
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)


async def get_current_admin_user(
    current_user: User = Depends(get_current_user),
) -> User:
    """
    Get the current authenticated user and verify they have admin privileges.

    Args:
        current_user (User, optional): The current authenticated user. Defaults to Depends(get_current_user).

    Returns:
        User: The authenticated admin user.

    Raises:
        HTTPException: If the current user does not have admin privileges.
    """
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin privileges required"
        )
    return current_user
