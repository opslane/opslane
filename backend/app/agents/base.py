"""Base agent class for all agents."""

from typing import Dict, Any, List
from langchain_core.prompts import ChatPromptTemplate
from langchain_anthropic import ChatAnthropic
from langfuse.callback import CallbackHandler
from langchain_core.pydantic_v1 import BaseModel

from app.core.config import settings


class BaseAgent:
    def __init__(
        self, output_schema: BaseModel, prompt: ChatPromptTemplate, tools: List = []
    ):
        """
        Initialize the BaseAgent.

        Args:
            output_schema (BaseModel): The Pydantic model for structured output.
            prompt (ChatPromptTemplate): The prompt template for the agent.
            tools (List, optional): List of tools available to the agent. Defaults to [].
        """

        if settings.IS_LANGFUSE_ENABLED:
            self.langfuse_handler = CallbackHandler(
                public_key=settings.LANGFUSE_PUBLIC_KEY,
                secret_key=settings.LANGFUSE_SECRET_KEY,
                host=settings.LANGFUSE_HOST,
            )

        llm = ChatAnthropic(
            api_key=settings.ANTHROPIC_API_KEY,
            model="claude-3-5-sonnet-20240620",
            default_headers={"anthropic-beta": "tools-2024-04-04"},
        )

        if len(tools) > 0:
            llm_with_tools = llm.bind_tools(tools)
            self.structured_llm = llm_with_tools.with_structured_output(
                output_schema, include_raw=True
            )
        else:
            self.structured_llm = llm.with_structured_output(
                output_schema, include_raw=True
            )

        self.prompt = prompt

        chain = self.prompt | self.structured_llm | self.check_output
        fallback_chain = self.insert_errors | chain
        self.chain_with_retry = chain.with_fallbacks(
            fallbacks=[fallback_chain] * 3, exception_key="error"
        )

    def check_output(self, tool_output):
        """
        Check the output of the tool for parsing errors.

        Args:
            tool_output (Dict): The output from the tool.

        Returns:
            Dict: The validated tool output.

        Raises:
            ValueError: If there's a parsing error or the tool wasn't invoked.
        """
        if tool_output["parsing_error"]:
            print("Parsing error!")
            raw_output = str(tool_output["raw"].content)
            error = tool_output["parsing_error"]
            raise ValueError(
                f"Error parsing your output! Be sure to invoke the tool. Output: {raw_output}. \n Parse error: {error}"
            )
        elif not tool_output["parsed"]:
            print("Failed to invoke tool!")
            raise ValueError(
                "You did not use the provided tool! Be sure to invoke the tool to structure the output."
            )
        return tool_output

    def insert_errors(self, inputs):
        """
        Insert error messages into the conversation for retry attempts.

        Args:
            inputs (Dict): The input dictionary containing error and messages.

        Returns:
            Dict: Updated input dictionary with error message appended.
        """
        error = inputs["error"]
        messages = inputs["messages"]
        messages.append(
            (
                "user",
                f"Retry. You are required to fix the parsing errors: {error}\n\nYou must provide a valid output.",
            )
        )
        return {"messages": messages}

    def run(self, *args, **kwargs) -> Dict[str, Any]:
        """
        Run the agent. This method should be implemented by subclasses.

        Raises:
            NotImplementedError: If the subclass does not implement this method.
        """
        raise NotImplementedError("Subclasses must implement run method")

    def run_chain(self, input_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Run the chain with retry logic and Langfuse logging if enabled.

        Args:
            input_data (Dict[str, Any]): The input data for the chain.

        Returns:
            Dict[str, Any]: The parsed result from the chain.
        """
        config = {}
        if settings.IS_LANGFUSE_ENABLED:
            config["callbacks"] = [self.langfuse_handler]

        result = self.chain_with_retry.invoke(input_data, config=config)
        return result["parsed"]
