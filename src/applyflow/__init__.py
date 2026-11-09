from pathlib import Path
import tomllib

from dotenv import dotenv_values
from langchain_ollama import ChatOllama
from langgraph.errors import GraphRecursionError
from playwright.sync_api import sync_playwright

from .agent.agent import build_agent_graph
from .profile.candidate import CandidateProfile
from .tool.tool import ApplicationTools


def main() -> None:
    url = (
        "https://alliancewd.wd3.myworkdayjobs.com/en-US/renault-group-careers/"
        "job/Boulogne-Billancourt/"
        "CS27-Bac-5-Stage-Pricing-Analyst-H-F_JOBREQ_50274321/"
    )

    config = dotenv_values(".env")
    profile = CandidateProfile.model_validate(
        {
            "first_name": config.get("CANDIDATE_FIRST_NAME"),
            "last_name": config.get("CANDIDATE_LAST_NAME"),
            "email": config.get("CANDIDATE_EMAIL"),
            "phone": config.get("CANDIDATE_PHONE"),
            "linkedin_url": config.get("CANDIDATE_LINKEDIN_URL") or None,
            "github_url": config.get("CANDIDATE_GITHUB_URL") or None,
        }
    )

    with Path("pyproject.toml").open("rb") as file:
        settings = tomllib.load(file)["tool"]["applyflow"]

    model = ChatOllama(
        model=settings["ollama_model"],
        base_url=settings["ollama_base_url"],
        temperature=0,
    )

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=False)

        try:
            page = browser.new_page()
            tools = ApplicationTools(page)
            print(f"Offre ouverte : {tools.open_application(url)}")

            agent = build_agent_graph(model, tools, profile)

            try:
                result = agent.invoke({}, config={"recursion_limit": 40})
            except GraphRecursionError:
                print("L’agent a atteint sa limite d’étapes. Vérifie la page dans Chrome.")
            else:
                print(f"Décision finale : {result['decision'].message}")

            input("Appuie sur Entrée pour fermer Chrome.")
        finally:
            browser.close()