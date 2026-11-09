from playwright.sync_api import Page


class ApplicationTools:
    def __init__(self, page: Page) -> None:
        self.page = page

    def open_application(self, url: str) -> str:
        """Ouvre la page de candidature et renvoie son URL finale."""
        self.page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        return self.page.url

    def inspect_fields(self) -> list[dict[str, str | bool]]:
        """Renvoie le libellé, le type et le statut obligatoire des champs."""
        fields = self.page.locator(
            'input:visible:not([type="hidden"]):not([type="submit"])'
            ':not([type="button"]):not([type="reset"]):not([type="image"]), '
            'textarea:visible, select:visible'
        )

        return fields.evaluate_all( # javascript code . 
            """
            elements => elements.map(element => {
                const label = Array.from(
                    element.labels ?? [],
                    label => label.textContent.trim() 
                ).join(" ");

                return {
                    label: label || element.getAttribute("aria-label") || "",
                    type: element.type,
                    required: element.required
                        || element.getAttribute("aria-required") === "true"
                };
            })
            """
        )

    def fill_text(self, label: str, value: str) -> None:
        """Remplit un champ texte à partir de son libellé exact."""
        field = self.page.get_by_label(label, exact=True)
        field.fill(value, timeout=5_000)