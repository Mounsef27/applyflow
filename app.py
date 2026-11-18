
from __future__ import annotations

from typing import Annotated, TypedDict

from langchain_core.messages import BaseMessage, SystemMessage
from langgraph.graph.message import add_messages
from langgraph.graph import END, START, StateGraph
import getpass
import os
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage
from dotenv import load_dotenv

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from fastapi import WebSocket, WebSocketDisconnect
import browser_bridge

from contextlib import asynccontextmanager
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from langchain_openai import ChatOpenAI

from applyflow.tool.inspect_page import inspect_page_tool
from applyflow.tool.fill_form import fill_form_tool
from langgraph.prebuilt import ToolNode, tools_condition
from applyflow.profile.candidate import load_candidate_profile

from applyflow.tool.click_element import click_element_tool
from applyflow.tool.select_option import select_option_tool
from applyflow.tool.fill_date import fill_date_tool
from applyflow.tool.verify_form import verify_form_tool

from langchain_ollama import ChatOllama
from langchain_groq import ChatGroq


candidate = load_candidate_profile()
load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
OPEN_ROUTER_API_KEY = os.getenv("OPEN_ROUTER_API_KEY")
if "GOOGLE_API_KEY" not in os.environ:
    os.environ["GOOGLE_API_KEY"] = getpass.getpass("Enter your Google AI API key: ")




llm = ChatGroq(
    model="openai/gpt-oss-120b",
    api_key=os.environ["GROQ_API_KEY"],
    temperature=0,
    max_retries=2,
)
tools = [inspect_page_tool,fill_form_tool,click_element_tool,select_option_tool,fill_date_tool,verify_form_tool]

llm_with_tools = llm.bind_tools(tools)

class ChatState(TypedDict):
    """State for the LangGraph conversation graph.

    Attributes:
        messages (list[BaseMessage]): The ordered message history.
    """

    messages: Annotated[list[BaseMessage], add_messages]



async def chat_node(state: ChatState):
    response = await llm_with_tools.ainvoke(
                            [
                                SystemMessage(content=f"""
                    You are ApplyFlow, an AI assistant specialized in job applications.

                    You can inspect web pages and fill application forms.

                    Candidate profile:
                    {candidate.model_dump_json(indent=2)}

                    Use the candidate profile when filling job application forms.
                    Only use information available in the profile or provided by the user.
                    Never invent missing information.
                    Never submit an application automatically.
                    """),
                                *state["messages"],
                            ]
                                        )

    return {"messages": [response]}



graph = StateGraph(ChatState)

graph.add_node("chat_node", chat_node)
graph.add_node("tools", ToolNode(tools))

graph.add_edge(START, "chat_node")

graph.add_conditional_edges(
    "chat_node",
    tools_condition
)

graph.add_edge("tools", "chat_node")

@asynccontextmanager
async def lifespan(app: FastAPI):
    database_url = os.environ["DATABASE_URL"]

    async with AsyncPostgresSaver.from_conn_string(
        database_url
    ) as checkpointer:

        await checkpointer.setup()

        app.state.workflow = graph.compile(
            checkpointer=checkpointer
        )

        print("PostgreSQL persistence initialized")

        yield

app = FastAPI(lifespan=lifespan)

@app.websocket("/ws/browser")
async def browser_websocket(websocket: WebSocket):
    await websocket.accept()
    browser_bridge.browser_socket = websocket

    try:
        while True:
            data = await websocket.receive_json()

            request_id = data.get("id")
            future = browser_bridge.pending_requests.get(request_id)

            if future is not None and not future.done():
                future.set_result(data)

    except WebSocketDisconnect:
        print("Browser disconnected")

    finally:
        if browser_bridge.browser_socket is websocket:
            browser_bridge.browser_socket = None

class ChatRequest(BaseModel):
    message: str
    thread_id: str


async def generate_response(message: str, thread_id: str):

    config = {
        "configurable": {
            "thread_id": thread_id
        }
    }

    async for chunk, metadata in app.state.workflow.astream(
        {
            "messages": [
                        SystemMessage(content="""
                            You are ApplyFlow, an AI assistant that helps users automate job applications.
                            You can inspect web pages and fill application forms using browser tools.
                            Never invent personal information or submit applications without confirmation.
                        """),
                        HumanMessage(content=message)
                        ]
        },
        config=config,
        stream_mode="messages",
    ):
        if metadata.get("langgraph_node") == "chat_node":
            text = chunk.text
            if text:
                yield text


@app.post("/chat")
async def chat(request: ChatRequest):
    return StreamingResponse(
        generate_response(
            request.message,
            request.thread_id
        ),
        media_type="text/plain; charset=utf-8",
        headers={
            "X-Content-Type-Options": "nosniff"
        },
    )