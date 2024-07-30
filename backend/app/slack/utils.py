"""Utility functions for Slack bot operations."""

import json
from typing import List, Set
from slack_sdk.errors import SlackApiError


def load_alert_channels() -> Set[str]:
    try:
        with open("alert_channels.json", "r") as f:
            return set(json.load(f))
    except FileNotFoundError:
        return set()


def save_alert_channels(alert_channels: Set[str]):
    with open("alert_channels.json", "w") as f:
        json.dump(list(alert_channels), f)


async def get_allowed_bot_ids(slack_app) -> List[str]:
    allowed_bot_ids = []
    allowed_app_names = ["Datadog", "Sentry"]
    cursor = None

    try:
        while True:
            response = await slack_app.client.users_list(limit=200, cursor=cursor)
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


def is_alert_message(message: dict, allowed_bot_ids: List[str]) -> bool:
    return message.get("bot_id") in allowed_bot_ids


async def process_historical_alert(bot, alert_message: dict, channel_id: str):
    # Implementation of process_historical_alert
    pass
