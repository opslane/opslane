"""Module for handling telemetry using Posthog."""

import logging
import sys

from posthog import Posthog

from app.telemetry import TelemetryClient, TelemetryEvent
from app.core.config import settings

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    handlers=[logging.StreamHandler(sys.stdout), logging.StreamHandler(sys.stderr)],
)


class PosthogClient(TelemetryClient):
    """Client for sending telemetry events to Posthog."""

    def __init__(self) -> None:
        """Initialize the Posthog client."""
        self._posthog = Posthog(
            project_api_key="phc_LM9IWI6X0t1EtAi8hXrBqUNU4TW4FaruX9NvVMm1Cun",
            host="https://us.i.posthog.com",
        )

        if not settings.ANONYMIZED_TELEMETRY:
            self._posthog.disabled = True

        posthog_logger = logging.getLogger("posthog")
        posthog_logger.disabled = True

        super().__init__()

    def capture(self, event: TelemetryEvent) -> None:
        """
        Capture and send a telemetry event to Posthog.

        Args:
            event (TelemetryEvent): The telemetry event to be captured.

        Returns:
            None
        """
        try:
            self._posthog.capture(
                self.user_id,
                event.name,
                {},
            )
        except Exception as e:
            logger.error(f"Failed to send telemetry event {event.name}: {e}")


posthog_client = PosthogClient()
