"""Defines the abstract base class for vector store implementations."""

from abc import ABC, abstractmethod
from typing import List, Dict, Any, Tuple, Union

from app.db.models import Document


class BaseVectorStore(ABC):
    @abstractmethod
    def add_documents(self, documents: Union[Document, List[Document]]) -> None:
        """
        Add one or more documents to the vector store.

        Args:
            documents (Union[Document, List[Document]]): A single Document or a list of Documents to add.
        """
        pass

    @abstractmethod
    def similarity_search(
        self, query: str, k: int = 5, filter: Dict[str, Any] = None
    ) -> List[Tuple[Document, float]]:
        """
        Perform a similarity search and return documents with their scores.

        Args:
            query (str): The query text to search for.
            k (int): The number of results to return.
            filter (Dict[str, Any], optional): Metadata filters to apply to the search.

        Returns:
            List[Tuple[Document, float]]: A list of tuples containing the matching documents and their similarity scores.
        """
        pass

    @abstractmethod
    def document_exists(self, document_id: str) -> bool:
        """
        Check if a document with the given ID exists in the vector store.

        Args:
            document_id (str): The ID of the document to check.

        Returns:
            bool: True if the document exists, False otherwise.
        """
        pass
