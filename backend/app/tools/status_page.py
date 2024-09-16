import json
import requests

from langchain.tools import tool

from app.vendors import VENDOR_MAP


@tool
def get_status_page_content(service_name: str) -> str:
    """Get the status page content of the provided service_name.

    For e.g. if service_name is "RENDER", it will return the status page content of Render.

    Args:
        url (str): The URL of the website.

    Returns:
        str: The content of the website.
    """
    service_name = service_name.upper()
    vendor_data = VENDOR_MAP.get(service_name)
    if not vendor_data:
        return ""

    status_page_url = f"{vendor_data.get('STATUS_PAGE')}/api/v2/summary.json"
    response = requests.get(status_page_url)
    response.raise_for_status()
    return json.dumps(response.json())
