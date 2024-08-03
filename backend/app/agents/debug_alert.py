import json
from typing import List, Dict, Any

from langchain.agents import Tool, AgentExecutor, LLMSingleActionAgent
from langchain.prompts import PromptTemplate
from langchain.output_parsers import PydanticOutputParser
from langchain.memory import ConversationBufferMemory
from pydantic import BaseModel, Field

from app.agents.base import BaseAgent
from app.tools.alerts import debug_noisy_alert
from app.tools.github import get_git_changes


class DebugAlertOutput(BaseModel):
    debug_steps: List[str] = Field(..., description="List of steps to debug the alert")
    possible_causes: List[str] = Field(
        ..., description="List of possible causes for the alert"
    )
    recommended_actions: List[str] = Field(
        ..., description="List of recommended actions to resolve the alert"
    )


class DebugAlertAgent(BaseAgent):
    """
    Agent for debugging alerts and providing actionable insights.
    """

    def __init__(self) -> None:
        """
        Initialize the DebugAlertAgent with tools and prompt.
        """
        tools: List[Tool] = [
            Tool(
                name="debug_noisy_alert",
                func=debug_noisy_alert,
                description="Debug root cause of noisy alerts",
            ),
        ]

        output_parser = PydanticOutputParser(pydantic_object=DebugAlertOutput)
        self.format_instructions = output_parser.get_format_instructions()

        prompt = PromptTemplate(
            input_variables=[
                "alert_title",
                "alert_description",
                "alert_id",
                "classification",
                "input",
                "agent_scratchpad",
                "format_instructions",
            ],
            template="""Debug this alert and provide steps to investigate, possible causes, and recommended actions.

            {format_instructions}

            Use the tools provided to gather necessary information for debugging.
            Analyze the alert details and history to provide comprehensive debugging insights.

            Alert Title: {alert_title}
            Alert Description: {alert_description}
            Alert ID: {alert_id}
            Alert Classfication: {classification}
            Additional input: {input}

            {agent_scratchpad}

            When analyzing the alert, consider the recent code changes. For each relevant commit:
            1. Review the commit message and changed files.
            2. Examine the actual changes (patches) in each file.
            3. Determine if these changes could be related to the alert.
            4. If a change seems relevant, explain why and how it might have caused or contributed to the alert.

            Provide your final answer in the specified format, including:
            1. A list of debug steps to investigate the alert
            2. A list of possible causes for the alert, including any relevant recent code changes
            3. A list of recommended actions to resolve the alert
            4. An analysis of how recent code changes might be related to the alert (if applicable)

            IMPORTANT: Ensure that the output is valid JSON. Use "true" and "false" for boolean values.
            Focus on the most recent and relevant changes. If there are too many changes, prioritize those that seem most likely to be related to the alert.
            """,
        )

        super().__init__(tools, prompt)

    def run(self, query: Dict[str, Any]) -> Dict[str, Any]:
        input_variables = {
            "agent_scratchpad": "",
            "alert_title": query.get("alert_title", ""),
            "alert_description": query.get("alert_description", ""),
            "alert_id": query.get("alert_id", ""),
            "classification": query.get("classification", "noisy"),
            "input": query.get("input", ""),
            "format_instructions": self.format_instructions,
        }

        result = self.agent_executor.invoke(input_variables)

        try:
            output_parser = PydanticOutputParser(pydantic_object=DebugAlertOutput)
            parsed_output = output_parser.parse(result["output"])
            return parsed_output.dict()
        except json.JSONDecodeError as e:
            return {
                "error": f"Invalid JSON output: {str(e)}",
                "raw_output": result["output"],
            }
        except Exception as e:
            return {"error": f"Parsing error: {str(e)}", "raw_output": result["output"]}
