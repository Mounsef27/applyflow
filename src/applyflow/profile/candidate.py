
import json
from pathlib import Path

from pydantic import BaseModel, Field, EmailStr


class Education(BaseModel):
    institution: str
    degree: str
    location: str
    period: str
    distinction: str | None = None


class Experience(BaseModel):
    company: str
    position: str
    period: str
    achievements: list[str]
    technologies: list[str]


class Project(BaseModel):
    name: str
    status: str | None = None
    description: list[str]
    technologies: list[str]


class CandidateProfile(BaseModel):
    first_name: str
    last_name: str
    headline: str

    email: EmailStr
    phone: str
    linkedin: str | None = None
    github: str | None = None

    education: list[Education] = Field(default_factory=list)
    experiences: list[Experience] = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)

    technical_skills: dict[str, list[str]] = Field(
        default_factory=dict
    )
    soft_skills: list[str] = Field(default_factory=list)
    languages: dict[str, str] = Field(default_factory=dict)


def load_candidate_profile() -> CandidateProfile:
    path = Path(__file__).with_name("candidate.json")

    with path.open(encoding="utf-8") as file:
        data = json.load(file)

    return CandidateProfile.model_validate(data)
