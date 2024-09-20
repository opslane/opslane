from langchain_postgres import PGVector
from langchain_openai import OpenAIEmbeddings
from langchain.tools import tool
from pydantic import BaseModel, Field
import json
import ast

CONNECTION_STRING = "postgresql+psycopg://postgres:password@localhost:5432/postgres"
COLLECTION_NAME = "confluence_embeddings"
NUM_DOCS_TO_RETURN = 1
SIMILARITY_THRESHOLD = 0.25


@tool
def fetch_relevant_documents(alert_description: str) -> dict:
    """Fetch relevant documents from PGVector store based on the alert description.

    Args:
        input_data (str): A JSON string containing alert_description and optionally num_docs
    """

    # Initialize PGVector
    embeddings = OpenAIEmbeddings(model="text-embedding-ada-002")
    vectorstore = PGVector(
        collection_name=COLLECTION_NAME,
        connection=CONNECTION_STRING,
        embeddings=embeddings,
        use_jsonb=True,
    )

    docs = vectorstore.max_marginal_relevance_search(
        alert_description, k=NUM_DOCS_TO_RETURN
    )

    return {
        "title": docs[0].metadata["title"],
        "source": docs[0].metadata["source"],
        "content": docs[0].page_content,
    }
