"""Pydantic schemas for tenant-related operations."""

import uuid
from typing import Optional, Dict

from pydantic import BaseModel, ConfigDict


class TenantBase(BaseModel):
    name: str
    configuration: Optional[Dict] = None


class TenantCreate(TenantBase):
    pass


class TenantUpdate(BaseModel):
    name: Optional[str] = None
    configuration: Optional[Dict] = None


class TenantInDB(TenantBase):
    id: uuid.UUID

    model_config = ConfigDict(from_attributes=True)
