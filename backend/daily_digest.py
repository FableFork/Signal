import anthropic
import json
import aiosqlite
from datetime import datetime
import pytz
from database import get_setting, DB_PATH


async def generate_digest(date_str: str = None) -> dict:
    """Generate daily digest via Claude. date_str = YYYY-MM-DD."""
    tz_name = await get_setting("timezone") or "Asia/Dubai"
    tz = pytz.timezone(tz_name)
    now_local = datetime.now(tz)

    if not date_str:
        date_str = now_local.strftime("%Y-%m-%d")

    # Check if already generated today
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT result_json, generated_at FROM daily_digests WHERE date=?",
            (date_str,)
        ) as cur:
            existing = await cur.fetchone()

    api_key = await get_setting("anthropic_api_key")
    if not api_key:
        return {"error": "No API key configured"}

    model = await get_setting("claude_model") or "claude-sonnet-4-20250514"
    max_tokens = 4096
    system_prompt = await get_setting("digest_system_prompt") or ""

    # Gather recent headlines to feed into Claude
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """SELECT title, source_name, published_at, snippet
               FROM articles
               ORDER BY fetched_at DESC
               LIMIT 80"""
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
                "INSERT OR REPLACE INTO daily_digests (date, result_json, generated_at) VALUES (?,?,?)",
                (date_str, json.dumps(result), generated_at)
            )
            await db.commit()

        return {"date": date_str, "generated_at": generated_at, "digest": result}

    except json.JSONDecodeError as e:
        return {"error": f"Failed to parse digest JSON: {str(e)}"}
    except Exception as e:
        return {"error": str(e)}


async def get_digest(date_str: str) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT result_json, generated_at FROM daily_digests WHERE date=?",
            (date_str,)
        ) as cur:
            row = await cur.fetchone()
            if row:
                return {
                    "date": date_str,
                    "generated_at": row[1],
                    "digest": json.loads(row[0])
                }
    return None


async def list_digest_dates() -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT date, generated_at FROM daily_digests ORDER BY date DESC"
        ) as cur:
            rows = await cur.fetchall()
            return [{"date": r[0], "generated_at": r[1]} for r in rows]
