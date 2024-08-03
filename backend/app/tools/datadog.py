from datetime import datetime, timedelta
from typing import Dict, Any, List

from datadog_api_client import ApiClient, Configuration
from datadog_api_client.v2.api.logs_api import LogsApi
from datadog_api_client.v2.model.logs_list_request import LogsListRequest
from datadog_api_client.v2.model.logs_list_request_page import LogsListRequestPage
from datadog_api_client.v2.model.logs_sort import LogsSort

from app.core.config import settings


def fetch_datadog_logs(query: str, time_range: int = 15) -> List[Dict[str, Any]]:
    """
    Fetch logs from Datadog based on a query and time range.

    Args:
        query (str): The search query to filter logs.
        time_range (int): The time range in minutes to look back for logs. Default is 15 minutes.

    Returns:
        List[Dict[str, Any]]: A list of log entries matching the query.
    """
    # Configure the Datadog API client
    configuration = Configuration()
    configuration.api_key["apiKeyAuth"] = settings.DATADOG_API_KEY
    configuration.api_key["appKeyAuth"] = settings.DATADOG_APP_KEY

    # Calculate the time range
    now = datetime.now()
    from_time = (now - timedelta(minutes=time_range)).isoformat() + "Z"
    to_time = now.isoformat() + "Z"

    # Prepare the request
    body = LogsListRequest(
        filter={
            "query": "service: backend-service",
            "from": from_time,
            "to": to_time,
        },
        sort=LogsSort.TIMESTAMP_DESCENDING,
        page=LogsListRequestPage(limit=100),
    )

    # Make the API call
    with ApiClient(configuration) as api_client:
        api_instance = LogsApi(api_client)
        response = api_instance.list_logs(body=body)

    # Process and return the logs
    logs = []
    for log in response.data:
        log_entry = {
            "id": log.id,
            "timestamp": log.attributes.timestamp,
            "message": log.attributes.message,
            "service": log.attributes.service,
            "status": log.attributes.status,
            "host": log.attributes.host,
        }
        logs.append(log_entry)

    return logs
