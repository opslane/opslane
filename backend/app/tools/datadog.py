"""Module for interacting with Datadog logs and creating log links."""

import json
from datetime import datetime, timezone
from urllib.parse import quote_plus

from langchain_community.document_loaders import DatadogLogsLoader
from langchain_core.documents.base import Document

from langchain.tools import tool

from app.core.config import settings


def fetch_datadog_logs(
    query: str, from_time: str = "now-15m", num_documents: int = 10
) -> str:
    """
    Fetch Datadog logs based on the query and timeframe.

    Args:
        query (str): The query string to search for in Datadog logs.

    Returns:
        str: A JSON string containing the fetched log documents.
    """
    to_time = "now"

    loader = DatadogLogsLoader(
        query=query,
        api_key=settings.DATADOG_API_KEY,
        app_key=settings.DATADOG_APP_KEY,
        from_time=from_time,
        to_time=to_time,
        limit=50,
    )

    documents = loader.load()
    formatted_docs = [
        {"content": doc.page_content, "log_link": create_datadog_log_link(doc)}
        for doc in documents[:num_documents]
    ]

    return json.dumps(formatted_docs)


def create_datadog_log_link(document: Document) -> str:
    """
    Create a Datadog log link for a given document.

    Args:
        document: The document containing log information.

    Returns:
        str: The URL link to the specific log in Datadog.
    """
    # Extract necessary information from the document
    timestamp = int(document.metadata["timestamp"].timestamp() * 1000)
    attributes = {
        "service": document.metadata.get("service"),
        "status": document.metadata.get("status"),
    }
    message = document.page_content

    # Base URL for Datadog logs
    base_url = "https://app.datadoghq.com/logs"

    # Construct the query from attributes
    query_parts = []
    for key, value in attributes.items():
        if value is not None:
            query_parts.append(f"{key}:{value}")

    # Add tags to the query
    tags = document.metadata.get("tags", [])
    for tag in tags:
        query_parts.append(f"{tag}")

    query = " ".join(query_parts)

    # Construct the query parameters
    query_params = [
        f"query={quote_plus(query)}",
        f"from_ts={timestamp - 50000}",  # 50 seconds before the log
        f"to_ts={timestamp + 50000}",  # 50 seconds after the log
        "live=false",
        "messageDisplay=inline-expanded",
    ]

    # Encode the message for the URL
    encoded_message = quote_plus(
        message[:100]
    )  # Use first 100 characters of the message
    query_params.append(f"messageQuery={encoded_message}")

    # Construct the full URL
    url = f"{base_url}?{'&'.join(query_params)}"

    return url
