import asyncio
from fastapi import WebSocket

browser_socket: WebSocket | None = None

pending_requests: dict[str, asyncio.Future] = {}