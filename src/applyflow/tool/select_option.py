
from typing import Annotated

from langchain_core.tools import tool

from applyflow.tool.browser_request import send_browser_command


async def select_option(
    selector: Annotated[
        str,
        "CSS selector of the dropdown or combobox."
    ],
    option: Annotated[
        str,
        "Exact option label or value to select."
    ],
) -> dict:
    """
    Select an option in a dropdown on the current browser page.

    Supports native selects and supported custom dropdowns through
    the Chrome extension.

    Inspect the page before selecting an option.
    Never guess an option that is not available.
    """
    return await send_browser_command(
        tool_name="select_option",
        args={
            "selector": selector,
            "option": option,
        },
    )


select_option_tool = tool(select_option)
