"""
This module provides authentication enforcement for FastAPI routes.
It configures route dependencies based on authentication settings and path patterns.
"""

from fastapi import FastAPI, Depends
from app.core.auth.config import auth_settings, AuthType
from app.api.deps import get_current_user, get_current_admin_user


def enforce_authentication(app: FastAPI) -> None:
    """
    Enforce authentication on FastAPI routes based on configuration.

    This function adds authentication dependencies to routes that are not public.
    Admin routes require a current user, while other routes allow optional authentication.

    Args:
        app (FastAPI): The FastAPI application instance.

    Returns:
        None
    """
    if auth_settings.AUTH_TYPE == AuthType.DISABLED:
        return

    public_paths = {}
    for route in app.routes:
        if route.path not in public_paths:
            if "admin" in route.path:
                route.dependencies.append(Depends(get_current_admin_user))
            else:
                route.dependencies.append(Depends(get_current_user))
