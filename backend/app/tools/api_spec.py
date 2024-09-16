import json
import requests

from langchain.tools import tool

from app.vendors import VENDOR_MAP


@tool
def get_api_spec(service_name: str) -> str:
    """Get the API Spec for the specified service.

    Args:
        service_name (str): Name of external service.

    Returns:
        str: The content of the website.
    """
    service_name = service_name.upper()
    vendor_data = VENDOR_MAP.get(service_name)
    if not vendor_data:
        return ""

    api_spec_url = vendor_data.get("API_SPEC")
    response = requests.get(api_spec_url)
    response.raise_for_status()
    return json.dumps(response.json())
