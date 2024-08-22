"""Implements a vector store using PostgreSQL with pgvector extension."""

from typing import List, Dict, Any, Tuple, Union
from langchain_community.embeddings import OpenAIEmbeddings
from langchain_postgres import PGVector
from app.core.config import settings
from app.vector_store.base import BaseVectorStore
from app.db.models import Document


class PGVectorStore(BaseVectorStore):
    def __init__(self):
        """Initialize PGVectorStore with PostgreSQL connection and OpenAI embeddings."""
        self.store = PGVector(
            connection=str(settings.DATABASE_URL),
            embeddings=OpenAIEmbeddings(openai_api_key=settings.LLM_API_KEY),
            collection_name="alert_embeddings",
        )

    def add_documents(self, documents: Union[Document, List[Document]]) -> None:
        """
        Add documents to the vector store.

        Args:
            documents: Single Document or list of Documents to add.
        """
        if isinstance(documents, Document):
            documents = [documents]

        texts = [doc.content for doc in documents]
        metadatas = [doc.doc_metadata for doc in documents]
        self.store.add_texts(texts, metadatas)

    def similarity_search(
        self, query: str, k: int = 5, filter: Dict[str, Any] = None
    ) -> List[Tuple[Document, float]]:
        """
        Perform similarity search on the vector store.

        Args:
            query: Search query string.
            k: Number of results to return.
            filter: Optional metadata filter.

        Returns:
            List of tuples containing matching Documents and their similarity scores.
        """
        results = self.store.similarity_search_with_score(query, k=k, filter=filter)
        return [
            (Document(content=doc.page_content, metadata=doc.metadata), score)
            for doc, score in results
        ]

    def document_exists(self, document_id: str) -> bool:
        """
        Check if a document exists in the vector store.

        Args:
            document_id: ID of the document to check.

        Returns:
            True if the document exists, False otherwise.
        """
        results = self.store.similarity_search(f"id:{document_id}", k=1)
        return len(results) > 0
