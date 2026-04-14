from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
import pytz
from database import get_setting
from news_fetcher import run_fetch_cycle
from daily_digest import generate_digest

scheduler = AsyncIOScheduler()


async def _run_digest():
    await generate_digest()


async def _run_fetch():
    await run_fetch_cycle()


async def reload_digest_schedule():
    tz_name = await get_setting("timezone") or "Asia/Dubai"
    try:
        tz = pytz.timezone(tz_name)
    except Exception:
        tz = pytz.timezone("Asia/Dubai")

    for slot, key_time, key_enabled in [
        ("morning", "digest_morning_time", "digest_morning_enabled"),
        ("afternoon", "digest_afternoon_time", "digest_afternoon_enabled"),
    ]:
        job_id = f"digest_{slot}"
        if scheduler.get_job(job_id):
            scheduler.remove_job(job_id)

        time_str = await get_setting(key_time) or ("08:00" if slot == "morning" else "17:00")
        enabled = (await get_setting(key_enabled) or "true").lower() == "true"

        if enabled:
            try:
                hour, minute = map(int, time_str.split(":"))
            except ValueError:
                continue
            scheduler.add_job(
                _run_digest,
                CronTrigger(hour=hour, minute=minute, timezone=tz),
                id=job_id,
                replace_existing=True,
            )


async def reload_fetch_schedule():
    interval = int(await get_setting("fetch_interval_seconds") or "60")
    interval = max(30, interval)  # minimum 30s — prevents overlap on slow hardware
    job_id = "news_fetch"
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
    scheduler.add_job(
        _run_fetch,
        IntervalTrigger(seconds=interval),
        id=job_id,
        replace_existing=True,
        coalesce=True,           # if a run was missed, only fire once on catch-up
        max_instances=1,         # never run two fetches simultaneously
        misfire_grace_time=30,   # if a run fires late by under 30s, still execute it
    )


async def start_scheduler():
    if not scheduler.running:
        scheduler.start()
    await reload_digest_schedule()
    await reload_fetch_schedule()
