"""Module for performing Root Cause Analysis on incidents."""

from typing import List, Dict, Any

from langchain.memory import ConversationBufferMemory
from langchain_core.pydantic_v1 import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate

from app.agents.base import BaseAgent


class CodeChange(BaseModel):
    """Represents a code change in a commit."""

    commit_hash: str = Field(description="The hash of the commit")
    author: str = Field(description="The author of the commit")
    title: str = Field(description="The title or message of the commit")
    link: str = Field(description="Link to the commit on GitHub")


class Issue(BaseModel):
    """Represents an issue found in log lines."""

    summary: str = Field(description="Summary of the log line indicating an issue")
    log_link: str = Field(description="Link to the specific log line in Datadog")


class RCAOutput(BaseModel):
    """Represents the output of a Root Cause Analysis."""

    summary: str = Field(description="Summary of the incident")
    issues: List[Issue] = Field(
        description="Potential issues found in the log lines, with summaries and links"
    )
    code_changes: List[CodeChange] = Field(
        description="Suspicious code changes based on the alert description and errors in the logs"
    )
    remediation: List[str] = Field(
        description="Recommended remediation steps based on the RCA analysis"
    )


class RCAAgent(BaseAgent):
    """Agent for performing Root Cause Analysis on incidents."""

    def __init__(self):
        """Initialize the RCAAgent with a conversation memory and a specific prompt template."""
        self.memory = ConversationBufferMemory()
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    """
                <instructions>
                You are an AI oncall copilot tasked with performing root cause analysis for an incident.
                Analyze the provided information and provide:
                1. A summary of the incident
                2. Potential issues found in the log lines. Choose 1-2 log lines that indicate an issue and provide a link to the specific log line in Datadog.
                3. Any suspicious code changes based on the alert description and errors in the logs. Look at the patches in the code as well.
                4. Recommended remediation steps based on the RCA analysis if any.

                If you can't find anything suspicious, you can leave the fields empty. In the remediation steps, say you couldn't find the root cause.

                Keep your answers concise.

                <IMPORTANT>
                Ensure that the output is always valid JSON.
                - Do not mumble or include any additional commentary.
                - Do not apologize or give irrelevant information.
                - Do not talk about the format of the output.
                - Do not say 'Here is my analysis' or similar phrases.
                </IMPORTANT>
                </instructions>
                """,
                ),
                (
                    "human",
                    "Alert Description: {alert_description}\n\nLog Lines:\n{log_lines}\n\nRecent Code Changes:\n{code_changes}",
                ),
            ]
        )
        super().__init__(RCAOutput, prompt)

    def run(
        self, alert_description: str, log_lines: str, code_changes: str
    ) -> Dict[str, Any]:
        """
        Perform Root Cause Analysis based on the provided information.

        Args:
            alert_description (str): Description of the alert.
            log_lines (str): Relevant log lines from the incident.
            code_changes (str): Recent code changes that might be related to the incident.

        Returns:
            Dict[str, Any]: A dictionary containing the RCA results, including summary, issues, code changes, and remediation steps.
        """

        input_data = {
            "alert_description": alert_description,
            "log_lines": log_lines,
            "code_changes": code_changes,
        }

        return self.run_chain(input_data)

        # Save context and output to memory
        self.memory.save_context(
            {"input": f"Alert: {alert_description}"}, {"output": str(result["parsed"])}
        )

        return result["parsed"]


rca_agent = RCAAgent()
