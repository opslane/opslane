"""
This module provides functions for interacting with the PagerDuty API.

It includes functions to retrieve alert IDs and fetch incident alert details.
"""

from typing import Dict

from pdpyras import APISession

from app.core.config import settings


def get_alert_id(incident_id: str) -> str:
    """
    Retrieve the alert ID for a given incident ID.

    Args:
        incident_id (str): The ID of the incident.

    Returns:
        str: The ID of the first alert associated with the incident.
    """
    session = APISession(settings.PAGERDUTY_API_TOKEN)

    # Fetch the incident
    return session.rget(f"/incidents/{incident_id}/alerts")[0]["id"]


def fetch_pagerduty_incident_alert(incident_id: str, alert_id: str) -> Dict:
    """
    Fetch PagerDuty alert details for a given incident and alert ID.

    Args:
        incident_id (str): The ID of the incident.
        alert_id (str): The ID of the alert.

    Returns:
        Dict: A dictionary containing the alert details.
    """
    # Create a session with your PagerDuty API token
    session = APISession(settings.PAGERDUTY_API_TOKEN)

    # Fetch the incident
    return session.rget(f"/incidents/{incident_id}/alerts/{alert_id}")
