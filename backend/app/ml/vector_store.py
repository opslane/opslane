"""
Vector Store Module
"""

from typing import List, Dict, Any, Tuple

from langchain.docstore.document import Document
from langchain.schema import Document
from langchain_openai import OpenAIEmbeddings
from langchain_postgres import PGVector
from sqlmodel import Session

from app.core.config import settings
from app.db import engine


class VectorStore:
    """A class to manage vector storage and similarity search operations."""

    def __init__(self):
        """
        Initialize the VectorStore with a PGVector instance.

        The PGVector is configured with the database engine and a collection name for alert embeddings.
        """
        self.store = PGVector(
            connection=str(settings.DATABASE_URL),
            embeddings=OpenAIEmbeddings(openai_api_key=settings.LLM_API_KEY),
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

    def add_alert_with_thread(self, full_text: str, metadata: dict):
        """Add an alert and its thread to the vector store."""
        self.store.add_texts([full_text], metadatas=[metadata])

    def search_similar_alerts(
        self, query: str, k: int = 5, filter: Dict[str, Any] = None
    ) -> List[Tuple[Document, float]]:
        """Search for similar alerts in the vector store."""
        results = self.store.similarity_search_with_score(query, k=k, filter=filter)
        return [
            (Document(page_content=doc.page_content, metadata=doc.metadata), score)
            for doc, score in results
        ]

    def message_exists(self, message_id: str) -> bool:
        """Check if a message already exists in the vector store."""
        results = self.store.similarity_search(f"message_id:{message_id}", k=1)
        return len(results) > 0

    def add_document(self, text: str, metadata: Dict[str, Any], source: str):
        document = Document(page_content=text, metadata={**metadata, "source": source})
        self.store.add_documents([document])

    def similarity_search_with_score(
        self, query: str, k: int = 5, filter: Dict[str, Any] = None
    ) -> List[Tuple[Document, float]]:
        """Search for similar documents and return with relevance scores."""
        return self.store.similarity_search_with_score(query, k=k, filter=filter)
