import json
from typing import List, Dict, Any, Union

from langchain.agents import Tool
from langchain.prompts import PromptTemplate
from langchain.output_parsers import PydanticOutputParser
from pydantic import BaseModel, Field

from app.agents.base import BaseAgent
from app.tools.alerts import fetch_alert_stats


class AlertClassifierOutput(BaseModel):
    score: float = Field(
        ..., description="The actionability score (float between 0 and 1)"
    )
    reasoning: str = Field(
        ..., description="A concise sentence explaining the prediction"
    )
    additional_info: Dict[str, Any] = Field(
        ..., description="Additional information based on the score"
    )


class AlertClassifierAgent(BaseAgent):
    """
    Agent for classifying alerts based on their actionability.
    """

    def __init__(self) -> None:
        """
        Initialize the AlertClassifierAgent with tools and prompt.
        """
        tools: List[Tool] = [
            Tool(
                name="fetch_alert_stats",
                func=fetch_alert_stats,
                description="Get statistics for the current alert",
            ),
        ]

        output_parser = PydanticOutputParser(pydantic_object=AlertClassifierOutput)

        self.format_instructions = output_parser.get_format_instructions()

        prompt = PromptTemplate(
            input_variables=[
                "alert_title",
                "alert_description",
                "alert_id",
                "input",
                "agent_scratchpad",
                "format_instructions",
            ],
            template="""Analyze this alert and return a score between 0 and 1.
            0 denotes that the alert is not actionable (noisy), while 1 denotes that the alert is actionable.

            Use the tools provided to gather necessary information, then make your final decision.
            Once you have enough information, provide your final answer in the specified format.

            {format_instructions}

            Use the alert statistics to determine the actionability of the alert.
            Analyze alert history across various signals:

            1. Alert frequency
            2. How quickly the alerts have resolved in the past
            3. Alert priority

            Alert Title: {alert_title}
            Alert Description: {alert_description}
            Alert ID: {alert_id}
            Additional input: {input}

            {agent_scratchpad}

            Remember to use the tools to gather information before making your final decision.
            Once you have made your decision, respond with the final answer in the specified format.

            IMPORTANT: Ensure that the output is valid JSON. Use "true" and "false" for boolean values.
            """,
        )
        super().__init__(tools, prompt)

    def run(self, query: Dict[str, Any]) -> Dict[str, Any]:
        input_variables = {
            "agent_scratchpad": "",
            "alert_title": query.get("alert_title", ""),
            "alert_description": query.get("alert_description", ""),
            "alert_id": query.get("alert_id", ""),
            "input": query.get("input", ""),
            "format_instructions": self.format_instructions,
        }

        result = self.agent_executor.invoke(input_variables)

        try:
            output_parser = PydanticOutputParser(pydantic_object=AlertClassifierOutput)
            parsed_output = output_parser.parse(result["output"])
            return parsed_output.dict()
        except json.JSONDecodeError as e:
            return {
                "error": f"Invalid JSON output: {str(e)}",
                "raw_output": result["output"],
            }
        except Exception as e:
            return {"error": f"Parsing error: {str(e)}", "raw_output": result["output"]}
