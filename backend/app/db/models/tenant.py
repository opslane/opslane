"""
This module defines the Tenant model for the application's database.

It uses SQLModel to define the database schema and Pydantic for data validation.
"""

from typing import Optional
from sqlmodel import Field, SQLModel
from sqlalchemy import Column, JSON


class Tenant(SQLModel, table=True):
    """Represents a tenant in the system."""

    id: str = Field(primary_key=True)
    name: str = Field(index=True)
    configuration: Optional[dict] = Field(default=None, sa_column=Column(JSON))
