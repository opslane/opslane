from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from app.core.config import settings

router = APIRouter()

# Initialize the Slack client
slack_client = WebClient(token=settings.SLACK_BOT_TOKEN)


class SlackFormData(BaseModel):
    api_app_id: str
    channel_id: str
    channel_name: str
    command: str
    is_enterprise_install: Optional[bool] = False
    response_url: str
    team_domain: str
    team_id: str
    text: Optional[str] = ""
    token: str
    trigger_id: str
    user_id: str
    user_name: str

    @classmethod
    async def as_form(cls, request: Request):
        form_data = await request.form()
        return cls(**form_data)


async def fetch_channel_messages(channel_id: str):
    messages = []
    try:
        result = slack_client.conversations_history(channel=channel_id)
        for message in result["messages"]:
            if message.get("user") == settings.DATADOG_BOT_SLACK_ID:
                messages.append(message)

                # Check if the message has replies
                if message.get("thread_ts"):
                    try:
                        # Fetch replies for this thread
                        replies = slack_client.conversations_replies(
                            channel=channel_id, ts=message["thread_ts"]
                        )
                        # Add replies to the message
                        message["replies"] = replies["messages"][
                            1:
                        ]  # Exclude the parent message
                    except SlackApiError as e:
                        print(f"Error fetching replies: {e}")

        # Handle pagination if there are more messages
        while result.get("has_more", False):
            result = slack_client.conversations_history(
                channel=channel_id, cursor=result["response_metadata"]["next_cursor"]
            )
            for message in result["messages"]:
                messages.append(message)

                # Check if the message has replies
                if message.get("thread_ts"):
                    try:
                        # Fetch replies for this thread
                        replies = slack_client.conversations_replies(
                            channel=channel_id, ts=message["thread_ts"]
                        )
                        # Add replies to the message
                        message["replies"] = replies["messages"][
                            1:
                        ]  # Exclude the parent message
                    except SlackApiError as e:
                        print(f"Error fetching replies: {e}")

    except SlackApiError as e:
        print(f"Error fetching messages: {e}")

    return messages


@router.post("/")
async def train_alerts(form_data: SlackFormData = Depends(SlackFormData.as_form)):
    print(
        f"Received command from {form_data.user_name} in channel {form_data.channel_name}"
    )

    # Fetch messages from the channel
    messages = await fetch_channel_messages(form_data.channel_id)

    # Process the messages (this is where you'd implement your training logic)
    print(f"Fetched {len(messages)} messages from {form_data.channel_name}")

    import json

    # Example: Print the text of the first 5 messages
    for message in messages[:5]:
        # print(f"Message: {message}")
        print(json.dumps(message, indent=2))
        if message.get("replies"):
            print("Replies:")
            for reply in message["replies"]:
                print(f" - {reply.get('text', 'No text')}")

    # Your training logic here
    # ...

    return JSONResponse(
        content={
            "message": f"Processed {len(messages)} messages from {form_data.channel_name}"
        }
    )
