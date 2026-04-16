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

from database import (
    init_db, DB_PATH, get_system_setting,
    mark_article_read, set_article_tag,
    purge_old_articles,
)
from infrastructure_fetcher import run_infrastructure_refresh
from globe_tracker import (
    refresh_flights, start_ais_stream,
    get_flights_data, get_vessels_data,
    get_flight_history, get_vessel_history,
)
from websocket_manager import ws_manager
from news_fetcher import run_fetch_cycle, get_article_body_full, _is_blocked
from ai_analyzer import analyze_article
from daily_digest import generate_digest, get_digest, list_digest_dates
from scheduler import start_scheduler
from settings_manager import (
    update_user_setting_safe, get_settings_safe,
    get_user_sources, save_user_sources
)
from database import get_user_setting

UID = 1  # Single-user mode — all data belongs to user 1


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await start_scheduler()
    # Seed infrastructure on first run (if table is empty)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM infrastructure_features") as cur:
            count = (await cur.fetchone())[0]
    if count == 0:
        asyncio.create_task(run_infrastructure_refresh())
    # Start flight tracking (no key needed)
    asyncio.create_task(refresh_flights())
    # Start AIS vessel stream if key is configured
    ais_key = await get_user_setting(UID, "aisstream_api_key")
    if ais_key:
        await start_ais_stream(ais_key)
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
            await ws.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)


# ─── Articles ─────────────────────────────────────────────────────────────────

@app.get("/api/articles")
async def get_articles(
    limit: int = 100,
    offset: int = 0,
    source: Optional[str] = None,
    since_hours: Optional[int] = None,
    keyword: Optional[str] = None,
):
    filters = ["1=1"]
    params = [UID]

    user_sources = await get_user_sources(UID)
    enabled_names = [s["name"] for s in user_sources if s.get("enabled", True)]
    if enabled_names:
        placeholders = ",".join("?" * len(enabled_names))
        filters.append(f"a.source_name IN ({placeholders})")
        params.extend(enabled_names)

    if source:
        filters.append("a.source_name=?")
        params.append(source)
    if since_hours:
        from datetime import timedelta
        cutoff = (datetime.utcnow() - timedelta(hours=since_hours)).isoformat()
        filters.append("a.published_at >= ?")
        params.append(cutoff)
    if keyword:
        filters.append("(a.title LIKE ? OR a.snippet LIKE ?)")
        params.extend([f"%{keyword}%", f"%{keyword}%"])

    where = " AND ".join(filters)
    params.extend([limit, offset])

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"""SELECT a.id, a.guid, a.source_name, a.category, a.title, a.url,
                       a.published_at, a.fetched_at, a.snippet,
                       COALESCE(uas.read, 0) as read,
                       uas.tag as tag
                FROM articles a
                LEFT JOIN user_article_states uas ON a.id = uas.article_id AND uas.user_id = ?
                WHERE {where}
                ORDER BY a.published_at DESC LIMIT ? OFFSET ?""",
            params
        ) as cur:
            rows = await cur.fetchall()

    return [dict(r) for r in rows]


@app.get("/api/articles/unread/count")
async def unread_count():
    user_sources = await get_user_sources(UID)
    enabled_names = [s["name"] for s in user_sources if s.get("enabled", True)]

    async with aiosqlite.connect(DB_PATH) as db:
        if enabled_names:
            placeholders = ",".join("?" * len(enabled_names))
            async with db.execute(
                f"""SELECT COUNT(*) FROM articles a
                    LEFT JOIN user_article_states uas ON a.id = uas.article_id AND uas.user_id = ?
                    WHERE a.source_name IN ({placeholders}) AND COALESCE(uas.read, 0) = 0""",
                [UID] + enabled_names
            ) as cur:
                row = await cur.fetchone()
        else:
            async with db.execute(
                """SELECT COUNT(*) FROM articles a
                   LEFT JOIN user_article_states uas ON a.id = uas.article_id AND uas.user_id = ?
                   WHERE COALESCE(uas.read, 0) = 0""",
                (UID,)
            ) as cur:
                row = await cur.fetchone()
    return {"count": row[0]}


@app.get("/api/articles/{article_id}")
async def get_article(article_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT a.*, COALESCE(uas.read, 0) as read, uas.tag
               FROM articles a
               LEFT JOIN user_article_states uas ON a.id = uas.article_id AND uas.user_id = ?
               WHERE a.id=?""",
            (UID, article_id)
        ) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Article not found")

    art = dict(row)
    stored_body = art.get("body") or ""
    if (not stored_body or _is_blocked(stored_body)) and art.get("url"):
        body = await get_article_body_full(art["url"])
        art["body"] = body
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute("UPDATE articles SET body=? WHERE id=?", (body, article_id))
            await db.commit()

    await mark_article_read(UID, article_id)
    art["read"] = 1

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
    await set_article_tag(UID, article_id, tag)
    return {"ok": True}


@app.post("/api/articles/{article_id}/analyze")
async def run_analysis(article_id: int):
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

    result = await analyze_article(art["guid"], art["title"], body, user_id=UID)
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
        async with db.execute(
            "SELECT * FROM positions WHERE user_id=? ORDER BY created_at DESC", (UID,)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.post("/api/positions")
async def create_position(pos: PositionIn):
    now = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO positions
               (user_id, instrument, direction, entry_price, size, stop_loss, take_profit,
                open_date, notes, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (UID, pos.instrument, pos.direction, pos.entry_price, pos.size,
             pos.stop_loss, pos.take_profit, pos.open_date, pos.notes, now)
        )
        await db.commit()
        pos_id = cur.lastrowid
    return {"id": pos_id}


@app.delete("/api/positions/{pos_id}")
async def delete_position(pos_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM positions WHERE id=? AND user_id=?", (pos_id, UID))
        await db.commit()
    return {"ok": True}


@app.put("/api/positions/{pos_id}")
async def update_position(pos_id: int, pos: PositionIn):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """UPDATE positions SET instrument=?, direction=?, entry_price=?,
               size=?, stop_loss=?, take_profit=?, open_date=?, notes=?
               WHERE id=? AND user_id=?""",
            (pos.instrument, pos.direction, pos.entry_price, pos.size,
             pos.stop_loss, pos.take_profit, pos.open_date, pos.notes,
             pos_id, UID)
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
        if price is None or (isinstance(price, float) and price != price):
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
        async with db.execute(
            "SELECT * FROM saved_calculations WHERE user_id=? ORDER BY created_at DESC", (UID,)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.post("/api/calculations")
async def save_calculation(body: dict):
    name = body.get("name", "")
    if not name:
        raise HTTPException(400, "Name required")
    now = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        existing = await db.execute(
            "SELECT id FROM saved_calculations WHERE user_id=? AND name=?", (UID, name)
        )
        row = await existing.fetchone()
        if row:
            await db.execute(
                "UPDATE saved_calculations SET data_json=?, created_at=? WHERE user_id=? AND name=?",
                (json.dumps(body.get("data", {})), now, UID, name)
            )
        else:
            await db.execute(
                "INSERT INTO saved_calculations (user_id, name, data_json, created_at) VALUES (?,?,?,?)",
                (UID, name, json.dumps(body.get("data", {})), now)
            )
        await db.commit()
    return {"ok": True}


@app.delete("/api/calculations/{name}")
async def delete_calculation(name: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM saved_calculations WHERE name=? AND user_id=?", (name, UID)
        )
        await db.commit()
    return {"ok": True}


# ─── Daily Digest ─────────────────────────────────────────────────────────────

@app.get("/api/digest/dates")
async def digest_dates():
    return await list_digest_dates(UID)


@app.get("/api/digest/{date}")
async def get_digest_by_date(date: str):
    result = await get_digest(date, UID)
    if not result:
        raise HTTPException(404, "No digest for this date")
    return result


@app.post("/api/digest/generate")
async def trigger_digest(body: dict = {}):
    date_str = body.get("date")
    result = await generate_digest(date_str, UID)
    return result


# ─── Globe ────────────────────────────────────────────────────────────────────

@app.get("/api/globe/data")
async def globe_data(since_hours: int = 48):
    from datetime import timedelta
    cutoff = (datetime.utcnow() - timedelta(hours=since_hours)).isoformat()

    user_sources = await get_user_sources(UID)
    enabled_names = [s["name"] for s in user_sources if s.get("enabled", True)]

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if enabled_names:
            placeholders = ",".join("?" * len(enabled_names))
            params = enabled_names + [cutoff]
            async with db.execute(
                f"""SELECT a.id, a.guid, a.title, a.source_name, a.published_at, a.category,
                           ai.result_json
                    FROM articles a
                    JOIN ai_analyses ai ON a.guid = ai.article_guid
                    WHERE a.source_name IN ({placeholders}) AND a.published_at >= ?
                    ORDER BY a.published_at DESC LIMIT 500""",
                params,
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                """SELECT a.id, a.guid, a.title, a.source_name, a.published_at, a.category,
                          ai.result_json
                   FROM articles a
                   JOIN ai_analyses ai ON a.guid = ai.article_guid
                   WHERE a.published_at >= ?
                   ORDER BY a.published_at DESC LIMIT 500""",
                (cutoff,),
            ) as cur:
                rows = await cur.fetchall()

    results = []
    for row in rows:
        try:
            ai = json.loads(row["result_json"])
        except Exception:
            continue
        results.append({
            "id": row["id"],
            "guid": row["guid"],
            "title": row["title"],
            "source_name": row["source_name"],
            "published_at": row["published_at"],
            "category": row["category"],
            "direction": ai.get("direction"),
            "conviction": ai.get("conviction"),
            "urgency": ai.get("urgency"),
            "timeframe": ai.get("timeframe"),
            "action": ai.get("action"),
            "reasoning": ai.get("reasoning"),
            "instruments_affected": ai.get("instruments_affected", []),
            "industries_affected": ai.get("industries_affected", []),
            "locations_affected": ai.get("locations_affected", []),
        })
    return results


# ─── Infrastructure ───────────────────────────────────────────────────────────

@app.get("/api/globe/infrastructure")
async def get_infrastructure(
    feature_types: Optional[str] = None,
    min_influence: int = 1,
    limit: int = 2000,
):
    """Return infrastructure features from DB, optionally filtered by type and influence."""
    filters = ["influence >= ?"]
    params: list = [min_influence]

    if feature_types:
        types = [t.strip() for t in feature_types.split(',') if t.strip()]
        if types:
            placeholders = ','.join('?' * len(types))
            filters.append(f"feature_type IN ({placeholders})")
            params.extend(types)

    where = ' AND '.join(filters)
    params.append(limit)

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT id, osm_id, feature_type, name, country, operator, "
            f"geometry_type, lat, lng, geometry_json, influence, capacity_note, fetched_at "
            f"FROM infrastructure_features WHERE {where} ORDER BY influence DESC LIMIT ?",
            params
        ) as cur:
            rows = await cur.fetchall()

    return [dict(r) for r in rows]


@app.post("/api/globe/infrastructure/refresh")
async def refresh_infrastructure(background_tasks: BackgroundTasks):
    """Trigger a fresh Overpass data pull in the background."""
    background_tasks.add_task(run_infrastructure_refresh)
    return {"ok": True, "message": "Infrastructure refresh started in background"}


@app.get("/api/globe/flights")
async def get_flights():
    """Return cached cargo flight positions from OpenSky Network."""
    return get_flights_data()


@app.get("/api/globe/vessels")
async def get_vessels():
    """Return cached vessel positions from AIS stream."""
    return get_vessels_data()


@app.post("/api/globe/tracking/start")
async def start_tracking():
    """Re-initialise tracking streams (called after saving AIS key in settings)."""
    asyncio.create_task(refresh_flights())
    ais_key = await get_user_setting(UID, "aisstream_api_key")
    if ais_key:
        await start_ais_stream(ais_key)
    return {"ok": True}


@app.get("/api/globe/vessels/{mmsi}/history")
async def vessel_history(mmsi: str):
    return {"history": await get_vessel_history(mmsi)}


@app.get("/api/globe/flights/{icao24}/history")
async def flight_history(icao24: str):
    return {"history": await get_flight_history(icao24)}


# ─── Settings ─────────────────────────────────────────────────────────────────

@app.get("/api/settings")
async def get_all():
    return await get_settings_safe(UID)


@app.post("/api/settings")
async def update_settings(body: dict):
    for key, value in body.items():
        await update_user_setting_safe(UID, key, str(value))
    return {"ok": True}


@app.get("/api/settings/sources")
async def api_get_sources():
    return await get_user_sources(UID)


@app.post("/api/settings/sources")
async def api_save_sources(body: dict):
    await save_user_sources(UID, body.get("sources", []))
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
    val = await get_system_setting("retention_days")
    days = int(val or "30")
    await purge_old_articles(days)
    return {"ok": True}


@app.get("/api/data/export")
async def export_data():
    import csv
    import io
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT a.* FROM articles a
               JOIN user_article_states uas ON a.id = uas.article_id
               WHERE uas.user_id=?""",
            (UID,)
        ) as cur:
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
