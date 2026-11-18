
import asyncio
import uuid

import browser_bridge


async def send_browser_command(
    tool_name: str,
    args: dict,
    timeout: int = 20,
) -> dict:
    """Send a browser command and wait for the extension response."""

    if browser_bridge.browser_socket is None:
        return {
            "success": False,
            "error": "Browser extension is not connected.",
        }

    request_id = str(uuid.uuid4())

    loop = asyncio.get_running_loop()
    future = loop.create_future()

    browser_bridge.pending_requests[request_id] = future

    try:
        await browser_bridge.browser_socket.send_json({
            "id": request_id,
            "tool": tool_name,
            "args": args,
        })

        response = await asyncio.wait_for(
            future,
            timeout=timeout,
        )

        return response

    except asyncio.TimeoutError:
        return {
            "success": False,
            "error": f"Browser tool '{tool_name}' timed out.",
        }

    except Exception as error:
        return {
            "success": False,
            "error": str(error),
        }

    finally:
        browser_bridge.pending_requests.pop(
            request_id,
            None,
        )
