"""Module for interacting with Confluence knowledge base."""

from typing import Dict, Any
from langchain_core.pydantic_v1 import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate
from app.agents.base import BaseAgent


class ConfluenceKBOutput(BaseModel):
    """Output schema for Confluence knowledge base analysis."""

    is_relevant: bool = Field(
        description="If the document is relevant to the alert description"
    )
    summary: str = Field(description="Summary of the document")


class ConfluenceKBAgent(BaseAgent):
    """Agent for retrieving and analyzing relevant Confluence documents based on alert descriptions."""

    def __init__(self):
        """Initialize the ConfluenceKBAgent with a specific prompt template."""
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    """
                You are an AI assistant tasked with verifying the relevance of documents to a given alert description.

                Perform the following steps:
                1. Determine if this document is relevant to the alert.
                2. Provide a summary of the relevant parts of the document.

                <IMPORTANT>
                - Ensure that the output is always valid JSON.
                - Do not mumble or include any additional commentary.
                - Do not apologize or give irrelevant information.
                - Do not talk about the format of the output.
                - Do not say 'Here is my analysis' or similar phrases.
                </IMPORTANT>
                """,
                ),
                (
                    "human",
                    "Alert Description: {alert_description}\nDocument: {document}",
                ),
            ]
        )
        super().__init__(ConfluenceKBOutput, prompt)

    def run(self, alert_description: str, document: str) -> Dict[str, Any]:
        """
        Run the Confluence knowledge base analysis.

        Args:
            alert_description (str): The description of the alert.
            document (str): The Confluence document to analyze.

        Returns:
            Dict[str, Any]: A dictionary containing the analysis results.
        """
        result = self.chain_with_retry.invoke(
            {"alert_description": alert_description, "document": document},
            config={"callbacks": [self.langfuse_handler]},
        )
        return result["parsed"]


confluence_kb_agent = ConfluenceKBAgent()
