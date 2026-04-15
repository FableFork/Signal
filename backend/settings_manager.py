import json
from database import (
    get_all_user_settings, set_user_setting, get_user_setting,
    get_system_setting, set_system_setting,
    get_all_user_ids,
    USER_SETTING_DEFAULTS, SYSTEM_DEFAULTS
)
from scheduler import reload_digest_schedule, reload_fetch_schedule

SENSITIVE_KEYS = {"anthropic_api_key"}
SCHEDULE_KEYS = {
    "digest_morning_time", "digest_afternoon_time",
    "digest_morning_enabled", "digest_afternoon_enabled", "timezone"
}
SYSTEM_KEYS = {"fetch_interval_seconds", "retention_days"}

DEFAULT_SOURCES = json.loads(USER_SETTING_DEFAULTS["sources"])


async def update_user_setting_safe(user_id: int, key: str, value: str):
    # Never overwrite a sensitive key with the masked placeholder value
    if key in SENSITIVE_KEYS and value in ("***", ""):
        return
    if key in SYSTEM_KEYS:
        await set_system_setting(key, value)
        if key == "fetch_interval_seconds":
            await reload_fetch_schedule()
    else:
        await set_user_setting(user_id, key, value)
        if key in SCHEDULE_KEYS:
            await reload_digest_schedule()


async def get_settings_safe(user_id: int) -> dict:
    """Return all user settings + system settings, masking sensitive values."""
    all_s = await get_all_user_settings(user_id)
    # Overlay system settings
    for key in SYSTEM_KEYS:
        val = await get_system_setting(key)
        all_s[key] = val if val is not None else SYSTEM_DEFAULTS.get(key, "")

    result = {}
    for k, v in all_s.items():
        if k in SENSITIVE_KEYS:
            result[k] = "***" if v else ""
        else:
            result[k] = v
    return result


async def get_user_sources(user_id: int) -> list:
    raw = await get_user_setting(user_id, "sources")
    if not raw:
        return DEFAULT_SOURCES
    try:
        parsed = json.loads(raw)
        return parsed if parsed else DEFAULT_SOURCES
    except Exception:
        return DEFAULT_SOURCES


async def save_user_sources(user_id: int, sources: list):
    if not sources:
        sources = DEFAULT_SOURCES
    await set_user_setting(user_id, "sources", json.dumps(sources))


async def get_all_enabled_sources() -> list:
    """Collect unique enabled sources across all users — used by the fetch engine."""
    user_ids = await get_all_user_ids()
    seen_urls = set()
    result = []
    for uid in user_ids:
        for s in await get_user_sources(uid):
            url = s.get("url", "")
            if s.get("enabled", True) and url and url not in seen_urls:
                seen_urls.add(url)
                result.append(s)
    return result
