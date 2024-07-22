"""
Vector Store Module
"""

from typing import List, Dict, Any

from langchain.embeddings import OpenAIEmbeddings
from langchain.schema import Document
from langchain.vectorstores import PGVector

from app.core.config import settings


class VectorStore:
    """A class to manage vector storage and similarity search operations."""

    def __init__(self):
        """
        Initialize the VectorStore with a PGVector instance.

        The PGVector is configured with the database engine and a collection name for alert embeddings.
        """
        self.store = PGVector(
            connection_string=str(settings.DATABASE_URL_NEW),
            embedding_function=OpenAIEmbeddings(openai_api_key=settings.LLM_API_KEY),
            collection_name="alert_embeddings",
        )

    def add_texts(self, texts: List[str], metadatas: List[Dict[str, Any]]) -> None:
        """
        Add texts and their associated metadata to the vector store.

        Args:
            texts (List[str]): A list of text strings to be added to the vector store.
            metadatas (List[Dict[str, Any]]): A list of metadata dictionaries corresponding to each text.
        """
        self.store.add_texts(texts, metadatas)

    def similarity_search(self, query: str, k: int = 5) -> List[Document]:
        """
        Perform a similarity search on the vector store.

        Args:
            query (str): The query text to search for similar entries.
            k (int, optional): The number of similar entries to return. Defaults to 5.

        Returns:
            List[Document]: A list of the k most similar entries to the query.
        """
        return self.store.similarity_search(query, k=k)
