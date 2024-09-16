"""Mapping of vendor-specific configuration details."""

from app.core.config import settings

VENDOR_MAP = {
    "RENDER": {
        "API_KEY": settings.RENDER_API_KEY,
        "STATUS_PAGE": "https://status.render.com/",
        "API_SPEC": "https://api-docs.render.com/openapi/6140fb3daeae351056086186",
    }
}


def get_api_key(vendor_name: str) -> str:
    """Get the API key for the specified vendor.

    Args:
        vendor_name (str): Name of the vendor.

    Returns:
        str: The API key for the vendor.
    """
    vendor_data = VENDOR_MAP.get(vendor_name.upper())
    if not vendor_data:
        return ""

    return vendor_data.get("API_KEY")
