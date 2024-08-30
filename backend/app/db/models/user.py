"""
This module defines the User model and related enums for the application's database.

It uses SQLModel to define the database schema and Pydantic for data validation.
"""

from enum import Enum
from typing import Optional
from sqlmodel import Field, SQLModel
from app.db.models.base import Base


class UserRole(str, Enum):
    ADMIN = "admin"
    BASIC = "basic"


class User(Base, table=True):
    """Represents a user in the system."""

    email: str = Field(unique=True, index=True)
    full_name: Optional[str] = None
    role: UserRole = Field(default=UserRole.BASIC)
    is_active: bool = Field(default=True)

    class Config:
        use_enum_values = True
