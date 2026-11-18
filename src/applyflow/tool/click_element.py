
from typing import Annotated

from langchain_core.tools import tool

from applyflow.tool.browser_request import send_browser_command


async def click_element(
    selector: Annotated[
        str,
        "CSS selector of the element to click, obtained from inspect_page."
    ],
) -> dict:
    """
    Click a non-submission element on the current browser page.

    Use this tool to navigate application steps or open dynamic
    sections such as Add Education or Add Experience.

    Inspect the page first to obtain a reliable CSS selector.
    Never use this tool to submit an application.
    """
    return await send_browser_command(
        tool_name="click_element",
        args={"selector": selector},
    )


click_element_tool = tool(click_element)
