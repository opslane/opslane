"""Utility functions for alert processing and feature engineering."""

from typing import Dict, Any, List, Tuple

from langchain.schema import Document

from app.schemas.alert import SeverityLevel
from app.core.vector_store import VectorStore
from app.core.config import settings


def map_severity(severity: SeverityLevel) -> int:
    """Map severity level to a numerical score."""
    severity_map = {
        SeverityLevel.CRITICAL: 4,
        SeverityLevel.HIGH: 3,
        SeverityLevel.MEDIUM: 2,
        SeverityLevel.LOW: 1,
    }
    return severity_map.get(severity, 0)


def search_similar_alerts(
    vector_store: VectorStore, query: str, k: int = 5
) -> List[Tuple[Document, float]]:
    """
    Search for similar alerts in the vector store.

    Args:
        vector_store (VectorStore): The vector store instance to search in.
        query (str): The query string to search for.
        k (int): The number of similar alerts to return.

    Returns:
        List[Tuple[Document, float]]: A list of tuples containing the similar documents and their similarity scores.
    """
    return vector_store.vector_store.similarity_search_with_score(query, k=k)


def get_avg_slack_responses(alert_string: str) -> float:
    """Calculate average Slack responses for similar alerts."""
    vector_store = VectorStore(settings.SLACK_COLLECTION_NAME)
    similar_alerts = search_similar_alerts(vector_store, alert_string, k=5)

    if not similar_alerts:
        return 0.0

    total_responses = sum(
        len(alert.metadata.get("thread_messages", [])) for alert, _ in similar_alerts
    )
    return total_responses / len(similar_alerts)


def engineer_features(
    alert: Dict[str, Any], alert_stats: Dict[str, Any]
) -> Dict[str, Any]:
    """Engineer features for alert classification."""
    alert_string = f"{alert['title']} {alert.get('description', '')}"
    return {
        "severity_score": map_severity(alert["severity"]),
        "unique_open_alerts": alert_stats["unique_open_alerts"],
        "avg_resolution_time": alert_stats["average_duration_seconds"],
        "is_noisy": alert.get("is_noisy", False),
        "noisy_alerts_count": alert_stats["noisy_alerts_count"],
        "occurrence_frequency": alert_stats["unique_open_alerts"],
        "time_of_day": alert["created_at"].hour if alert["created_at"] else 0,
        "day_of_week": alert["created_at"].weekday() if alert["created_at"] else 0,
        "alert_title_length": len(alert["title"]),
        "avg_slack_responses": get_avg_slack_responses(alert_string),
    }
