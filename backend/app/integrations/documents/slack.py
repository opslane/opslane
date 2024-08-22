"""
This module provides functionality to index Slack content into a vector store.
It includes utilities for fetching channels, messages, and threads from Slack,
as well as processing and storing this data.
"""

import re
from datetime import datetime, timezone
from typing import Any, Dict, Generator, Optional

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from app.core.config import settings
from app.db.models.document import Document, DocumentSource
from app.vector_store.pgvector import PGVectorStore

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
    first_message = thread[0].get("text", "")
    snippet = (first_message[:50] + "...") if len(first_message) > 50 else first_message

    return {
        "id": f"{channel_id}__{thread[0]['ts']}",
        "text": "\n".join([msg.get("text", "") for msg in thread]),
        "metadata": {
            "source": "slack",
            "workspace": workspace,
            "channel": channel["name"],
            "sender": initial_sender,
            "timestamp": get_latest_message_time(thread).isoformat(),
            "url": f"https://{workspace}.slack.com/archives/{channel_id}/p{thread[0]['ts'].replace('.', '')}",
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


class SlackIndexer:
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
        self.workspace = workspace
        self.channels = channels
        self.channel_regex_enabled = channel_regex_enabled
        self.client = WebClient(token=settings.SLACK_BOT_TOKEN)
        self.vector_store = PGVectorStore()

    def message_to_document(self, message: Dict[str, Any]) -> Document:
        """
        Convert a Slack message to a Document object.

        Args:
            message (Dict[str, Any]): The Slack message data.
            vector_store (PGVectorStore): The vector store for generating embeddings.

        Returns:
            Document: A Document object representing the Slack message.
        """
        channel_id, _ = message["id"].split("__")

        # Generate embedding
        embedding = self.vector_store.store.embeddings.embed_query(message["text"])

        # Create metadata
        metadata = {
            "channel_id": channel_id,
            "channel_name": message["metadata"]["channel"],
            "user_id": message["metadata"]["sender"],
            "user_name": "",  # This information is not provided in the current schema
            "timestamp": message["metadata"]["timestamp"],
            "thread_ts": None,  # This information is not provided in the current schema
            "is_thread_parent": False,  # This information is not provided in the current schema
            "is_in_thread": False,  # This information is not provided in the current schema
            "reactions": [],  # This information is not provided in the current schema
            "attachments": None,  # This information is not provided in the current schema
            "workspace": message["metadata"]["workspace"],
            "url": message["metadata"]["url"],
        }

        # Parse the timestamp
        created_at = datetime.fromisoformat(message["metadata"]["timestamp"])

        # Create Document object
        return Document(
            external_id=message["id"],
            source=DocumentSource.SLACK,
            title=f"Slack message in {metadata['channel_name']}",
            content=message["text"],
            doc_metadata=metadata,
            embedding=embedding,
            created_at=created_at,
            updated_at=created_at,
        )

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
                    thread_ts = message.get("thread_ts")
                    if thread_ts:
                        thread = get_thread(self.client, channel["id"], thread_ts)
                    else:
                        thread = [message]

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
