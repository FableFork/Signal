import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

import aiosqlite
import yfinance as yf
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, BackgroundTasks, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from database import (
    init_db, DB_PATH, get_system_setting,
    get_user_setting, set_user_setting,
    mark_article_read, set_article_tag,
    purge_old_articles, count_users
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
from auth import (
    hash_password, verify_password, create_token, get_current_user
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


# ─── Auth ─────────────────────────────────────────────────────────────────────

class AuthBody(BaseModel):
    username: str
    password: str


@app.get("/api/auth/status")
async def auth_status():
    n = await count_users()
    return {"has_users": n > 0}


@app.post("/api/auth/register")
async def register(body: AuthBody):
    if not body.username.strip() or not body.password:
        raise HTTPException(400, "Username and password required")
    hashed = hash_password(body.password)
    now = datetime.utcnow().isoformat()
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            cur = await db.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (body.username.strip(), hashed, now)
            )
            await db.commit()
            user_id = cur.lastrowid
    except Exception:
        raise HTTPException(400, "Username already taken")
    token = create_token(user_id)
    return {"token": token, "user": {"id": user_id, "username": body.username.strip()}}


@app.post("/api/auth/login")
async def login(body: AuthBody):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM users WHERE username=?", (body.username.strip(),)
        ) as cur:
            row = await cur.fetchone()
    if not row or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(401, "Invalid username or password")
    token = create_token(row["id"])
    return {"token": token, "user": {"id": row["id"], "username": row["username"]}}


@app.get("/api/auth/me")
async def me(current_user: dict = Depends(get_current_user)):
    api_key = await get_user_setting(current_user["id"], "anthropic_api_key")
    return {**current_user, "has_api_key": bool(api_key)}


@app.post("/api/auth/api-key")
async def set_api_key(body: dict, current_user: dict = Depends(get_current_user)):
    key = body.get("api_key", "")
    await set_user_setting(current_user["id"], "anthropic_api_key", key)
    return {"ok": True}


@app.post("/api/auth/change-password")
async def change_password(body: dict, current_user: dict = Depends(get_current_user)):
    old_pw = body.get("old_password", "")
    new_pw = body.get("new_password", "")
    if not new_pw or len(new_pw) < 6:
        raise HTTPException(400, "New password must be at least 6 characters")
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT password_hash FROM users WHERE id=?", (current_user["id"],)) as cur:
            row = await cur.fetchone()
    if not row or not verify_password(old_pw, row["password_hash"]):
        raise HTTPException(401, "Current password is incorrect")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE users SET password_hash=? WHERE id=?",
            (hash_password(new_pw), current_user["id"])
        )
        await db.commit()
    return {"ok": True}


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
    current_user: dict = Depends(get_current_user),
):
    uid = current_user["id"]
    filters = ["1=1"]
    params = [uid]

    # Filter to user's enabled sources
    user_sources = await get_user_sources(uid)
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
async def unread_count(current_user: dict = Depends(get_current_user)):
    uid = current_user["id"]
    user_sources = await get_user_sources(uid)
    enabled_names = [s["name"] for s in user_sources if s.get("enabled", True)]

    async with aiosqlite.connect(DB_PATH) as db:
        if enabled_names:
            placeholders = ",".join("?" * len(enabled_names))
            async with db.execute(
                f"""SELECT COUNT(*) FROM articles a
                    LEFT JOIN user_article_states uas ON a.id = uas.article_id AND uas.user_id = ?
                    WHERE a.source_name IN ({placeholders}) AND COALESCE(uas.read, 0) = 0""",
                [uid] + enabled_names
            ) as cur:
                row = await cur.fetchone()
        else:
            async with db.execute(
                """SELECT COUNT(*) FROM articles a
                   LEFT JOIN user_article_states uas ON a.id = uas.article_id AND uas.user_id = ?
                   WHERE COALESCE(uas.read, 0) = 0""",
                (uid,)
            ) as cur:
                row = await cur.fetchone()
    return {"count": row[0]}


@app.get("/api/articles/{article_id}")
async def get_article(article_id: int, current_user: dict = Depends(get_current_user)):
    uid = current_user["id"]
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT a.*, COALESCE(uas.read, 0) as read, uas.tag
               FROM articles a
               LEFT JOIN user_article_states uas ON a.id = uas.article_id AND uas.user_id = ?
               WHERE a.id=?""",
            (uid, article_id)
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

    await mark_article_read(uid, article_id)
    art["read"] = 1

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT result_json FROM ai_analyses WHERE article_guid=?", (art["guid"],)
        ) as cur:
            ai_row = await cur.fetchone()
    art["ai_analysis"] = json.loads(ai_row[0]) if ai_row else None

    return art


@app.post("/api/articles/{article_id}/tag")
async def tag_article(article_id: int, body: dict, current_user: dict = Depends(get_current_user)):
    tag = body.get("tag")
    await set_article_tag(current_user["id"], article_id, tag)
    return {"ok": True}


@app.post("/api/articles/{article_id}/analyze")
async def run_analysis(article_id: int, bg: BackgroundTasks, current_user: dict = Depends(get_current_user)):
    uid = current_user["id"]
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

    user_api_key = await get_user_setting(uid, "anthropic_api_key")
    result = await analyze_article(art["guid"], art["title"], body, api_key=user_api_key)
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
async def get_positions(current_user: dict = Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM positions WHERE user_id=? ORDER BY created_at DESC",
            (current_user["id"],)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.post("/api/positions")
async def create_position(pos: PositionIn, current_user: dict = Depends(get_current_user)):
    now = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO positions
               (user_id, instrument, direction, entry_price, size, stop_loss, take_profit,
                open_date, notes, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (current_user["id"], pos.instrument, pos.direction, pos.entry_price, pos.size,
             pos.stop_loss, pos.take_profit, pos.open_date, pos.notes, now)
        )
        await db.commit()
        pos_id = cur.lastrowid
    return {"id": pos_id}


@app.delete("/api/positions/{pos_id}")
async def delete_position(pos_id: int, current_user: dict = Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM positions WHERE id=? AND user_id=?",
            (pos_id, current_user["id"])
        )
        await db.commit()
    return {"ok": True}


@app.put("/api/positions/{pos_id}")
async def update_position(pos_id: int, pos: PositionIn, current_user: dict = Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """UPDATE positions SET instrument=?, direction=?, entry_price=?,
               size=?, stop_loss=?, take_profit=?, open_date=?, notes=?
               WHERE id=? AND user_id=?""",
            (pos.instrument, pos.direction, pos.entry_price, pos.size,
             pos.stop_loss, pos.take_profit, pos.open_date, pos.notes,
             pos_id, current_user["id"])
        )
        await db.commit()
    return {"ok": True}


# ─── Price Data ───────────────────────────────────────────────────────────────

@app.get("/api/price/{symbol}")
async def get_price(symbol: str, current_user: dict = Depends(get_current_user)):
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
async def get_calculations(current_user: dict = Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM saved_calculations WHERE user_id=? ORDER BY created_at DESC",
            (current_user["id"],)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.post("/api/calculations")
async def save_calculation(body: dict, current_user: dict = Depends(get_current_user)):
    name = body.get("name", "")
    if not name:
        raise HTTPException(400, "Name required")
    uid = current_user["id"]
    now = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        existing = await db.execute(
            "SELECT id FROM saved_calculations WHERE user_id=? AND name=?", (uid, name)
        )
        row = await existing.fetchone()
        if row:
            await db.execute(
                "UPDATE saved_calculations SET data_json=?, created_at=? WHERE user_id=? AND name=?",
                (json.dumps(body.get("data", {})), now, uid, name)
            )
        else:
            await db.execute(
                "INSERT INTO saved_calculations (user_id, name, data_json, created_at) VALUES (?,?,?,?)",
                (uid, name, json.dumps(body.get("data", {})), now)
            )
        await db.commit()
    return {"ok": True}


@app.delete("/api/calculations/{name}")
async def delete_calculation(name: str, current_user: dict = Depends(get_current_user)):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM saved_calculations WHERE name=? AND user_id=?",
            (name, current_user["id"])
        )
        await db.commit()
    return {"ok": True}


# ─── Daily Digest ─────────────────────────────────────────────────────────────

@app.get("/api/digest/dates")
async def digest_dates(current_user: dict = Depends(get_current_user)):
    return await list_digest_dates(current_user["id"])


@app.get("/api/digest/{date}")
async def get_digest_by_date(date: str, current_user: dict = Depends(get_current_user)):
    result = await get_digest(date, current_user["id"])
    if not result:
        raise HTTPException(404, "No digest for this date")
    return result


@app.post("/api/digest/generate")
async def trigger_digest(body: dict = {}, current_user: dict = Depends(get_current_user)):
    date_str = body.get("date")
    result = await generate_digest(date_str, current_user["id"])
    return result


# ─── Settings ─────────────────────────────────────────────────────────────────

@app.get("/api/settings")
async def get_all(current_user: dict = Depends(get_current_user)):
    return await get_settings_safe(current_user["id"])


@app.post("/api/settings")
async def update_settings(body: dict, current_user: dict = Depends(get_current_user)):
    uid = current_user["id"]
    for key, value in body.items():
        if key == "anthropic_api_key" and value == "***":
            continue
        await update_user_setting_safe(uid, key, str(value))
    return {"ok": True}


@app.get("/api/settings/sources")
async def api_get_sources(current_user: dict = Depends(get_current_user)):
    return await get_user_sources(current_user["id"])


@app.post("/api/settings/sources")
async def api_save_sources(body: dict, current_user: dict = Depends(get_current_user)):
    await save_user_sources(current_user["id"], body.get("sources", []))
    return {"ok": True}


@app.post("/api/settings/sources/test")
async def test_source(body: dict, current_user: dict = Depends(get_current_user)):
    from news_fetcher import fetch_feed
    source = body.get("source", {})
    articles = await fetch_feed(source)
    return {"headlines": [a["title"] for a in articles[:3]]}


# ─── Data Management ──────────────────────────────────────────────────────────

@app.post("/api/data/purge")
async def purge_data(current_user: dict = Depends(get_current_user)):
    val = await get_system_setting("retention_days")
    days = int(val or "30")
    await purge_old_articles(days)
    return {"ok": True}


@app.get("/api/data/export")
async def export_data(current_user: dict = Depends(get_current_user)):
    import csv
    import io
    uid = current_user["id"]
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT a.* FROM articles a
               JOIN user_article_states uas ON a.id = uas.article_id
               WHERE uas.user_id=?""",
            (uid,)
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
