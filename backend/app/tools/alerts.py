"""Agent tools related to alerts."""

from app.services.alert import get_alert_configuration_stats


def fetch_alert_stats(alert_id: str) -> dict:
    """Get statistics for the current alert."""
    return get_alert_configuration_stats(alert_id)


def debug_noisy_alert(alert_id: str) -> dict:
    """Debug a noisy alert."""
    return {
        "owner": "John Doe",
    }
