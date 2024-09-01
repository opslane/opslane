"""
This module defines the Tenant model for the application's database.

It uses SQLModel to define the database schema and Pydantic for data validation.
"""

from typing import Optional
from sqlmodel import Field, SQLModel
from sqlalchemy import Column, JSON
from sqlalchemy.dialects.postgresql import UUID
import uuid


class Tenant(SQLModel, table=True):
    """Represents a tenant in the system."""

    id: uuid.UUID = Field(
        default_factory=uuid.uuid4,
        sa_column=Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4),
    )
    name: str = Field(index=True)
    configuration: Optional[dict] = Field(default=None, sa_column=Column(JSON))
