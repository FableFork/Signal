import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

import aiosqlite
import yfinance as yf
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from database import init_db, DB_PATH, get_setting, set_setting, purge_old_articles
from websocket_manager import ws_manager
from news_fetcher import run_fetch_cycle, get_article_body_full, _is_blocked
from ai_analyzer import analyze_article
from daily_digest import generate_digest, get_digest, list_digest_dates
from scheduler import start_scheduler
from settings_manager import (
    update_setting, get_settings_safe, get_sources, save_sources
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await start_scheduler()
    yield


app = FastAPI(title="SIGNAL", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── WebSocket ────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws_manager.connect(ws)
    try:
        while True:
            await ws.receive_text()  # keep-alive
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)


# ─── Articles ─────────────────────────────────────────────────────────────────

@app.get("/api/articles")
async def get_articles(
    limit: int = 50,
    offset: int = 0,
    source: Optional[str] = None,
    since_hours: Optional[int] = None,
    keyword: Optional[str] = None,
):
    filters = ["1=1"]
    params = []

    if source:
        filters.append("source_name=?")
        params.append(source)
    if since_hours:
        from datetime import timedelta
        cutoff = (datetime.utcnow() - timedelta(hours=since_hours)).isoformat()
        filters.append("published_at >= ?")
        params.append(cutoff)
    if keyword:
        filters.append("(title LIKE ? OR snippet LIKE ?)")
        params.extend([f"%{keyword}%", f"%{keyword}%"])

    where = " AND ".join(filters)
    params.extend([limit, offset])

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"""SELECT id, guid, source_name, category, title, url, published_at,
                       fetched_at, snippet, read, tag
                FROM articles WHERE {where}
                ORDER BY published_at DESC LIMIT ? OFFSET ?""",
            params
        ) as cur:
            rows = await cur.fetchall()

    return [dict(r) for r in rows]


@app.get("/api/articles/unread/count")
async def unread_count():
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM articles WHERE read=0") as cur:
            row = await cur.fetchone()
    return {"count": row[0]}


@app.get("/api/articles/{article_id}")
async def get_article(article_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM articles WHERE id=?", (article_id,)
        ) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Article not found")

    art = dict(row)
    # Fetch body from URL if missing or if stored body is a paywall/bot-detection page
    stored_body = art.get("body") or ""
    if (not stored_body or _is_blocked(stored_body)) and art.get("url"):
        body = await get_article_body_full(art["url"])
        art["body"] = body
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute("UPDATE articles SET body=? WHERE id=?", (body, article_id))
            await db.commit()

    # Mark read
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE articles SET read=1 WHERE id=?", (article_id,))
        await db.commit()

    # Attach AI analysis if cached
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT result_json FROM ai_analyses WHERE article_guid=?", (art["guid"],)
        ) as cur:
            ai_row = await cur.fetchone()
    art["ai_analysis"] = json.loads(ai_row[0]) if ai_row else None

    return art


@app.post("/api/articles/{article_id}/tag")
async def tag_article(article_id: int, body: dict):
    tag = body.get("tag")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE articles SET tag=? WHERE id=?", (tag, article_id))
        await db.commit()
    return {"ok": True}


@app.post("/api/articles/{article_id}/analyze")
async def run_analysis(article_id: int, bg: BackgroundTasks):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM articles WHERE id=?", (article_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Article not found")

    art = dict(row)
    body = art.get("body") or ""
    if (not body or _is_blocked(body)) and art.get("url"):
        body = await get_article_body_full(art["url"])

    result = await analyze_article(art["guid"], art["title"], body)
    return result


# ─── Positions ────────────────────────────────────────────────────────────────

class PositionIn(BaseModel):
    instrument: str
    direction: str
    entry_price: float
    size: float
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    open_date: Optional[str] = None
    notes: Optional[str] = None


@app.get("/api/positions")
async def get_positions():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM positions ORDER BY created_at DESC") as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.post("/api/positions")
async def create_position(pos: PositionIn):
    now = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO positions
               (instrument, direction, entry_price, size, stop_loss, take_profit,
                open_date, notes, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (pos.instrument, pos.direction, pos.entry_price, pos.size,
             pos.stop_loss, pos.take_profit, pos.open_date, pos.notes, now)
        )
        await db.commit()
        pos_id = cur.lastrowid
    return {"id": pos_id}


@app.delete("/api/positions/{pos_id}")
async def delete_position(pos_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM positions WHERE id=?", (pos_id,))
        await db.commit()
    return {"ok": True}


@app.put("/api/positions/{pos_id}")
async def update_position(pos_id: int, pos: PositionIn):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """UPDATE positions SET instrument=?, direction=?, entry_price=?,
               size=?, stop_loss=?, take_profit=?, open_date=?, notes=?
               WHERE id=?""",
            (pos.instrument, pos.direction, pos.entry_price, pos.size,
             pos.stop_loss, pos.take_profit, pos.open_date, pos.notes, pos_id)
        )
        await db.commit()
    return {"ok": True}


# ─── Price Data ───────────────────────────────────────────────────────────────

@app.get("/api/price/{symbol}")
async def get_price(symbol: str):
    try:
        ticker = yf.Ticker(symbol)
        price = None
        try:
            price = ticker.fast_info.last_price
        except Exception:
            pass
        if price is None or (isinstance(price, float) and price != price):  # NaN check
            hist = ticker.history(period="1d")
            if not hist.empty:
                price = float(hist["Close"].iloc[-1])
        if price is None:
            raise HTTPException(404, f"No price data for {symbol}")
        return {"symbol": symbol, "price": float(price)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))


# ─── Saved Calculations ───────────────────────────────────────────────────────

@app.get("/api/calculations")
async def get_calculations():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM saved_calculations ORDER BY created_at DESC") as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.post("/api/calculations")
async def save_calculation(body: dict):
    name = body.get("name", "")
    if not name:
        raise HTTPException(400, "Name required")
    now = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        try:
            await db.execute(
                "INSERT INTO saved_calculations (name, data_json, created_at) VALUES (?,?,?)",
                (name, json.dumps(body.get("data", {})), now)
            )
        except Exception:
            await db.execute(
                "UPDATE saved_calculations SET data_json=?, created_at=? WHERE name=?",
                (json.dumps(body.get("data", {})), now, name)
            )
        await db.commit()
    return {"ok": True}


@app.delete("/api/calculations/{name}")
async def delete_calculation(name: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM saved_calculations WHERE name=?", (name,))
        await db.commit()
    return {"ok": True}


# ─── Daily Digest ─────────────────────────────────────────────────────────────

@app.get("/api/digest/dates")
async def digest_dates():
    return await list_digest_dates()


@app.get("/api/digest/{date}")
async def get_digest_by_date(date: str):
    result = await get_digest(date)
    if not result:
        raise HTTPException(404, "No digest for this date")
    return result


@app.post("/api/digest/generate")
async def trigger_digest(body: dict = {}):
    date_str = body.get("date")
    result = await generate_digest(date_str)
    return result


# ─── Settings ─────────────────────────────────────────────────────────────────

@app.get("/api/settings")
async def get_all():
    return await get_settings_safe()


@app.post("/api/settings")
async def update_settings(body: dict):
    for key, value in body.items():
        if key == "anthropic_api_key" and value == "***":
            continue  # Don't overwrite with masked placeholder
        await update_setting(key, str(value))
    return {"ok": True}


@app.get("/api/settings/sources")
async def api_get_sources():
    return await get_sources()


@app.post("/api/settings/sources")
async def api_save_sources(body: dict):
    await save_sources(body.get("sources", []))
    return {"ok": True}


@app.post("/api/settings/sources/test")
async def test_source(body: dict):
    from news_fetcher import fetch_feed
    source = body.get("source", {})
    articles = await fetch_feed(source)
    return {"headlines": [a["title"] for a in articles[:3]]}


# ─── Data Management ──────────────────────────────────────────────────────────

@app.post("/api/data/purge")
async def purge_data():
    days = int(await get_setting("retention_days") or "30")
    await purge_old_articles(days)
    return {"ok": True}


@app.get("/api/data/export")
async def export_data():
    import csv
    import io
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM articles") as cur:
            articles = [dict(r) for r in await cur.fetchall()]
        async with db.execute("SELECT * FROM ai_analyses") as cur:
            analyses = {r[0]: json.loads(r[1]) for r in await cur.fetchall()}

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=[
        "guid", "source_name", "category", "title", "url",
        "published_at", "snippet", "instruments_affected",
        "direction", "conviction", "action", "urgency"
    ])
    writer.writeheader()
    for art in articles:
        ai = analyses.get(art["guid"], {})
        writer.writerow({
            "guid": art["guid"],
            "source_name": art["source_name"],
            "category": art["category"],
            "title": art["title"],
            "url": art["url"],
            "published_at": art["published_at"],
            "snippet": art["snippet"],
            "instruments_affected": ",".join(ai.get("instruments_affected", [])),
            "direction": ai.get("direction", ""),
            "conviction": ai.get("conviction", ""),
            "action": ai.get("action", ""),
            "urgency": ai.get("urgency", ""),
        })

    from fastapi.responses import Response
    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=signal_export.csv"}
    )
