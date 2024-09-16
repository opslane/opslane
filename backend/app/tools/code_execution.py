"""Module for executing dynamically generated code."""

import requests


def execute_generated_code(code: str, api_key: str):
    """
    Execute dynamically generated code with a provided API key.

    Args:
        code (str): The generated Python code to execute.
        api_key (str): The API key to be used in the code execution.

    Returns:
        The result of the automate_runbook function defined in the generated code.

    Raises:
        ValueError: If the generated code does not define a callable automate_runbook function.
    """
    # Create a namespace for the code to run in
    namespace = {
        "requests": requests,  # Allow access to the requests library
        "api_key": api_key,  # Pass in the API key
    }

    # Execute the code in the controlled namespace
    exec(code, namespace)

    # Check if the query_api function was defined
    if "automate_runbook" in namespace and callable(namespace["automate_runbook"]):
        # Call the function and return its result
        return namespace["automate_runbook"](api_key)
    else:
        raise ValueError(
            "The generated code did not define a callable automate_runbook function"
        )
