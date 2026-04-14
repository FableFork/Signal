import anthropic
import json
import aiosqlite
from datetime import datetime
from database import get_setting, DB_PATH


async def analyze_article(article_guid: str, title: str, body: str) -> dict:
    """Run Claude analysis on an article. Returns cached result if exists."""
    # Check cache first
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT result_json FROM ai_analyses WHERE article_guid=?",
            (article_guid,)
        ) as cur:
            row = await cur.fetchone()
            if row:
                return {"cached": True, "result": json.loads(row[0])}

    api_key = await get_setting("anthropic_api_key")
    if not api_key:
        return {"error": "No API key configured"}

    model = await get_setting("claude_model") or "claude-sonnet-4-20250514"
    max_tokens = int(await get_setting("max_tokens") or "2048")
    system_prompt = await get_setting("article_system_prompt") or ""

    content = f"Title: {title}\n\n{body[:4000]}"

    try:
        client = anthropic.AsyncAnthropic(api_key=api_key)
        msg = await client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[{"role": "user", "content": content}],
        )
        raw = msg.content[0].text.strip()

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        raw = raw.strip()

        result = json.loads(raw)

        # Cache result
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT OR REPLACE INTO ai_analyses (article_guid, result_json, created_at) VALUES (?,?,?)",
                (article_guid, json.dumps(result), datetime.utcnow().isoformat())
            )
            await db.commit()

        return {"cached": False, "result": result}

    except json.JSONDecodeError as e:
        return {"error": f"Failed to parse AI response: {str(e)}", "raw": raw if 'raw' in locals() else ""}
    except Exception as e:
        return {"error": str(e)}
