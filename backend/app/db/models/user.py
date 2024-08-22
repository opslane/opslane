"""
This module defines the User model and related enums for the application's database.

It uses SQLModel to define the database schema and Pydantic for data validation.
"""

from typing import Optional
from sqlmodel import Field, SQLModel
from enum import Enum


class UserRole(str, Enum):
    BASIC = "basic"
    ADMIN = "admin"


class User(SQLModel, table=True):
    """Represents a user in the system."""

    id: Optional[int] = Field(default=None, primary_key=True)
    email: str = Field(unique=True, index=True)
    full_name: Optional[str] = None
    role: UserRole = Field(default=UserRole.BASIC)
    is_active: bool = Field(default=True)

    class Config:
        use_enum_values = True
