"""Module for creating and configuring Milvus vector store instances."""

from langchain_milvus import Milvus
from langchain_openai import OpenAIEmbeddings
from pymilvus import connections

from app.core.config import settings


class MilvusBase:
    def __init__(self, collection_name: str):
        self.collection_name = collection_name
        self._connect_to_milvus()
        self.vector_store = self._get_vector_store()

    def _connect_to_milvus(self):
        connections.connect(
            "default", host=settings.MILVUS_HOST, port=settings.MILVUS_PORT
        )

    def _get_vector_store(self) -> Milvus:
        """
        Create and return a Milvus vector store instance.

        Returns:
            Milvus: A configured Milvus vector store instance.
        """

        return Milvus(
            collection_name=self.collection_name,
            embedding_function=OpenAIEmbeddings(openai_api_key=settings.LLM_API_KEY),
            connection_args={
                "host": settings.MILVUS_HOST,
                "port": settings.MILVUS_PORT,
            },
            auto_id=True,
        )

    def __del__(self):
        connections.disconnect("default")
