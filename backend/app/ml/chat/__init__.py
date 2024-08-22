from typing import List, Dict, Tuple

from langchain.chains import LLMChain
from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.schema import Document

from app.core.config import settings
from app.ml.vector_store import VectorStore

qa_system_prompt = """You are an assistant for question-answering tasks.
Use the following pieces of retrieved context to answer the question.
If you don't know the answer, just say that you don't know.
Use three sentences maximum and keep the answer concise.
Always include the source of your information in your answer.

{context}"""

qa_prompt = ChatPromptTemplate.from_messages(
    [
        ("system", qa_system_prompt),
        MessagesPlaceholder(variable_name="chat_history"),
        ("human", "{question}"),
    ]
)

vector_store = VectorStore()
llm = ChatOpenAI(
    model_name="gpt-4o", temperature=0, openai_api_key=settings.LLM_API_KEY
)


def format_docs(docs: List[Tuple[Document, float]]) -> str:
    """
    Format a list of documents and their relevance scores into a string.

    Args:
        docs (List[Tuple[Document, float]]): A list of tuples containing Document objects and their relevance scores.

    Returns:
        str: A formatted string containing the content, source, and relevance of each document.
    """
    return "\n\n".join(
        f"Content: {doc.page_content}\nSource: {doc.metadata.get('url', 'Unknown')}"
        for doc in docs
    )


def get_qa_chain():
    """
    Create and return a Language Model chain for question answering.

    Returns:
        LLMChain: An instance of LLMChain configured with the question answering prompt and language model.
    """
    return LLMChain(llm=llm, prompt=qa_prompt)


async def answer_question(question: str, chat_history: List[Dict[str, str]] = []):
    """
    Answer a given question using the configured language model and vector store.

    Args:
        question (str): The question to be answered.
        chat_history (List[Dict[str, str]], optional): A list of previous chat messages. Defaults to an empty list.

    Returns:
        str: The generated answer to the question.
    """
    docs = vector_store.similarity_search(question, k=3)
    context = format_docs(docs)

    qa_chain = get_qa_chain()
    response = await qa_chain.arun(
        question=question, chat_history=chat_history, context=context
    )

    return response
