import json
from database import get_all_settings, set_setting, get_setting
from scheduler import reload_digest_schedule, reload_fetch_schedule


SENSITIVE_KEYS = {"anthropic_api_key"}
SCHEDULE_KEYS = {
    "digest_morning_time", "digest_afternoon_time",
    "digest_morning_enabled", "digest_afternoon_enabled", "timezone"
}
FETCH_KEYS = {"fetch_interval_seconds"}


async def update_setting(key: str, value: str):
    await set_setting(key, value)
    if key in SCHEDULE_KEYS:
        await reload_digest_schedule()
    if key in FETCH_KEYS:
        await reload_fetch_schedule()


async def get_settings_safe() -> dict:
    """Return all settings, masking sensitive values."""
    all_s = await get_all_settings()
    result = {}
    for k, v in all_s.items():
        if k in SENSITIVE_KEYS:
            result[k] = "***" if v else ""
        else:
            result[k] = v
    return result


async def get_sources() -> list:
    raw = await get_setting("sources")
    if not raw:
        return []
    try:
        return json.loads(raw)
    except Exception:
        return []


async def save_sources(sources: list):
    await set_setting("sources", json.dumps(sources))
