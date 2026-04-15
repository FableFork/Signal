from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
import pytz
from database import get_system_setting
from news_fetcher import run_fetch_cycle
from daily_digest import generate_digest

scheduler = AsyncIOScheduler()


async def _run_digest():
    await generate_digest()


async def _run_fetch():
    await run_fetch_cycle()


async def reload_digest_schedule():
    # Use system-level digest defaults (8am and 5pm Dubai time)
    tz = pytz.timezone("Asia/Dubai")
    for slot, hour, minute in [("morning", 8, 0), ("afternoon", 17, 0)]:
        job_id = f"digest_{slot}"
        if scheduler.get_job(job_id):
            scheduler.remove_job(job_id)
        scheduler.add_job(
            _run_digest,
            CronTrigger(hour=hour, minute=minute, timezone=tz),
            id=job_id,
            replace_existing=True,
        )


async def reload_fetch_schedule():
    interval = int(await get_system_setting("fetch_interval_seconds") or "60")
    interval = max(30, interval)
    job_id = "news_fetch"
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
    scheduler.add_job(
        _run_fetch,
        IntervalTrigger(seconds=interval),
        id=job_id,
        replace_existing=True,
        coalesce=True,
        max_instances=1,
        misfire_grace_time=30,
    )


async def start_scheduler():
    if not scheduler.running:
        scheduler.start()
    await reload_digest_schedule()
    await reload_fetch_schedule()
