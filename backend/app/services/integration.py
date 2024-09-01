"""Service module for managing integrations and their credentials."""

from sqlmodel import Session

from app.db.models.integration import Integration, IntegrationCredential
from app.schemas.integration import (
    IntegrationCreate,
    IntegrationUpdate,
    IntegrationCredentialCreate,
)
from app.core.security import encrypt_credentials, decrypt_credentials


def create_integration(
    db: Session, integration: IntegrationCreate, tenant_id: str
) -> Integration:
    """
    Create a new integration for a tenant.

    Args:
        db (Session): The database session.
        integration (IntegrationCreate): The integration data to create.
        tenant_id (str): The ID of the tenant.

    Returns:
        Integration: The created integration object.
    """
    # Create the Integration object first
    db_integration = Integration(
        **integration.dict(exclude={"credential_schema"}), tenant_id=tenant_id
    )
    db.add(db_integration)
    db.commit()
    db.refresh(db_integration)

    # Encrypt the credentials
    encrypted_credentials = encrypt_credentials(integration.credential_schema)

    # Create the IntegrationCredential object with the integration_id
    db_credential = IntegrationCredential(
        tenant_id=tenant_id,
        integration_id=db_integration.id,
        encrypted_credentials=encrypted_credentials,
    )
    db.add(db_credential)
    db.commit()
    db.refresh(db_credential)

    # Update the Integration object with the credential_id
    db_integration.credential_id = db_credential.id
    db.add(db_integration)
    db.commit()
    db.refresh(db_integration)

    return db_integration


def get_integration(db: Session, integration_id: int) -> Integration:
    """
    Retrieve an integration by its ID.

    Args:
        db (Session): The database session.
        integration_id (int): The ID of the integration to retrieve.

    Returns:
        Integration: The retrieved integration object, or None if not found.
    """
    return db.query(Integration).filter(Integration.id == integration_id).first()


def get_integrations(
    db: Session, offset: int = 0, limit: int = 100
) -> list[Integration]:
    """
    Retrieve a list of integrations with pagination.

    Args:
        db (Session): The database session.
        offset (int, optional): The number of records to skip. Defaults to 0.
        limit (int, optional): The maximum number of records to return. Defaults to 100.

    Returns:
        list[Integration]: A list of Integration objects.
    """
    return db.query(Integration).offset(offset).limit(limit).all()


def update_integration(
    db: Session, integration_id: int, integration: IntegrationUpdate
) -> Integration:
    """
    Update an existing integration.

    Args:
        db (Session): The database session.
        integration_id (int): The ID of the integration to update.
        integration (IntegrationUpdate): The updated integration data.

    Returns:
        Integration: The updated integration object, or None if not found.
    """
    db_integration = get_integration(db, integration_id)
    if db_integration:
        update_data = integration.dict(exclude_unset=True)
        for key, value in update_data.items():
            setattr(db_integration, key, value)
        db.add(db_integration)
        db.commit()
        db.refresh(db_integration)
    return db_integration


def delete_integration(db: Session, integration_id: int) -> bool:
    """
    Delete an integration by its ID.

    Args:
        db (Session): The database session.
        integration_id (int): The ID of the integration to delete.

    Returns:
        bool: True if the integration was deleted, False if not found.
    """
    db_integration = get_integration(db, integration_id)
    if db_integration:
        db.delete(db_integration)
        db.commit()
        return True
    return False


def create_integration_credential(
    db: Session, credential: IntegrationCredentialCreate, integration_id: int
) -> IntegrationCredential:
    """
    Create encrypted credentials for an integration.

    Args:
        db (Session): The database session.
        credential (IntegrationCredentialCreate): The credential data to create.
        integration_id (int): The ID of the integration to associate with the credential.

    Returns:
        IntegrationCredential: The created credential object.
    """
    encrypted_credentials = encrypt_credentials(credential.credentials)
    db_credential = IntegrationCredential(
        integration_id=integration_id, encrypted_credentials=encrypted_credentials
    )
    db.add(db_credential)
    db.commit()
    db.refresh(db_credential)
    return db_credential


def get_integration_credential(db: Session, integration_id: int) -> dict:
    """
    Retrieve and decrypt credentials for an integration.

    Args:
        db (Session): The database session.
        integration_id (int): The ID of the integration to retrieve credentials for.

    Returns:
        dict: The decrypted credentials, or None if not found.
    """
    credential = (
        db.query(IntegrationCredential)
        .filter(IntegrationCredential.integration_id == integration_id)
        .first()
    )
    if credential:
        return decrypt_credentials(credential.encrypted_credentials)
    return None
