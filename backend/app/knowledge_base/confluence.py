"""
Module for integrating Confluence with the knowledge base.

This module provides functionality to process Confluence content,
embed it into a vector store, and perform similarity searches.
"""

from typing import List, Dict, Any
from atlassian import Confluence
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.embeddings import OpenAIEmbeddings
from bs4 import BeautifulSoup

from app.ml.vector_store import VectorStore
from app.core.config import settings
from .base import BaseKnowledgeBaseIntegrator


class ConfluenceIntegrator(BaseKnowledgeBaseIntegrator):
    """
    A class to integrate Confluence content into the knowledge base.
    """

    def __init__(self):
        """
        Initialize the ConfluenceIntegrator with necessary components.
        """
        self.confluence = Confluence(
            url=settings.CONFLUENCE_URL,
            username=settings.CONFLUENCE_USERNAME,
            password=settings.CONFLUENCE_PASSWORD,  # This should be an API token
        )
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000, chunk_overlap=200
        )
        self.embeddings = OpenAIEmbeddings(openai_api_key=settings.LLM_API_KEY)
        self.vector_store = VectorStore()

    def process_content(self) -> None:
        """
        Process all pages from a given Confluence space.

        Args:
            space_key (str): The key of the Confluence space to process.
        """
        space_key = settings.CONFLUENCE_SPACE_KEY
        pages = self.confluence.get_all_pages_from_space(space_key, start=0, limit=500)

        for page in pages:
            self._process_page(page["id"])

    def _process_page(self, page_id: str) -> None:
        """
        Process a single Confluence page.

        Args:
            page_id (str): The ID of the Confluence page to process.
        """
        page = self.confluence.get_page_by_id(page_id, expand="body.storage")
        content = page["body"]["storage"]["value"]

        soup = BeautifulSoup(content, "html.parser")
        text_content = soup.get_text()

        chunks = self.text_splitter.split_text(text_content)

        for chunk in chunks:
            self.vector_store.add_texts(
                [chunk],
                [{"source": "confluence", "page_id": page_id, "title": page["title"]}],
            )

    def search_knowledge_base(self, query: str, k: int = 5) -> List[Dict[str, Any]]:
        """
        Search the knowledge base for similar content.

        Args:
            query (str): The search query.
            k (int): The number of results to return. Defaults to 5.

        Returns:
            List[Dict[str, Any]]: A list of similar documents with their metadata.
        """
        results = self.vector_store.search_similar_alerts(
            query, k=k, filter={"source": "confluence"}
        )
        # Ensure we're returning a list of (doc, score) tuples
        return [(doc, score) for doc, score in results]
