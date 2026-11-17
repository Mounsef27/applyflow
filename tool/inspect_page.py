
"""Browser page inspection tool."""

from __future__ import annotations

import asyncio
from typing import Any
from uuid import uuid4

from langchain_core.tools import tool

import browser_bridge


async def inspect_page() -> dict[str, Any]:
    """Inspect the currently active browser webpage.

    Returns:
        dict: Structured webpage information including
        the title, URL, headings, content and forms.
    """
    if browser_bridge.browser_socket is None:
        return {"error": "Browser extension is not connected."}

    request_id = str(uuid4())
    loop = asyncio.get_running_loop()
    future = loop.create_future()

    browser_bridge.pending_requests[request_id] = future

    try:
        await browser_bridge.browser_socket.send_json({
            "id": request_id,
            "tool": "inspect_page",
        })

        response = await asyncio.wait_for(future, timeout=15)

        if not response.get("success"):
            return {
                "error": response.get(
                    "error", "Page inspection failed."
                )
            }

        return response.get("result", {})

    except asyncio.TimeoutError:
        return {"error": "Browser inspection timed out."}

    except (ConnectionError, RuntimeError) as error:
        return {"error": str(error)}

    finally:
        browser_bridge.pending_requests.pop(request_id, None)


inspect_page_tool = tool(inspect_page)
