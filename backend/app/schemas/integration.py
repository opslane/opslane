"""Schemas for integration and integration credentials."""

from typing import Any, Optional, Dict
from uuid import UUID

from pydantic import BaseModel

from app.db.models.integration import IntegrationType


class IntegrationBase(BaseModel):
    name: str
    description: Optional[str] = None
    type: IntegrationType
    configuration: Dict[str, Any] = {}
    credential_schema: Dict[str, str] = {}
    is_active: bool = True


class IntegrationCreate(IntegrationBase):
    pass


class IntegrationUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    configuration: Optional[Dict[str, Any]] = None
    credential_schema: Optional[Dict[str, str]] = None
    is_active: Optional[bool] = None


class IntegrationResponse(BaseModel):
    id: int
    tenant_id: UUID
    name: str
    description: Optional[str] = None
    type: IntegrationType
    configuration: Dict[str, Any] = {}
    is_active: bool = True

    class Config:
        orm_mode = True


class IntegrationCredentialCreate(BaseModel):
    credentials: Dict[str, str]
