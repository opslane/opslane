"""Datadog integration for alerting."""

import re
from datetime import datetime, timedelta
from typing import Dict, Tuple, Optional

from datadog_api_client import ApiClient, Configuration
from datadog_api_client.v1.api.events_api import EventsApi
from datadog_api_client.v1.api.monitors_api import MonitorsApi
from datadog_api_client.v1.model.event import Event
from datadog_api_client.v1.model.monitor import Monitor
from datadog_api_client.v1.model.monitor_update_request import MonitorUpdateRequest
from datadog_api_client.v2.api.events_api import EventsApi as EventsApiV2
from datadog_api_client.v2.model.events_list_request import EventsListRequest
from datadog_api_client.v2.model.events_query_filter import EventsQueryFilter
from datadog_api_client.v2.model.events_query_options import EventsQueryOptions
from datadog_api_client.v2.model.events_request_page import EventsRequestPage
from datadog_api_client.v2.model.events_sort import EventsSort
from pydantic import Field, ValidationError

from app.core.config import settings
from app.schemas.alert import (
    AlertConfigurationSchema,
    AlertSchema,
    AlertSource,
    AlertStatus,
    SeverityLevel,
)
from app.schemas.providers.datadog import DatadogAlert
from app.services.alert import calculate_alert_duration
from app.integrations.providers.base import BaseIntegration, CredentialSchema


class DatadogCredentialSchema(CredentialSchema):
    api_key: str = Field(..., min_length=1)
    app_key: str = Field(..., min_length=1)


class DatadogIntegration(BaseIntegration):
    """Integration for Datadog."""

    WEBHOOK_PAYLOAD = {
        "alert_id": "$ALERT_ID",
        "event_message": "$TEXT_ONLY_MSG",
        "title": "$EVENT_TITLE",
        "url": "$LINK",
        "alert_transition": "$ALERT_TRANSITION",
        "alert_cycle_key": "$ALERT_CYCLE_KEY",
        "hostname": "$HOSTNAME",
        "org": {"id": "$ORG_ID", "name": "$ORG_NAME"},
        "priority": "$PRIORITY",
        "snapshot": "$SNAPSHOT",
        "alert_query": "$ALERT_QUERY",
        "alert_scope": "$ALERT_SCOPE",
        "alert_status": "$ALERT_STATUS",
        "event_type": "$EVENT_TYPE",
        "event_id": "$ID",
        "alert_metric": "$ALERT_METRIC",
        "alert_priority": "$ALERT_PRIORITY",
        "alert_title": "$ALERT_TITLE",
        "alert_type": "$ALERT_TYPE",
        "event_msg": "$EVENT_MSG",
        "tags": "$TAGS",
        "last_updated": "$LAST_UPDATED",
        "date": "$DATE",
        "aggregation_key": "$AGGREG_KEY",
        "logs": "$LOGS_SAMPLE",
    }

    SEVERITY_MAP = {
        "P1": SeverityLevel.CRITICAL,
        "P2": SeverityLevel.HIGH,
        "P3": SeverityLevel.MEDIUM,
        "P4": SeverityLevel.LOW,
    }

    STATUS_MAP = {
        "Triggered": AlertStatus.OPEN,
        "Recovered": AlertStatus.RESOLVED,
        "Muted": AlertStatus.SUPPRESSED,
    }

    ALERTS_HISTORY_WINDOW = timedelta(days=30)

    def __init__(self):
        """Initialize the Datadog integration with API configuration."""
        self.configuration = Configuration()
        self.configuration.api_key["apiKeyAuth"] = settings.DATADOG_API_KEY
        self.configuration.api_key["appKeyAuth"] = settings.DATADOG_APP_KEY

    @property
    def credential_schema(self):
        return DatadogCredentialSchema.schema()

    def validate_credentials(self, credentials: Dict[str, str]) -> None:
        try:
            DatadogCredentialSchema(**credentials)
        except ValidationError as e:
            raise ValueError("Invalid Datadog credentials")

    def _should_ignore_alert(self, alert: Event) -> bool:
        """
        Check if an alert should be ignored.

        Args:
            alert (Event): The Datadog event to check.

        Returns:
            bool: True if the alert should be ignored, False otherwise.
        """
        return "[TEST]" in alert.title

    def _parse_title(self, title: str) -> Tuple[Optional[str], str, str]:
        """
        Parse the Datadog alert to extract severity, status, and title.

        Args:
            title (str): The Datadog alert title.

        Returns:
            Tuple[Optional[str], str, str]: A tuple containing severity (or None), status, and title.

        Raises:
            ValueError: If the title format is not recognized.
        """
        pattern = r"^\[(P\d+)\] \[(\w+)\] (.+)$|^\[(\w+)\] (.+)$"
        match = re.match(pattern, title)

        if not match:
            raise ValueError("Title format is not recognized")

        if match.group(1):
            # Format: [P2] [Warn] CPU load is very high
            severity = match.group(1)
            if severity not in self.SEVERITY_MAP.keys():
                print(f"The priority in title '{title}' is invalid, default priority will be used.")
            status = match.group(2)
            alert_title = match.group(3)
        else:
            # Format: [Warn] CPU load is very high
            severity = None
            status = match.group(4)
            alert_title = match.group(5)

        return severity, status, alert_title

    def _normalize_alert(
        self, alert: Event, aggregation_key: str, duration_nanoseconds: int
    ) -> AlertSchema:
        """
        Normalize Datadog alert to AlertSchema format.

        Args:
            alert (Event): Raw Datadog event object.
            aggregation_key (str): Key for grouping related alerts.
            duration_nanoseconds (int): Alert duration in nanoseconds.

        Returns:
            AlertSchema: Normalized alert object.
        """

        duration_seconds = duration_nanoseconds / 1e9 if duration_nanoseconds else None

        severity, status, alert_title = self._parse_title(alert.title)
        if severity:
            severity = severity.lstrip("[").rstrip("]")
            severity = (self.SEVERITY_MAP.get(severity, SeverityLevel.LOW),)
        else:
            severity = SeverityLevel.LOW

        status = status.lstrip("[").rstrip("]")
        status = self.STATUS_MAP.get(status, AlertStatus.OPEN)

        tags = dict(tag.split(":", 1) for tag in alert.tags if ":" in tag)

        normalized_alert = AlertSchema(
            title=alert_title,
            description=alert.text,
            severity=severity,
            status=status,
            alert_source=AlertSource.DATADOG,
            provider_event_id=str(alert.id),
            configuration_id=str(alert.monitor_id),
            host=alert.host,
            tags=tags,
            service=tags.get("service"),
            env=tags.get("env"),
            created_at=datetime.fromtimestamp(alert.get("date_happened")).isoformat(),
            provider_aggregation_key=aggregation_key,
            duration_seconds=duration_seconds,
        )

        return normalized_alert

    def _normalize_alert_configuration(
        self, monitor: Monitor
    ) -> AlertConfigurationSchema:
        """
        Format alert configuration to be stored in the database.

        Args:
            monitor (Monitor): Datadog monitor object.

        Returns:
            AlertConfigurationSchema: Normalized alert configuration.
        """
        alert_configuration = AlertConfigurationSchema(
            name=monitor.name,
            description=monitor.message,
            query=monitor.query,
            provider=AlertSource.DATADOG,
            provider_id=str(monitor.id),
            is_noisy=False,
        )

        return alert_configuration

    def get_alerts(self):
        """
        Retrieve and normalize alerts and monitor configurations from Datadog.

        This method performs the following operations:
        1. Fetches and normalizes monitor configurations.
        2. Retrieves alert events from the past ALERTS_HISTORY_WINDOW.
        3. Uses Events API v2 to get additional metadata (aggregation keys and durations).
        4. Normalizes alert events, excluding those that should be ignored.

        Returns:
            tuple: A tuple containing two lists:
                - normalized_alerts (list): Normalized alert events.
                - normalized_configurations (list): Normalized monitor configurations.

        Raises:
            DatadogAPIException: If there's an error in API communication with Datadog.

        Note:
            This method uses both Events API v1 and v2 to gather comprehensive alert data.
            The ALERTS_HISTORY_WINDOW class attribute determines how far back to fetch alerts.
        """

        normalized_alerts = []
        normalized_configurations = []

        with ApiClient(configuration=self.configuration) as api_client:
            monitors_api = MonitorsApi(api_client)
            for monitor in monitors_api.list_monitors():
                normalized_configurations.append(
                    self._normalize_alert_configuration(monitor)
                )

            events_api = EventsApi(api_client)

            end_ts = datetime.now()
            start_ts = end_ts - self.ALERTS_HISTORY_WINDOW

            response = events_api.list_events(
                start=int(start_ts.timestamp()),
                end=int(end_ts.timestamp()),
                tags="source:alert",
            )
            events = response.get("events", [])

            body = EventsListRequest(
                filter=EventsQueryFilter(
                    _from=start_ts.isoformat() + "Z",
                    to=end_ts.isoformat() + "Z",
                    query="source:alert",
                ),
                options=EventsQueryOptions(
                    timezone="GMT",
                ),
                page=EventsRequestPage(
                    limit=1000,
                ),
                sort=EventsSort.TIMESTAMP_ASCENDING,
            )

            # We use Events API v2 to get the aggregation key
            # for each event to group them together
            events_api_v2 = EventsApiV2(api_client)
            events_v2 = events_api_v2.search_events(body=body)["data"]
            events_to_aggregation_key = {}
            events_to_duration = {}

            for e in events_v2:
                attributes = e["attributes"]["attributes"]
                event_id = attributes["evt"]["id"]
                aggregation_key = attributes.get("aggregation_key")
                duration = attributes.get("duration")

                if duration:
                    events_to_duration[event_id] = duration

                if aggregation_key:
                    events_to_aggregation_key[event_id] = aggregation_key

            for event in events:
                if self._should_ignore_alert(event):
                    continue

                aggregation_key = events_to_aggregation_key.get(str(event["id"]), "")
                duration_nanoseconds = events_to_duration.get(str(event["id"]))
                normalized_alerts.append(
                    self._normalize_alert(event, aggregation_key, duration_nanoseconds)
                )

        return normalized_alerts, normalized_configurations

    def normalize_alert(self, alert: dict) -> AlertSchema:
        """
        Format alert to be sent to notifiers.

        Args:
            alert (dict): Raw alert data from Datadog webhook.

        Returns:
            AlertSchema: Normalized alert object.
        """

        datadog_alert = DatadogAlert(**alert)

        severity = self.SEVERITY_MAP.get(
            datadog_alert.alert_priority, SeverityLevel.LOW
        )

        status = self.STATUS_MAP.get(datadog_alert.alert_transition, AlertStatus.OPEN)

        # Parse tags
        tags = dict(
            tag.split(":", 1) for tag in datadog_alert.tags.split(",") if ":" in tag
        )

        created_at = datetime.fromtimestamp(int(datadog_alert.date) / 1000)

        duration_seconds = None
        if status == AlertStatus.RESOLVED:
            duration_seconds = calculate_alert_duration(
                datadog_alert.alert_cycle_key, created_at
            )

        normalized_alert = AlertSchema(
            title=datadog_alert.alert_title,
            description=datadog_alert.event_message,
            severity=severity,
            status=status,
            alert_source=AlertSource.DATADOG,
            tags=tags,
            service=tags.get("service"),
            env=tags.get("env"),
            additional_data={
                "priority": datadog_alert.priority,
                "alert_query": datadog_alert.alert_query,
                "alert_scope": datadog_alert.alert_scope,
                "alert_metric": datadog_alert.alert_metric,
                "snapshot": datadog_alert.snapshot,
                "url": datadog_alert.url,
            },
            provider_event_id=datadog_alert.event_id,
            provider_aggregation_key=datadog_alert.aggregation_key,
            provider_cycle_key=datadog_alert.alert_cycle_key,
            configuration_id=datadog_alert.alert_id,
            host=datadog_alert.hostname,
            created_at=created_at.isoformat(),
            duration_seconds=duration_seconds,
        )

        return normalized_alert

    async def silence_alert(self, alert_id: str) -> bool:
        """
        Silence a Datadog alert.

        Args:
            alert_id (str): The ID of the alert to silence.

        Returns:
            bool: True if the alert was successfully silenced, False otherwise.
        """
        try:
            with ApiClient(self.configuration) as api_client:
                api_instance = MonitorsApi(api_client)
                body = MonitorUpdateRequest(
                    options={
                        "silenced": {"*": None}
                    }  # Mute for all scopes indefinitely
                )
                api_instance.update_monitor(monitor_id=int(alert_id), body=body)
            print(f"Successfully silenced Datadog alert with ID: {alert_id}")
            return True
        except Exception as e:
            print(f"Error silencing Datadog alert: {e}")
            return False
