"""Module for runbook analysis and automation agents."""

from typing import Any, Dict, Optional

from langchain_core.prompts import ChatPromptTemplate
from langchain_core.pydantic_v1 import BaseModel, Field

from app.agents.base import BaseAgent
from app.tools.status_page import get_status_page_content


class RunbookAnalyzerOutput(BaseModel):
    """Output schema for runbook analyzer."""

    external_service_name: Optional[str] = Field(
        description="Name of the external service if any"
    )


class RunbookAnalyzerAgent(BaseAgent):
    def __init__(self):
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    """
                    Your an oncall engineer and you have received an oncall runbook as part of the investigation process.

                    Based on the runbook, you need to determine whether an external service is experiencing issues.

                    Return the name of the external service if it is mentioned in the runbook.

                    An external service is a well known third party service. Examples are AWS, GCP, Azure, Datadog, etc.

                    If you don't recognize any external service, return an empty string.

                    Example:
                    Runbook: "Check the status of backend server"
                    Response: "" (since the external service is not mentioned in the runbook)

                    Runbook: "Check the status of AWS S3 bucket"
                    Response: "AWS S3"
                    </instructions>
                    """,
                ),
                (
                    "human",
                    "Runbook Document:\n{runbook_content}\n\n",
                ),
            ]
        )
        super().__init__(RunbookAnalyzerOutput, prompt, tools)

    def run(self, runbook_content: str) -> Dict[str, Any]:
        return self.run_chain(
            {
                "runbook_content": runbook_content,
            }
        )


class RunbookAutomationOutput(BaseModel):
    """Output schema for automated runbook execution."""

    status_page_summary: str = Field(description="Summary of the status page content")
    generated_code: str = Field(
        description="Generated Python script to automate runbook"
    )


class RunbookAutomationAgent(BaseAgent):
    def __init__(self):
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    """
                    <instructions>
                    You are an oncall engineer who is automating steps in a runbook in response to an oncall alert.
                    Your task is to work through each step in the runbook.

                    Generate a Python script that automates the steps in the runbook.

                    If you don't know how to automate a step, leave it out of the script.

                    If you don't have access to the unique identifiers required for a detail endpoint, leverage the list endpoints
                    and use the provided names in the runbook.

                    The API Spec is provided as a JSON string. Use the API Spec to generate the Python script.

                    <important>
                    The output should be valid Python Code.
                    Use the API endpoint that matches the runbook step the best. For example, if the runbook says Redis instance, first check
                    if there is a Redis instance endpoint. If not, use the best matching endpoint.
                    Don't include any comments or explanations in the code.
                    Don't format it in Markdown or any other format.
                    Don't ask for user input.
                    Use the 'requests' library for HTTP requests.
                    The script should include necessary imports, error handling, and return the response as a JSON object
                    Use try/except blocks for error handling. You should always use the get function for accessing fields. Assume
                    a field won't exist.
                    Don't print the response or any other output. Anything relevant should be returned as a JSON object.

                    The script should have a function named 'automate_runbook' that takes the API key as an argument.
                    </important>
                    </instructions>
                    """,
                ),
                (
                    "human",
                    "Runbook Document:\n{runbook_content}\n\n API Spec:\n\n{api_spec}",
                ),
            ]
        )
        super().__init__(RunbookAutomationOutput, prompt, tools)
        self.tool_names = [tool.name for tool in tools]

    def run(self, runbook_content: str, api_spec: str) -> Dict[str, Any]:
        return self.run_chain(
            {
                "runbook_content": runbook_content,
                "api_spec": api_spec,
                "tool_names": ", ".join(self.tool_names),
            }
        )


tools = [get_status_page_content]

runbook_automation_agent = RunbookAutomationAgent()
runbook_analyzer_agent = RunbookAnalyzerAgent()
