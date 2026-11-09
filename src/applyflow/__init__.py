from playwright.sync_api import sync_playwright

from .profile.candidate import CandidateProfile
from .tool.tool import ApplicationTools

def main() -> None:
    profile = CandidateProfile(
        first_name="Camille",
        last_name="Martin",
        email="camille.martin@example.com",
        phone="+33 6 00 00 00 00",
    )

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
                            channel="chrome",
                            headless=False,
                            timeout=15_000,
                        )
        try:
            page = browser.new_page()
            page.set_content(
                """
                <h1>ApplyFlow — formulaire de test</h1>
                <form>
                    <p><label>Prénom <input></label></p>
                    <p><label>Nom <input></label></p>
                    <p><label>E-mail <input type="email"></label></p>
                    <p><label>Téléphone <input type="tel"></label></p>
                </form>
                """
            )

            values = {
                "Prénom": profile.first_name,
                "Nom": profile.last_name,
                "E-mail": profile.email,
                "Téléphone": profile.phone,
            }

            for label, value in values.items():
                field = page.get_by_label(label, exact=True)
                field.fill(value)
                actual = field.input_value()
                if actual != value:
                    raise RuntimeError(
                        f"{label} — attendu {value!r}, obtenu {actual!r}"
                    )
                print(f"{label} ✓")

            print("OK — les quatre champs ont été vérifiés.")
            input("Appuyez sur Entrée pour fermer le navigateur…")
        finally:
            browser.close()