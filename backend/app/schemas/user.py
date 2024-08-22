"""Defines user-related schemas and models."""

from enum import Enum
from pydantic import BaseModel, EmailStr


class UserRole(str, Enum):
    BASIC = "basic"
    ADMIN = "admin"


class User(BaseModel):
    """Represents a user in the system."""

    id: int
    email: EmailStr
    full_name: str | None = None
    role: UserRole = UserRole.BASIC
    is_active: bool = True
