"""
Module for handling telemetry events and client functionality.

This module provides classes and utilities for managing telemetry events
and implementing telemetry clients.
"""

import abc
import os
import uuid
from abc import abstractmethod
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TelemetryEvent:
    """
    Represents a telemetry event with a name and associated properties.

    Attributes:
        name (str): The name of the telemetry event.
    """

    name: str


class TelemetryClient(abc.ABC):
    """
    Abstract base class for telemetry clients.

    This class defines the interface for telemetry clients and provides
    common functionality for user ID management.
    """

    USER_ID_PATH = str(Path.home() / ".cache" / "opslane" / "telemetry_user_id")
    UNKNOWN_USER_ID = "UNKNOWN"
    _curr_user_id = None

    @abstractmethod
    def capture(self, event: TelemetryEvent) -> None:
        """
        Capture and process a telemetry event.

        Args:
            event (TelemetryEvent): The telemetry event to be captured.
        """
        pass

    @property
    def user_id(self) -> str:
        """
        Get the user ID for telemetry purposes.

        Returns:
            str: The user ID, either retrieved from storage or newly generated.
        """
        if self._curr_user_id:
            return self._curr_user_id

        # File access may fail due to permissions or other reasons. We don't want to
        # crash so we catch all exceptions.
        try:
            if not os.path.exists(self.USER_ID_PATH):
                os.makedirs(os.path.dirname(self.USER_ID_PATH), exist_ok=True)
                with open(self.USER_ID_PATH, "w", encoding="utf-8") as f:
                    new_user_id = str(uuid.uuid4())
                    f.write(new_user_id)
                self._curr_user_id = new_user_id
            else:
                with open(self.USER_ID_PATH, "r", encoding="utf-8") as f:
                    self._curr_user_id = f.read()
        except Exception:
            self._curr_user_id = self.UNKNOWN_USER_ID
        return self._curr_user_id
