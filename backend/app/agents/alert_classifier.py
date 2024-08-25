import json
from typing import Dict, Any
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_openai import ChatOpenAI
from langchain_core.runnables import RunnablePassthrough

from app.core.config import settings


class AlertClassifierRAG:
    """
    RAG system for summarizing alert classification results.
    """

    def __init__(self) -> None:
        """
        Initialize the AlertClassifierRAG with a prompt, LLM, and chain.
        """
        self.llm = ChatOpenAI(temperature=0, api_key=settings.LLM_API_KEY)

        self.prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    """
                    Analyze this alert classification result and create a concise human-readable sentence explaining the classifier output.

                    The alert classification schema includes the field "is_actionable" which is a boolean, the "confidence_score" along with the features.
                    """,
                ),
                (
                    "human",
                    "Classification Result:\n{classifier_result}\n\nPlease provide a summary that explains:\n1. Whether the alert is considered actionable or not\n2. The confidence level of the classification\n3. The main factors contributing to this classification\n\nSummary:",
                ),
            ]
        )

        self.parser = StrOutputParser()

        self.chain = (
            RunnablePassthrough.assign(
                classifier_result=lambda x: json.dumps(x, indent=2)
            )
            | self.prompt
            | self.llm
            | self.parser
        )

    def run(self, query: Dict[str, Any]) -> str:
        """
        Generate a summary of the alert classification result.

        Args:
            query (Dict[str, Any]): The classification result dictionary.

        Returns:
            str: A human-readable summary of the classification result.
        """
        return self.chain.invoke(query)


# Create a single instance of the RAG to be used throughout the application
alert_classifier_rag = AlertClassifierRAG()
