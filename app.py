
from __future__ import annotations

from typing import Annotated, TypedDict

from langchain_core.messages import BaseMessage
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

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

if "GOOGLE_API_KEY" not in os.environ:
    os.environ["GOOGLE_API_KEY"] = getpass.getpass("Enter your Google AI API key: ")




llm  = ChatGoogleGenerativeAI(
    model="gemini-3.1-flash-lite",
    google_api_key = GOOGLE_API_KEY

)


class ChatState(TypedDict):
    """State for the LangGraph conversation graph.

    Attributes:
        messages (list[BaseMessage]): The ordered message history.
    """

    messages: Annotated[list[BaseMessage], add_messages]



def chat_node(state: ChatState) -> dict[str, list[BaseMessage]]:
    response = llm.invoke(state["messages"])
    return {"messages": [response]}



graph = StateGraph(ChatState)
graph.add_node("chat_node", chat_node)
graph.add_edge(START,"chat_node")
graph.add_edge("chat_node",END)

workflow = graph.compile()










app = FastAPI()


class ChatRequest(BaseModel):
    message: str


def generate_response(message: str):
    for chunk, metadata in workflow.stream(
        {
            "messages": [
                HumanMessage(content=message)
            ]
        },
        stream_mode="messages",
    ):
        if metadata.get("langgraph_node") == "chat_node":
            text = chunk.text
            if text:
                yield text


@app.post("/chat")
def chat(request: ChatRequest):
    return StreamingResponse(
        generate_response(request.message),
        media_type="text/plain; charset=utf-8",
        headers={"X-Content-Type-Options": "nosniff"},
    )