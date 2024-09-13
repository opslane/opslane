"""Utility functions for Slack bot operations."""

from typing import List
from slack_sdk.errors import SlackApiError

from app.core.config import settings


async def get_allowed_bot_ids(slack_app) -> List[str]:
    """
    Retrieve the bot IDs of allowed Slack apps.

    This function iterates through the Slack workspace's user list and identifies
    bot users whose names match the allowed app names specified in the settings.

    Args:
        slack_app: The Slack app instance used to make API calls.

    Returns:
        List[str]: A list of bot IDs for the allowed Slack apps.

    Raises:
        SlackApiError: If there's an error while fetching the user list from Slack API.
    """
    allowed_bot_ids = []
    allowed_app_names = settings.ALLOWED_BOT_APPS
    cursor = None

    try:
        while True:
            # TODO: fix users limit
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
