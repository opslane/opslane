"""Slack Bolt app for handling Slack events and actions."""

import asyncio

from datetime import datetime, timedelta
from typing import List

from slack_bolt.async_app import AsyncApp
from slack_bolt.adapter.fastapi.async_handler import AsyncSlackRequestHandler
from slack_sdk.errors import SlackApiError

from app.core.config import settings
from app.services.alert import get_alert_report_data
from app.ml.services.prediction import AlertPredictor


class SlackBot:
    """Slack Bot for handling Slack events and actions."""

    def __init__(self):
        self.slack_app = AsyncApp(
            token=settings.SLACK_BOT_TOKEN, signing_secret=settings.SLACK_SIGNING_SECRET
        )
        self.slack_handler = AsyncSlackRequestHandler(self.slack_app)
        self.predictor = AlertPredictor()

        self.bot_user_id = None  # We'll store the bot's user ID here
        asyncio.create_task(self._initialize_bot_user_id())

        self.allowed_bot_ids = []

        # Run the coroutine to get allowed bot IDs
        asyncio.create_task(self._initialize_allowed_bot_ids())

        self._register_event_handlers()
        self._register_command_handlers()
        self._register_action_handlers()

    async def _initialize_bot_user_id(self):
        """Initialize the bot's user ID."""
        try:
            auth_response = await self.slack_app.client.auth_test()
            self.bot_user_id = auth_response["user_id"]
        except Exception as e:
            print(f"Error fetching bot user ID: {e}")

    async def _initialize_allowed_bot_ids(self):
        """Initialize the allowed bot IDs asynchronously."""
        self.allowed_bot_ids = await self._get_allowed_bot_ids()

    async def _get_allowed_bot_ids(self) -> List[str]:
        """Fetch and return the bot IDs for allowed apps (e.g., Datadog, Sentry)."""
        allowed_bot_ids = []
        allowed_app_names = ["Datadog", "Sentry"]  # Add other app names as needed
        cursor = None

        try:
            while True:
                response = await self.slack_app.client.users_list(
                    limit=200, cursor=cursor
                )
                if response["ok"]:

                    for member in response["members"]:
                        if (
                            member["is_bot"]
                            and member["profile"]["real_name"] in allowed_app_names
                        ):
                            allowed_bot_ids.append(member["profile"]["bot_id"])

                    if not response["response_metadata"].get("next_cursor"):
                        break
                    cursor = response["response_metadata"]["next_cursor"]
                else:
                    print(f"Error fetching user list: {response['error']}")
                    break
        except SlackApiError as e:
            print(f"Error fetching user list: {e}")

        return allowed_bot_ids

    def _register_event_handlers(self):
        @self.slack_app.event("member_joined_channel")
        async def handle_member_joined(event, say):
            """Handle member_joined_channel event.

            We send the alert stats report when the Opslane bot joins a channel.
            """
            if event.get("user") == self.bot_user_id:
                report_data = get_alert_report_data()
                blocks = [
                    {
                        "type": "header",
                        "text": {
                            "type": "plain_text",
                            "text": "Weekly Alert Insights Report",
                            "emoji": True,
                        },
                    },
                    {
                        "type": "context",
                        "elements": [
                            {
                                "type": "plain_text",
                                "text": f"{report_data['start_date'].strftime('%B %d, %Y')} - {report_data['end_date'].strftime('%B %d, %Y')}",
                                "emoji": True,
                            }
                        ],
                    },
                    {"type": "divider"},
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": "📈 *Top 5 most frequent alerts*",
                        },
                    },
                    {
                        "type": "rich_text",
                        "elements": [
                            {
                                "type": "rich_text_list",
                                "style": "ordered",
                                "elements": [
                                    {
                                        "type": "rich_text_section",
                                        "elements": [
                                            {
                                                "type": "text",
                                                "text": f"{alert.title} ({alert.count} times)",
                                            }
                                        ],
                                    }
                                    for alert in report_data["top_alerts"]
                                ],
                            }
                        ],
                    },
                    {"type": "divider"},
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": "🔥 *Noisiest Services*",
                        },
                    },
                    {
                        "type": "rich_text",
                        "elements": [
                            {
                                "type": "rich_text_list",
                                "style": "ordered",
                                "elements": [
                                    {
                                        "type": "rich_text_section",
                                        "elements": [
                                            {
                                                "type": "text",
                                                "text": f"{service} ({count} noisy alerts)",
                                            }
                                        ],
                                    }
                                    for service, count in report_data["noisy_services"]
                                ],
                            }
                        ],
                    },
                    {"type": "divider"},
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": "📆 *Daily Alert Volume*",
                        },
                    },
                    {
                        "type": "rich_text",
                        "elements": [
                            {
                                "type": "rich_text_list",
                                "style": "bullet",
                                "elements": [
                                    {
                                        "type": "rich_text_section",
                                        "elements": [
                                            {
                                                "type": "text",
                                                "text": f"{date}: {count} alerts",
                                            }
                                        ],
                                    }
                                    for date, count in report_data["daily_volume"]
                                ],
                            }
                        ],
                    },
                ]

                await say(blocks=blocks)

        @self.slack_app.event("message")
        async def handle_message_events(event, say):
            """Callback for message events.

            We use this callback to send the alert reasoning to the user.
            """
            if "bot_id" in event and event["bot_id"] in self.allowed_bot_ids:
                # alerts = get_alert_configuration_stats()
                # prediction = await self.predictor.predict(str(alerts[0]))

                channel_id = event["channel"]
                thread_ts = event["ts"]

                await say(
                    blocks=[
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                # "text": prediction["reasoning"],
                                "text": "This is my reasoning for the alert",
                            },
                        },
                        {
                            "type": "actions",
                            "elements": [
                                {
                                    "type": "button",
                                    "text": {"type": "plain_text", "text": "👍"},
                                    "value": "thumbs_up",
                                    "action_id": "thumbs_up",
                                },
                                {
                                    "type": "button",
                                    "text": {"type": "plain_text", "text": "👎"},
                                    "value": "thumbs_down",
                                    "action_id": "thumbs_down",
                                },
                            ],
                        },
                    ],
                    channel=channel_id,
                    thread_ts=thread_ts,
                )

    async def send_insight_report(self, say):
        """Send the weekly alert insights report to the user."""
        report_data = get_alert_report_data()

        # Calculate total alerts and noisy alerts
        total_alerts = len(report_data["open_alerts"])
        noisy_alerts = report_data["noisy_alerts_count"]
        reduction_percentage = (
            (noisy_alerts / total_alerts) * 100 if total_alerts > 0 else 0
        )

        blocks = [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": "Weekly Alert Insights Report",
                    "emoji": True,
                },
            },
            {
                "type": "context",
                "elements": [
                    {
                        "type": "plain_text",
                        "text": f"{report_data['start_date'].strftime('%B %d, %Y')} - {report_data['end_date'].strftime('%B %d, %Y')}",
                        "emoji": True,
                    }
                ],
            },
            {"type": "divider"},
            {
                "type": "context",
                "elements": [{"type": "plain_text", "text": " ", "emoji": True}],
            },
            {
                "type": "rich_text",
                "elements": [
                    {
                        "type": "rich_text_section",
                        "elements": [
                            {
                                "type": "text",
                                "text": "Total alerts triggered",
                                "style": {"bold": True},
                            },
                            {"type": "text", "text": f"\n{total_alerts}\n\n"},
                            {
                                "type": "text",
                                "text": "Alerts marked as noisy by Opslane",
                                "style": {"bold": True},
                            },
                            {"type": "text", "text": f"\n{noisy_alerts}\n\n"},
                            {
                                "type": "text",
                                "text": "Reduction in alert volume",
                                "style": {"bold": True},
                            },
                            {"type": "text", "text": f"\n{reduction_percentage:.0f}%"},
                        ],
                    }
                ],
            },
            {
                "type": "context",
                "elements": [{"type": "plain_text", "text": " ", "emoji": True}],
            },
            {"type": "divider"},
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "📈 *Top 5 most frequent alerts*"},
            },
            {
                "type": "rich_text",
                "elements": [
                    {
                        "type": "rich_text_list",
                        "style": "ordered",
                        "indent": 0,
                        "border": 0,
                        "elements": [
                            {
                                "type": "rich_text_section",
                                "elements": [
                                    {
                                        "type": "text",
                                        "text": f"{alert.title} ({alert.count} times)",
                                    }
                                ],
                            }
                            for alert in report_data["top_alerts"]
                        ],
                    }
                ],
            },
            {
                "type": "context",
                "elements": [{"type": "plain_text", "text": " ", "emoji": True}],
            },
            {"type": "divider"},
            {
                "type": "context",
                "elements": [{"type": "plain_text", "text": " ", "emoji": True}],
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "🔥 *Noisiest Services*"},
            },
            {
                "type": "rich_text",
                "elements": [
                    {
                        "type": "rich_text_list",
                        "style": "ordered",
                        "indent": 0,
                        "border": 0,
                        "elements": [
                            {
                                "type": "rich_text_section",
                                "elements": [
                                    {
                                        "type": "text",
                                        "text": f"{service} ({count} noisy alerts)",
                                    }
                                ],
                            }
                            for service, count in report_data["noisy_services"]
                        ],
                    }
                ],
            },
            {
                "type": "context",
                "elements": [{"type": "plain_text", "text": " ", "emoji": True}],
            },
            {"type": "divider"},
            {
                "type": "context",
                "elements": [{"type": "plain_text", "text": " ", "emoji": True}],
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "📆 *Daily Alert Volume*"},
            },
            {
                "type": "rich_text",
                "elements": [
                    {
                        "type": "rich_text_list",
                        "style": "ordered",
                        "indent": 0,
                        "border": 0,
                        "elements": [
                            {
                                "type": "rich_text_section",
                                "elements": [
                                    {"type": "text", "text": f"{date} ({count} alerts)"}
                                ],
                            }
                            for date, count in report_data["daily_volume"]
                        ],
                    }
                ],
            },
        ]

        await say(blocks=blocks)

    def _register_command_handlers(self):
        @self.slack_app.command("/opslane")
        async def handle_opslane_command(ack, body, say):
            """Handle the /opslane command.

            There is one subcommand currently:
            - 'insight': Generates a weekly alert insights report.

            """
            await ack()
            text = body.get("text", "").strip()
            user_id = body["user_id"]

            if text.startswith("insight"):
                await self.send_insight_report(say)
            else:
                await say(
                    f"Unknown parameter: {text}. Please use 'insight' or 'train'."
                )

    def _register_action_handlers(self):
        @self.slack_app.action("thumbs_up")
        async def handle_thumbs_up(ack, body, say):
            """Handle the thumbs_up action.

            We use this action to update the alert metadata in the database.
            """
            await ack()
            user_id = body["user"]["id"]
            channel_id = body["container"]["channel_id"]
            await self.slack_app.client.chat_postEphemeral(
                channel=channel_id,
                user=user_id,
                text=f"Thanks for the feedback, <@{user_id}>!",
            )

        @self.slack_app.action("thumbs_down")
        async def handle_thumbs_down(ack, body, say):
            """Handle the thumbs_down action.

            We use this action to update the alert metadata in the database.
            """
            await ack()
            user_id = body["user"]["id"]
            channel_id = body["container"]["channel_id"]
            await self.slack_app.client.chat_postEphemeral(
                channel=channel_id,
                user=user_id,
                text=f"Thanks for the feedback, <@{user_id}>!",
            )

    async def fetch_messages_from_channel(self, channel_id: str):
        """Fetch messages from a channel.

        This method fetches messages from a channel using the conversations.history API.
        """
        thirty_days_ago = datetime.now() - timedelta(days=30)
        oldest_timestamp = int(thirty_days_ago.timestamp())
        messages = []
        has_more = True
        cursor = None
        while has_more:
            response = await self.slack_app.client.conversations_history(
                channel=channel_id, oldest=oldest_timestamp, limit=200, cursor=cursor
            )
            messages.extend(response["messages"])
            cursor = response.get("response_metadata", {}).get("next_cursor")
            has_more = bool(cursor)
        return messages


# Initialize the SlackBot
slack_bot = SlackBot()
slack_handler = slack_bot.slack_handler
