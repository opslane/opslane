"""Module for handling credential encryption and decryption."""

import json
from cryptography.fernet import Fernet

from app.core.config import settings

fernet = Fernet(settings.ENCRYPTION_KEY)


def encrypt_credentials(credentials: dict) -> str:
    """
    Encrypt a dictionary of credentials.

    Args:
        credentials (dict): The credentials to encrypt.

    Returns:
        str: The encrypted credentials as a string.
    """
    credentials_json = json.dumps(credentials)
    return fernet.encrypt(credentials_json.encode()).decode()


def decrypt_credentials(encrypted_credentials: str) -> dict:
    """
    Decrypt an encrypted credentials string.

    Args:
        encrypted_credentials (str): The encrypted credentials string.

    Returns:
        dict: The decrypted credentials as a dictionary.
    """
    decrypted_json = fernet.decrypt(encrypted_credentials.encode()).decode()
    return json.loads(decrypted_json)
