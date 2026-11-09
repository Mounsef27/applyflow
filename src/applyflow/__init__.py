from playwright.sync_api import sync_playwright

from .tool.tool import ApplicationTools


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            channel="chrome",
            headless=False,
            timeout=15_000,
        )

        try:
            page = browser.new_page()
            tools = ApplicationTools(page)

            final_url = tools.open_application("https://example.com")

            print(f"URL finale : {final_url}")
            print(f"Titre de la page : {page.title()}")
            input("Appuie sur Entrée pour fermer Chrome.")
        finally:
            browser.close()