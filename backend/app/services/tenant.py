from sqlalchemy.orm import Session
from app.db.models.tenant import Tenant
from app.schemas.tenant import TenantCreate, TenantUpdate
from typing import List, Optional


def create_tenant(db: Session, tenant: TenantCreate) -> Tenant:
    """
    Create a new tenant in the database.

    Args:
        db (Session): The database session.
        tenant (TenantCreate): The tenant data to create.

    Returns:
        Tenant: The created tenant.
    """
    db_tenant = Tenant(**tenant.dict())
    db.add(db_tenant)
    db.commit()
    db.refresh(db_tenant)
    return db_tenant


def get_tenant(db: Session, tenant_id: str) -> Optional[Tenant]:
    """
    Retrieve a tenant by ID.

    Args:
        db (Session): The database session.
        tenant_id (str): The ID of the tenant to retrieve.

    Returns:
        Optional[Tenant]: The retrieved tenant, or None if not found.
    """
    return db.query(Tenant).filter(Tenant.id == tenant_id).first()


def get_tenants(db: Session, skip: int = 0, limit: int = 100) -> List[Tenant]:
    """
    Retrieve a list of tenants.

    Args:
        db (Session): The database session.
        skip (int): The number of tenants to skip (for pagination).
        limit (int): The maximum number of tenants to return.

    Returns:
        List[Tenant]: A list of tenants.
    """
    return db.query(Tenant).offset(skip).limit(limit).all()


def update_tenant(
    db: Session, tenant_id: str, tenant: TenantUpdate
) -> Optional[Tenant]:
    """
    Update an existing tenant.

    Args:
        db (Session): The database session.
        tenant_id (str): The ID of the tenant to update.
        tenant (TenantUpdate): The updated tenant data.

    Returns:
        Optional[Tenant]: The updated tenant, or None if not found.
    """
    db_tenant = get_tenant(db, tenant_id)
    if db_tenant:
        update_data = tenant.dict(exclude_unset=True)
        for key, value in update_data.items():
            setattr(db_tenant, key, value)
        db.add(db_tenant)
        db.commit()
        db.refresh(db_tenant)
    return db_tenant


def delete_tenant(db: Session, tenant_id: str) -> bool:
    """
    Delete a tenant.

    Args:
        db (Session): The database session.
        tenant_id (str): The ID of the tenant to delete.

    Returns:
        bool: True if the tenant was deleted, False if not found.
    """
    db_tenant = get_tenant(db, tenant_id)
    if db_tenant:
        db.delete(db_tenant)
        db.commit()
        return True
    return False


def get_tenant_by_name(db: Session, name: str) -> Optional[Tenant]:
    """
    Retrieve a tenant by name.

    Args:
        db (Session): The database session.
        name (str): The name of the tenant to retrieve.

    Returns:
        Optional[Tenant]: The retrieved tenant, or None if not found.
    """
    return db.query(Tenant).filter(Tenant.name == name).first()
