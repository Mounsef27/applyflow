import asyncio
import uuid

from pydantic import BaseModel, Field
from langchain_core.tools import tool

import browser_bridge


class FormField(BaseModel):
    selector: str = Field(
        description="CSS selector identifying the form field"
    )
    value: str = Field(
        description="Value to enter into the form field"
    )


class FillFormInput(BaseModel):
    fields: list[FormField] = Field(
        description="List of form fields to fill"
    )


async def fill_form(fields: list[FormField]) -> dict:
    """
    Fill form fields on the current browser page using CSS selectors.

    Use this tool after inspect_page to identify the form fields.
    Fill only supported fields with information provided by the user.
    Never submit the form automatically.
    """

    if browser_bridge.browser_socket is None:
        return {
            "success": False,
            "error": "Browser extension is not connected."
        }

    request_id = str(uuid.uuid4())

    loop = asyncio.get_running_loop()
    future = loop.create_future()

    browser_bridge.pending_requests[request_id] = future

    try:
        await browser_bridge.browser_socket.send_json({
            "id": request_id,
            "tool": "fill_form",
            "args": {
                "fields": [
                    field.model_dump()
                    for field in fields
                ]
            }
        })

        response = await asyncio.wait_for(
            future,
            timeout=20
        )

        return response

    except asyncio.TimeoutError:
        return {
            "success": False,
            "error": "Browser extension did not respond in time."
        }

    except Exception as error:
        return {
            "success": False,
            "error": str(error)
        }

    finally:
        browser_bridge.pending_requests.pop(
            request_id,
            None
        )


fill_form_tool = tool(
    fill_form,
    args_schema=FillFormInput
)