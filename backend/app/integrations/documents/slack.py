"""
This module provides functionality to index Slack content into a vector store.
It includes utilities for fetching channels, messages, and threads from Slack,
as well as processing and storing this data.
"""

import re
from datetime import datetime, timezone
from typing import Any, Dict, Generator, List, Optional


from langchain.schema import Document as LangChainDocument
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from app.core.config import settings
from app.core.vector_store import VectorStore


ChannelType = dict[str, Any]
MessageType = dict[str, Any]
ThreadType = list[MessageType]


def get_channels(client: WebClient, exclude_archived: bool = True) -> list[ChannelType]:
    """
    Fetch a list of channels from Slack.

    Args:
        client (WebClient): The Slack WebClient instance.
        exclude_archived (bool): Whether to exclude archived channels. Defaults to True.

    Returns:
        list[ChannelType]: A list of channel dictionaries.
    """
    channels = []
    try:
        result = client.conversations_list(
            exclude_archived=exclude_archived, types="public_channel,private_channel"
        )
        channels.extend(result["channels"])
    except SlackApiError as e:
        print(f"Error fetching channels: {e}")
    return channels


def get_channel_messages(
    client: WebClient,
    channel: dict[str, Any],
    oldest: Optional[str] = None,
    latest: Optional[str] = None,
) -> Generator[list[MessageType], None, None]:
    """
    Fetch messages from a Slack channel.

    Args:
        client (WebClient): The Slack WebClient instance.
        channel (dict[str, Any]): The channel to fetch messages from.
        oldest (Optional[str]): The oldest message timestamp to include.
        latest (Optional[str]): The latest message timestamp to include.

    Yields:
        list[MessageType]: A list of message dictionaries.
    """
    try:
        result = client.conversations_history(
            channel=channel["id"], oldest=oldest, latest=latest
        )
        yield result["messages"]
    except SlackApiError as e:
        print(f"Error fetching messages for channel {channel['name']}: {e}")


def get_thread(client: WebClient, channel_id: str, thread_id: str) -> ThreadType:
    """
    Fetch a thread of messages from Slack.

    Args:
        client (WebClient): The Slack WebClient instance.
        channel_id (str): The ID of the channel containing the thread.
        thread_id (str): The ID of the thread.

    Returns:
        ThreadType: A list of message dictionaries in the thread.
    """
    try:
        result = client.conversations_replies(channel=channel_id, ts=thread_id)
        return result["messages"]
    except SlackApiError as e:
        print(f"Error fetching thread {thread_id}: {e}")
        return []


def get_latest_message_time(thread: ThreadType) -> datetime:
    """
    Get the timestamp of the latest message in a thread.

    Args:
        thread (ThreadType): A list of messages in a thread.

    Returns:
        datetime: The timestamp of the latest message.
    """
    max_ts = max([float(msg.get("ts", 0)) for msg in thread])
    return datetime.fromtimestamp(max_ts, tz=timezone.utc)


def thread_to_doc(workspace: str, channel: ChannelType, thread: ThreadType) -> dict:
    """
    Convert a Slack thread to a document format for indexing.

    Args:
        workspace (str): The Slack workspace name.
        channel (ChannelType): The channel containing the thread.
        thread (ThreadType): The thread to convert.

    Returns:
        dict: A document representation of the thread.
    """
    channel_id = channel["id"]
    initial_sender = thread[0].get("user", "Unknown")
    thread_ts = thread[0].get("ts", "")

    # Combine the initial message with all replies
    full_conversation = "\n".join(
        [f"[{msg.get('user', 'Unknown')}]: {msg.get('text', '')}" for msg in thread]
    )

    return {
        "id": f"{channel_id}__{thread_ts}",
        "text": full_conversation,
        "metadata": {
            "source": "slack",
            "workspace": workspace,
            "channel": channel["name"],
            "initial_sender": initial_sender,
            "timestamp": get_latest_message_time(thread).isoformat(),
            "url": f"https://{workspace}.slack.com/archives/{channel_id}/p{thread_ts.replace('.', '')}",
            "message_count": len(thread),
        },
    }


def filter_channels(
    all_channels: list[dict[str, Any]],
    channels_to_connect: Optional[list[str]],
    regex_enabled: bool,
) -> list[dict[str, Any]]:
    """
    Filter channels based on a list of channel names or regex patterns.

    Args:
        all_channels (list[dict[str, Any]]): All available channels.
        channels_to_connect (Optional[list[str]]): Channel names or regex patterns to filter by.
        regex_enabled (bool): Whether to use regex matching.

    Returns:
        list[dict[str, Any]]: Filtered list of channels.
    """
    if not channels_to_connect:
        return all_channels

    if regex_enabled:
        return [
            channel
            for channel in all_channels
            if any(
                re.fullmatch(channel_to_connect, channel["name"])
                for channel_to_connect in channels_to_connect
            )
        ]

    return [
        channel for channel in all_channels if channel["name"] in channels_to_connect
    ]


class SlackIndexer(VectorStore):
    """
    A class for indexing Slack content into a vector store.
    """

    def __init__(
        self,
        workspace: str,
        channels: Optional[list[str]] = None,
        channel_regex_enabled: bool = False,
    ):
        """
        Initialize the SlackIndexer.

        Args:
            workspace (str): The Slack workspace name.
            channels (Optional[list[str]]): List of channels to index.
            channel_regex_enabled (bool): Whether to use regex for channel matching.
        """
        super().__init__("slack_messages")
        self.workspace = workspace
        self.channels = channels
        self.channel_regex_enabled = channel_regex_enabled
        self.client = WebClient(token=settings.SLACK_BOT_TOKEN)

    def message_to_document(self, message: Dict[str, Any]) -> LangChainDocument:
        """
        Convert a Slack message to a LangChain Document object.

        Args:
            message (Dict[str, Any]): The Slack message data.

        Returns:
            LangChainDocument: A LangChain Document object representing the Slack message.
        """
        return LangChainDocument(
            page_content=message["text"], metadata=message["metadata"]
        )

    def get_thread_messages(self, channel_id: str, thread_ts: str) -> List[MessageType]:
        """
        Fetch all messages in a thread.

        Args:
            channel_id (str): The ID of the channel containing the thread.
            thread_ts (str): The timestamp of the thread's parent message.

        Returns:
            List[MessageType]: A list of all messages in the thread.
        """
        try:
            result = self.client.conversations_replies(channel=channel_id, ts=thread_ts)
            return result["messages"]
        except SlackApiError as e:
            print(f"Error fetching thread {thread_ts}: {e}")
            return []

    def index_slack_content(
        self, oldest: Optional[str] = None, latest: Optional[str] = None
    ):
        """
        Index Slack content into the vector store.

        Args:
            oldest (Optional[str]): The oldest message timestamp to include.
            latest (Optional[str]): The latest message timestamp to include.
        """
        all_channels = get_channels(self.client)
        filtered_channels = filter_channels(
            all_channels, self.channels, self.channel_regex_enabled
        )
        documents = []

        for channel in filtered_channels:
            channel_message_batches = get_channel_messages(
                self.client, channel, oldest, latest
            )

            for message_batch in channel_message_batches:
                for message in message_batch:
                    thread_ts = message.get("thread_ts") or message.get("ts")
                    thread = self.get_thread_messages(channel["id"], thread_ts)

                    doc = thread_to_doc(self.workspace, channel, thread)
                    documents.append(self.message_to_document(doc))

        self.vector_store.add_documents(documents)


def index_slack_content():
    """
    Create a SlackIndexer instance and index Slack content.
    """
    indexer = SlackIndexer(
        workspace=settings.SLACK_WORKSPACE,
        channels=settings.SLACK_CHANNELS,
        channel_regex_enabled=settings.SLACK_CHANNEL_REGEX_ENABLED,
    )
    indexer.index_slack_content()
