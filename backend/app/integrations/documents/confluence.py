"""Module for loading, processing, and storing Confluence documents."""

from langchain.document_loaders import ConfluenceLoader
from langchain.text_splitter import CharacterTextSplitter
from langchain_postgres import PGVector
from langchain_openai import OpenAIEmbeddings

from app.core.config import settings

# PGVector settings
CONNECTION_STRING = "postgresql+psycopg://postgres:password@localhost:5432/postgres"
COLLECTION_NAME = "confluence_embeddings"


def load_confluence_documents():
    """Load documents from Confluence using specified credentials and settings."""
    confluence_loader = ConfluenceLoader(
        url=settings.CONFLUENCE_URL,
        username=settings.CONFLUENCE_USERNAME,
        api_key=settings.CONFLUENCE_API_KEY,
    )

    documents = confluence_loader.load(
        space_key=settings.CONFLUENCE_SPACE_KEY, include_attachments=False, limit=5
    )
    return documents


def split_documents(documents):
    """Split documents into smaller chunks using CharacterTextSplitter."""
    text_splitter = CharacterTextSplitter(chunk_size=1000, chunk_overlap=0)

    split_docs = text_splitter.split_documents(documents)
    return split_docs


def store_embeddings(documents):
    """Store document embeddings in PGVector using OpenAI embeddings."""
    embeddings = OpenAIEmbeddings(model="text-embedding-ada-002")

    vectorstore = PGVector(
        collection_name=COLLECTION_NAME,
        connection=CONNECTION_STRING,
        embeddings=embeddings,
        use_jsonb=True,
    )

    vectorstore.add_documents(documents)
    print(f"Added {len(documents)} documents to the vector store.")


def main():
    """Main function to orchestrate the document loading, splitting, and storing process."""
    print("Loading documents from Confluence...")
    confluence_docs = load_confluence_documents()
    print(f"Loaded {len(confluence_docs)} documents from Confluence.")

    print("Splitting documents...")
    split_docs = split_documents(confluence_docs)
    print(f"Split into {len(split_docs)} chunks.")

    print("Storing embeddings in PGVector...")
    store_embeddings(split_docs)

    print("Process completed successfully.")


if __name__ == "__main__":
    main()
