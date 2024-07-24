"""Slack Bolt app for handling Slack events and actions."""

import asyncio
import json
import re

from datetime import datetime, timedelta
from hashlib import md5
from typing import List

from slack_bolt.async_app import AsyncApp
from slack_bolt.adapter.fastapi.async_handler import AsyncSlackRequestHandler
from slack_sdk.errors import SlackApiError

from app.core.config import settings
from app.ml.services.prediction import AlertPredictor
from app.ml.vector_store import VectorStore
from app.services.alert import (
    get_alert_report_data,
    get_alert_configuration_stats,
    mark_alert_configuration_as_noisy,
)


class SlackBot:
    """Slack Bot for handling Slack events and actions."""

    def __init__(self):
        self.slack_app = AsyncApp(
            token=settings.SLACK_BOT_TOKEN, signing_secret=settings.SLACK_SIGNING_SECRET
        )
        self.slack_handler = AsyncSlackRequestHandler(self.slack_app)
        self.predictor = AlertPredictor()
        self.vector_store = VectorStore()
        self.bot_user_id = None  # We'll store the bot's user ID here
        self.allowed_bot_ids = []

        # Run the coroutine to get allowed bot IDs
        asyncio.create_task(self._initialize_bot_user_id())
        asyncio.create_task(self._initialize_allowed_bot_ids())
        self._load_alert_channels()

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

    def _load_alert_channels(self):
        try:
            with open("alert_channels.json", "r") as f:
                self.alert_channels = set(json.load(f))
        except FileNotFoundError:
            self.alert_channels = set()

    def _save_alert_channels(self):
        with open("alert_channels.json", "w") as f:
            json.dump(list(self.alert_channels), f)

    async def update_alert_channels(self):
        try:
            response = await self.slack_app.client.users_conversations(
                user=self.bot_user_id, types="public_channel,private_channel"
            )
            for channel in response["channels"]:
                self.alert_channels.add(channel["id"])
            self._save_alert_channels()
        except Exception as e:
            pass
            # logger.error(f"Error updating alert channels: {e}")

    def _register_event_handlers(self):
        @self.slack_app.event("member_joined_channel")
        async def handle_member_joined(event, say):
            """Handle member_joined_channel event.

            We send the alert stats report when the Opslane bot joins a channel.
            """
            if event.get("user") == self.bot_user_id:
                channel_id = event.get("channel")
                if channel_id:
                    self.alert_channels.add(channel_id)
                    self._save_alert_channels()
                    await self.ingest_historical_data(channel_id)

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
            """Callback for message events to send alert reasoning to the user."""
            if "bot_id" in event and event["bot_id"] in self.allowed_bot_ids:
                monitor_id = event["metadata"]["event_payload"]["monitor_id"]
                alert_stats = get_alert_configuration_stats(monitor_id)
                prediction = await self.predictor.predict(event, alert_stats)

                alert_classification = (
                    "Actionable"
                    if prediction["score"] > settings.PREDICTION_CONFIDENCE_THRESHOLD
                    else "Potentially Noisy"
                )

                channel_id = event["channel"]
                thread_ts = event["ts"]

                # Format additional info for better readability
                additional_info = []
                for k, v in prediction["additional_info"].items():
                    if k == "slack_conversations":
                        conversation_links = []
                        for conv in v:
                            user = conv.get("user", "Unknown")
                            timestamp = conv.get("timestamp", "")
                            message = conv.get("message", "")
                            link = f"<slack://channel?team=T027FNUU9V2&id=C079ZECA30U&message={timestamp}|{user}: {message[:50]}...>"
                            conversation_links.append(link)
                        additional_info.append(
                            f"• *{k}:*\n  " + "\n  ".join(conversation_links)
                        )
                    else:
                        additional_info.append(f"• *{k}:* {v}")

                additional_info_text = "\n".join(additional_info)

                blocks = [
                    {
                        "type": "header",
                        "text": {
                            "type": "plain_text",
                            "text": f"Alert Classification: {alert_classification}",
                            "emoji": True,
                        },
                    },
                    {
                        "type": "section",
                        "text": {"type": "mrkdwn", "text": prediction["reasoning"]},
                    },
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": f"*Additional Information:*\n{additional_info_text}",
                        },
                    },
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": f"*Confidence Score:* {prediction['score']:.2f}",
                        },
                    },
                    {
                        "type": "actions",
                        "elements": [
                            {
                                "type": "button",
                                "text": {
                                    "type": "plain_text",
                                    "text": "👍",
                                    "emoji": True,
                                },
                                "value": alert_classification,
                                "action_id": "thumbs_up",
                                "style": "primary",
                            },
                            {
                                "type": "button",
                                "text": {
                                    "type": "plain_text",
                                    "text": "👎",
                                    "emoji": True,
                                },
                                "value": alert_classification,
                                "action_id": "thumbs_down",
                                "style": "danger",
                            },
                        ],
                    },
                    {
                        "type": "context",
                        "elements": [
                            {
                                "type": "mrkdwn",
                                "text": "Please provide feedback on the classification to help improve future predictions.",
                            }
                        ],
                    },
                ]

                await say(blocks=blocks, channel=channel_id, thread_ts=thread_ts)

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

        for alert in report_data["top_alerts"]:
            alert_id = (
                getattr(alert, "id", None) or md5(alert.title.encode()).hexdigest()
            )
            blocks.extend(
                [
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": f"*{alert.title}* ({alert.count} times)",
                        },
                        "accessory": {
                            "type": "button",
                            "text": {
                                "type": "plain_text",
                                "text": "Silence",
                                "emoji": True,
                            },
                            "value": f"silence_alert_{alert_id}",
                            "action_id": f"silence_alert_{alert_id}",
                        },
                    },
                    {"type": "divider"},
                ]
            )

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
            await ack()
            classification = body["actions"][0]["value"]

            await self.handle_feedback(
                body, say, is_positive=True, classification=classification
            )

        @self.slack_app.action("thumbs_down")
        async def handle_thumbs_down(ack, body, say):
            await ack()
            classification = body["actions"][0]["value"]
            await self.handle_feedback(
                body, say, is_positive=False, classification=classification
            )

        @self.slack_app.action(re.compile("silence_alert_.*"))
        async def handle_silence_alert(ack, body, say):
            await ack()
            alert_id = body["actions"][0]["value"].split("_")[-1]
            user_id = body["user"]["id"]
            channel_id = body["container"]["channel_id"]

            # Implement the logic to silence the alert
            success = await self.silence_alert(alert_id)

            if success:
                await self.slack_app.client.chat_postEphemeral(
                    channel=channel_id,
                    user=user_id,
                    text=f"Alert with ID {alert_id} has been silenced.",
                )
            else:
                await self.slack_app.client.chat_postEphemeral(
                    channel=channel_id,
                    user=user_id,
                    text=f"Failed to silence alert with ID {alert_id}. Please try again or contact support.",
                )

    async def handle_feedback(self, body, say, is_positive, classification):
        user_id = body["user"]["id"]
        channel_id = body["container"]["channel_id"]
        message_ts = body["container"]["message_ts"]

        try:
            result = await self.slack_app.client.conversations_history(
                channel=channel_id, latest=message_ts, limit=1, inclusive=True
            )
            parent_message = result["messages"][0]

            # Extract alert title, configuration ID, and prediction
            alert_title = parent_message["attachments"][0]["title"]
            title_link = parent_message["attachments"][0]["title_link"]

            # Parse out the alert configuration ID
            config_id = title_link.split("/monitors/")[1].split("?")[0]

            # Determine if the alert is noisy based on prediction and feedback
            is_noisy = (classification == "Actionable" and not is_positive) or (
                classification == "Potentially Noisy" and is_positive
            )

            # Update the database with the feedback
            await self.update_alert_metadata(
                config_id,
                is_noisy,
                f"User feedback: {'not noisy' if is_positive else 'noisy'}",
            )

            feedback_type = "positive" if is_positive else "negative"
            await self.slack_app.client.chat_postEphemeral(
                channel=channel_id,
                user=user_id,
                text=f"Thanks for the {feedback_type} feedback on the alert: '{alert_title}' (ID: {config_id}). The alert has been marked as {'noisy' if is_noisy else 'not noisy'}.",
            )

            # Update the original message to reflect the feedback
            updated_attachments = parent_message.get("attachments", [])
            updated_attachments.append(
                {
                    "color": "good" if is_positive else "danger",
                    "text": f"Feedback received: {'👍' if is_positive else '👎'} from <@{user_id}>. Alert marked as {'noisy' if is_noisy else 'not noisy'}.",
                }
            )

            await self.slack_app.client.chat_update(
                channel=channel_id, ts=message_ts, attachments=updated_attachments
            )

        except Exception as e:
            print(f"Error handling feedback: {e}")
            await self.slack_app.client.chat_postEphemeral(
                channel=channel_id,
                user=user_id,
                text=f"Sorry, there was an error processing your feedback. Please try again later.",
            )

    async def update_alert_metadata(self, config_id: str, is_noisy: bool, reason: str):
        """Mark an AlertConfiguration as noisy or not noisy and provide a reason."""
        try:
            updated_config = mark_alert_configuration_as_noisy(
                provider_id=config_id, is_noisy=is_noisy, reason=reason
            )
            print(f"Successfully updated metadata for alert configuration {config_id}")
        except Exception as e:
            print(f"Error updating alert metadata: {e}")
            # You might want to add more robust error handling here

    async def silence_alert(self, alert_id: str) -> bool:
        """Silence the alert with the given ID."""
        # Implement the logic to silence the alert
        # This might involve calling the Sentry API or updating your database
        # Return True if successful, False otherwise
        pass

    async def ingest_historical_data(self, channel_id: str, days_back: int = 30):
        end_time = datetime.now()
        start_time = end_time - timedelta(days=days_back)

        messages = await self.fetch_messages_from_channel(
            channel_id, start_time, end_time
        )

        for message in messages:
            if self.is_alert_message(message):
                await self.process_historical_alert(message, channel_id)

    async def fetch_messages_from_channel(
        self, channel_id: str, start_time: datetime, end_time: datetime
    ):
        messages = []
        cursor = None

        while True:
            try:
                result = await self.slack_app.client.conversations_history(
                    channel=channel_id,
                    cursor=cursor,
                    oldest=start_time.timestamp(),
                    latest=end_time.timestamp(),
                    limit=1000,
                )
                messages.extend(result["messages"])

                if not result["has_more"]:
                    break

                cursor = result["response_metadata"]["next_cursor"]
            except Exception as e:
                # logger.error(f"Error fetching messages: {e}")
                break

        return messages

    def is_alert_message(self, message: dict) -> bool:
        return message.get("bot_id") in self.allowed_bot_ids

    async def process_historical_alert(self, alert_message: dict, channel_id: str):
        thread_ts = alert_message.get("thread_ts") or alert_message.get("ts")
        thread_messages = await self.fetch_thread_messages(channel_id, thread_ts)
        is_actionable = self.analyze_thread_actionability(thread_messages)
        await self.store_alert_data(alert_message, thread_messages, is_actionable)

    async def fetch_thread_messages(self, channel_id: str, thread_ts: str):
        try:
            result = await self.slack_app.client.conversations_replies(
                channel=channel_id, ts=thread_ts
            )
            return result["messages"]
        except Exception as e:
            return []

    def analyze_thread_actionability(self, thread_messages: list) -> bool:
        return len(thread_messages) > 1

    async def store_alert_data(
        self, alert_message: dict, thread_messages: list, is_actionable: bool
    ):
        alert_text = alert_message.get("text", "")
        thread_texts = [msg.get("text", "") for msg in thread_messages[1:]]
        full_text = f"Alert: {alert_text}\n\nThread:\n" + "\n".join(thread_texts)

        metadata = {
            "timestamp": alert_message.get("ts"),
            "is_actionable": is_actionable,
            "thread_length": len(thread_messages),
            "channel": alert_message.get("channel"),
            "alert_sender": alert_message.get("user"),
            "thread_participants": list(
                set(msg.get("user") for msg in thread_messages)
            ),
        }

        self.vector_store.add_alert_with_thread(full_text, metadata)


# Initialize the SlackBot
slack_bot = SlackBot()
slack_handler = slack_bot.slack_handler
