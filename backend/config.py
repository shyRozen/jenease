from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    jenkins_url: str
    destroy_jenkins_url: str = ""  # if set, destroy jobs are sent here instead of jenkins_url
    secret_key: str
    session_max_age: int = 30 * 24 * 3600  # 30 days

    class Config:
        env_file = ".env"


settings = Settings()
