from playwright.sync_api import Page


class ApplicationTools:
    def __init__(self, page: Page) -> None:
        self.page = page

    def open_application(self, url: str) -> str:
        """Ouvre la page de candidature et renvoie son URL finale."""
        self.page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        return self.page.url

    