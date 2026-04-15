import anthropic
import json
import aiosqlite
from datetime import datetime
import pytz
from database import get_user_setting, DB_PATH


async def generate_digest(date_str: str = None, user_id: int = 1) -> dict:
    """Generate daily digest via Claude for a specific user."""
    tz_name = await get_user_setting(user_id, "timezone") or "Asia/Dubai"
    tz = pytz.timezone(tz_name)
    now_local = datetime.now(tz)

    if not date_str:
        date_str = now_local.strftime("%Y-%m-%d")

    # Check if already generated for this user today
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT result_json, generated_at FROM daily_digests WHERE user_id=? AND date=?",
            (user_id, date_str)
        ) as cur:
            existing = await cur.fetchone()

    api_key = await get_user_setting(user_id, "anthropic_api_key")
    if not api_key:
        return {"error": "No API key configured"}

    model = await get_user_setting(user_id, "claude_model") or "claude-sonnet-4-20250514"
    max_tokens = 4096
    system_prompt = await get_user_setting(user_id, "digest_system_prompt") or ""

    # Gather recent headlines from this user's sources
    from settings_manager import get_user_sources
    user_sources = await get_user_sources(user_id)
    source_names = [s["name"] for s in user_sources if s.get("enabled", True)]

    async with aiosqlite.connect(DB_PATH) as db:
        if source_names:
            placeholders = ",".join("?" * len(source_names))
            async with db.execute(
                f"""SELECT title, source_name, published_at, snippet
                    FROM articles
                    WHERE source_name IN ({placeholders})
                    ORDER BY published_at DESC LIMIT 80""",
                source_names
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                "SELECT title, source_name, published_at, snippet FROM articles ORDER BY published_at DESC LIMIT 80"
            ) as cur:
                rows = await cur.fetchall()

    headlines = "\n".join(
        f"- [{r[1]}] {r[0]} ({r[2][:10]})" for r in rows
    )

    user_msg = f"""Today is {date_str} ({now_local.strftime('%A')}). Local time: {now_local.strftime('%H:%M')} {tz_name}.

Recent headlines from monitored sources:
{headlines}

Generate a comprehensive trading intelligence digest for today. Return ONLY valid JSON."""

    try:
        client = anthropic.AsyncAnthropic(api_key=api_key)
        msg = await client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[{"role": "user", "content": user_msg}],
        )
        raw = msg.content[0].text.strip()

        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        raw = raw.strip()

        result = json.loads(raw)
        generated_at = datetime.utcnow().isoformat()

        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT OR REPLACE INTO daily_digests (user_id, date, result_json, generated_at) VALUES (?,?,?,?)",
                (user_id, date_str, json.dumps(result), generated_at)
            )
            await db.commit()

        return {"date": date_str, "generated_at": generated_at, "digest": result}

    except json.JSONDecodeError as e:
        return {"error": f"Failed to parse digest JSON: {str(e)}"}
    except Exception as e:
        return {"error": str(e)}


async def get_digest(date_str: str, user_id: int = 1) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT result_json, generated_at FROM daily_digests WHERE user_id=? AND date=?",
            (user_id, date_str)
        ) as cur:
            row = await cur.fetchone()
            if row:
                return {
                    "date": date_str,
                    "generated_at": row[1],
                    "digest": json.loads(row[0])
                }
    return None


async def list_digest_dates(user_id: int = 1) -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT date, generated_at FROM daily_digests WHERE user_id=? ORDER BY date DESC",
            (user_id,)
        ) as cur:
            rows = await cur.fetchall()
            return [{"date": r[0], "generated_at": r[1]} for r in rows]
