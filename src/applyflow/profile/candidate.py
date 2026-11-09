import re

from pydantic import BaseModel, EmailStr, Field, HttpUrl, field_validator


class CandidateProfile(BaseModel):
    first_name: str = Field(min_length=1)
    last_name: str = Field(min_length=1)
    email: EmailStr
    phone: str
    linkedin_url: HttpUrl | None = None
    github_url: HttpUrl | None = None

    @field_validator("first_name", "last_name", mode="before")
    @classmethod
    def strip_name(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip()
        return value

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        value = value.strip()
        normalized = re.sub(r"[\s().-]", "", value)

        if not re.fullmatch(r"\+?[0-9]{7,15}", normalized):
            raise ValueError("Le téléphone doit contenir entre 7 et 15 chiffres.")

        return value

    @field_validator("linkedin_url")
    @classmethod
    def validate_linkedin_url(cls, value: HttpUrl | None) -> HttpUrl | None:
        if value is None:
            return None

        path = (value.path or "").strip("/").split("/")
        if (
            value.host not in {"linkedin.com", "www.linkedin.com", "fr.linkedin.com"}
            or len(path) != 2
            or path[0] != "in"
            or not path[1]
        ):
            raise ValueError("Utilise un lien de profil LinkedIn de type /in/identifiant.")

        return value

    @field_validator("github_url")
    @classmethod
    def validate_github_url(cls, value: HttpUrl | None) -> HttpUrl | None:
        if value is None:
            return None

        username = (value.path or "").strip("/")
        if value.host not in {"github.com", "www.github.com"} or not re.fullmatch(
            r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", username
        ):
            raise ValueError("Utilise un lien de profil GitHub de type github.com/identifiant.")

        return value
