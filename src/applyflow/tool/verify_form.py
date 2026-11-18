
from langchain_core.tools import tool

from applyflow.tool.browser_request import send_browser_command


async def verify_form() -> dict:
    """
    Inspect and verify the current application form.

    Check required fields, missing values, invalid controls,
    and visible validation errors.

    This tool is read-only and must never submit the form.
    """
    return await send_browser_command(
        tool_name="verify_form",
        args={},
    )


verify_form_tool = tool(verify_form)
