
from datetime import date
from typing import Annotated

from langchain_core.tools import tool

from applyflow.tool.browser_request import send_browser_command


async def fill_date(
    selector: Annotated[
        str,
        "CSS selector of the date field."
    ],
    date_value: Annotated[
        date,
        "Date to enter in YYYY-MM-DD format."
    ],
) -> dict:
    """
    Fill a date field on the current browser page.

    Use the date explicitly provided by the user or available
    in the verified candidate profile.

    Inspect the page first to identify the date control.
    Never invent dates or submit the form.
    """
    return await send_browser_command(
        tool_name="fill_date",
        args={
            "selector": selector,
            "date": date_value.isoformat(),
        },
    )


fill_date_tool = tool(fill_date)
