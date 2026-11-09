from playwright.sync_api import Page
from pathlib import Path
from urllib.parse import urljoin
class ApplicationTools:
    def __init__(self, page: Page) -> None:
        self.page = page

    def open_application(self, url: str) -> str:
        """Ouvre la page de candidature et renvoie son URL finale."""
        self.page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        return self.page.url
    
    def open_apply_link(self) -> str:
        """Suit le lien Apply depuis la page de l'offre."""
        apply_link = self.page.get_by_role("link", name="Apply", exact=True).first
        href = apply_link.get_attribute("href", timeout=10_000)

        if not href:
            raise ValueError("Le lien Apply ne contient aucune destination.")

        return self.open_application(urljoin(self.page.url, href))

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

    def select_option(self, label: str, option_label: str) -> None:
        """Sélectionne une option par son libellé dans une liste HTML native."""
        field = self.page.get_by_label(label, exact=True)
        field.select_option(label=option_label, timeout=5_000)

    def set_checkbox(self, label: str, checked: bool) -> None:
        """Coche ou décoche une case à partir de son libellé exact."""
        checkbox = self.page.get_by_role("checkbox", name=label, exact=True)
        checkbox.set_checked(checked, timeout=5_000)

    def select_radio(self, label: str, *, group: str | None = None) -> None:
        """Sélectionne un bouton radio par son libellé exact."""
        if group is None:
            radio = self.page.get_by_role("radio", name=label, exact=True)
        else:
            radio_group = self.page.get_by_role("group", name=group, exact=True)
            radio = radio_group.get_by_role("radio", name=label, exact=True)

        radio.check(timeout=5_000)

    def upload_document(self, label: str, file_path: str | Path) -> None:
        """Joint un fichier local au champ de téléversement indiqué."""
        path = Path(file_path).expanduser()

        if not path.is_file():
            raise FileNotFoundError(f"Fichier introuvable : {path}")

        field = self.page.get_by_label(label, exact=True)
        field.set_input_files(path, timeout=5_000)

    def go_to_next_step(self, button_label: str = "Suivant") -> None:
        """Clique sur un bouton de navigation vers l'étape suivante."""
        allowed_labels = {"Suivant", "Continuer", "Next", "Continue"}

        if button_label not in allowed_labels:
            raise ValueError(f"Libellé de navigation non autorisé : {button_label!r}")

        button = self.page.get_by_role("button", name=button_label, exact=True)
        button.click(timeout=5_000)

    def inspect_validation_errors(self) -> list[dict[str, str]]:
        """Renvoie les erreurs des champs visibles du formulaire."""
        fields = self.page.locator(
            "input:visible, textarea:visible, select:visible, "
            '[aria-invalid="true"]:visible'
        )

        return fields.evaluate_all(
            """
            elements => elements.flatMap(element => {
                const isInvalid = element.matches(":invalid")
                    || element.getAttribute("aria-invalid") === "true";

                if (!isInvalid) {
                    return [];
                }

                const label = Array.from(
                    element.labels ?? [],
                    label => label.textContent.trim()
                ).join(" ");

                const errorId = element.getAttribute("aria-errormessage");
                const errorElement = errorId
                    ? element.ownerDocument.getElementById(errorId)
                    : null;

                return [{
                    label: label
                        || element.getAttribute("aria-label")
                        || element.name
                        || "",
                    message: errorElement?.textContent.trim()
                        || element.validationMessage
                        || "Champ signalé comme invalide."
                }];
            })
            """
        )

    def inspect_review_page(self) -> str:
        """Lit le texte affiché sur la page récapitulative."""
        main_content = self.page.get_by_role("main")

        if main_content.count() == 1:
            return main_content.inner_text(timeout=5_000).strip()

        return self.page.locator("body").inner_text(timeout=5_000).strip()
    
    def submit_application(
        self,
        button_label: str = "Soumettre ma candidature",
        *,
        approved: bool,
    ) -> None:
        """Clique sur le bouton de soumission après validation humaine."""
        if not approved:
            raise PermissionError("La candidature doit être validée avant l'envoi.")

        button = self.page.get_by_role("button", name=button_label, exact=True)
        button.click(timeout=5_000)