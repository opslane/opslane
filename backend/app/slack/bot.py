"""Main SlackBot class for handling Slack events and actions."""

import asyncio
from typing import Set
from slack_bolt.async_app import AsyncApp
from slack_bolt.adapter.fastapi.async_handler import AsyncSlackRequestHandler
from app.core.config import settings
from app.ml.services.prediction import AlertPredictor
from app.ml.vector_store import VectorStore
from app.slack.handlers.event_handlers import register_event_handlers
from app.slack.handlers.command_handlers import register_command_handlers
from app.slack.handlers.action_handlers import register_action_handlers
from app.slack.utils import (
    load_alert_channels,
    save_alert_channels,
    get_allowed_bot_ids,
)


class SlackBot:
    """
    Main SlackBot class for handling Slack events and actions.
    """

    def __init__(self):
        """
        Initialize the SlackBot with necessary components and configurations.
        """
        self.slack_app: AsyncApp = AsyncApp(
            token=settings.SLACK_BOT_TOKEN, signing_secret=settings.SLACK_SIGNING_SECRET
        )
        self.slack_handler: AsyncSlackRequestHandler = AsyncSlackRequestHandler(
            self.slack_app
        )
        self.predictor: AlertPredictor = AlertPredictor()
        self.vector_store: VectorStore = VectorStore()
        self.bot_user_id: str | None = None
        self.allowed_bot_ids: list[str] = []
        self.alert_channels: Set[str] = load_alert_channels()

        asyncio.create_task(self._initialize())
        self._register_handlers()

    async def _initialize(self) -> None:
        """
        Initialize bot user ID and allowed bot IDs asynchronously.
        """
        await self._initialize_bot_user_id()
        await self._initialize_allowed_bot_ids()

    async def _initialize_bot_user_id(self) -> None:
        """
        Fetch and set the bot user ID from Slack API.
        """
        try:
            auth_response = await self.slack_app.client.auth_test()
            self.bot_user_id = auth_response["user_id"]
        except Exception as e:
            print(f"Error fetching bot user ID: {e}")

    async def _initialize_allowed_bot_ids(self) -> None:
        """
        Fetch and set the list of allowed bot IDs.
        """
        self.allowed_bot_ids = await get_allowed_bot_ids(self.slack_app)

    def _register_handlers(self) -> None:
        """
        Register event, command, and action handlers for the SlackBot.
        """
        register_event_handlers(self)
        register_command_handlers(self)
        register_action_handlers(self)

    async def update_alert_channels(self) -> None:
        """
        Update the set of alert channels by fetching the latest information from Slack API.
        """
        try:
            response = await self.slack_app.client.users_conversations(
                user=self.bot_user_id, types="public_channel,private_channel"
            )
            for channel in response["channels"]:
                self.alert_channels.add(channel["id"])
            save_alert_channels(self.alert_channels)
        except Exception as e:
            print(f"Error updating alert channels: {e}")


slack_bot: SlackBot = SlackBot()
slack_handler: AsyncSlackRequestHandler = slack_bot.slack_handler
