from typing import Literal
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # --- LLM provider switch ---
    # Set to "claude" for demo, "openai" for dev/testing
    llm_provider: Literal["claude", "openai"] = "claude"

    # --- Claude (Anthropic) ---
    claude_api_key: str = ""
    claude_model: str = "claude-sonnet-4-6"

    # --- OpenAI-compatible (gpt-oss-120b or any OpenAI SDK endpoint) ---
    openai_api_key: str = ""
    openai_model: str = "gpt-oss-120b"
    openai_base_url: str = "https://api.openai.com/v1"  # override for custom endpoints

    # --- Server ---
    cors_origins: list[str] = ["*"]
    host: str = "0.0.0.0"
    port: int = 8000


settings = Settings()
