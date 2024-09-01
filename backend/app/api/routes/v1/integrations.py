"""API routes for managing integrations and their credentials."""

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session
from typing import List

from app.api.deps import get_db, get_current_tenant_id
from app.schemas.integration import (
    IntegrationCreate,
    IntegrationUpdate,
    IntegrationResponse,
    IntegrationCredentialCreate,
)
from app.services import integration as integration_service

router = APIRouter()


@router.post("/", response_model=IntegrationResponse)
def create_integration(
    integration: IntegrationCreate,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(get_current_tenant_id),
):
    """Create a new integration for the current tenant."""
    try:
        return integration_service.create_integration(db, integration, tenant_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{integration_id}", response_model=IntegrationResponse)
def get_integration(integration_id: int, db: Session = Depends(get_db)):
    """Retrieve a specific integration by its ID."""
    db_integration = integration_service.get_integration(db, integration_id)
    if db_integration is None:
        raise HTTPException(status_code=404, detail="Integration not found")
    return db_integration


@router.get("/", response_model=List[IntegrationResponse])
def get_integrations(offset: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    """Retrieve a list of integrations with pagination."""
    integrations = integration_service.get_integrations(db, offset=offset, limit=limit)
    return integrations


@router.put("/{integration_id}", response_model=IntegrationResponse)
def update_integration(
    integration_id: int, integration: IntegrationUpdate, db: Session = Depends(get_db)
):
    """Update an existing integration."""
    db_integration = integration_service.update_integration(
        db, integration_id, integration
    )
    if db_integration is None:
        raise HTTPException(status_code=404, detail="Integration not found")
    return db_integration


@router.delete("/{integration_id}", response_model=bool)
def delete_integration(integration_id: int, db: Session = Depends(get_db)):
    """Delete an integration by its ID."""
    result = integration_service.delete_integration(db, integration_id)
    if not result:
        raise HTTPException(status_code=404, detail="Integration not found")
    return result
