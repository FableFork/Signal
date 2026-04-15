import aiosqlite
import json
import os
from datetime import datetime, timedelta
from typing import Optional

DB_PATH = os.environ.get("DB_PATH", "./signal.db")

CREATE_TABLES = """
CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE NOT NULL,
    source_name TEXT,
    source_url TEXT,
    category TEXT,
    title TEXT,
    url TEXT,
    published_at TEXT,
    fetched_at TEXT,
    snippet TEXT,
    body TEXT
);

CREATE TABLE IF NOT EXISTS ai_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_guid TEXT UNIQUE NOT NULL,
    result_json TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_article_states (
    user_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    read INTEGER DEFAULT 0,
    tag TEXT DEFAULT NULL,
    PRIMARY KEY (user_id, article_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (article_id) REFERENCES articles(id)
);

CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    instrument TEXT,
    direction TEXT,
    entry_price REAL,
    size REAL,
    stop_loss REAL,
    take_profit REAL,
    open_date TEXT,
    notes TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS saved_calculations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    name TEXT NOT NULL,
    data_json TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    date TEXT NOT NULL,
    result_json TEXT,
    generated_at TEXT,
    UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

# Defaults applied to each new user
USER_SETTING_DEFAULTS = {
    "anthropic_api_key": "",
    "claude_model": "claude-sonnet-4-20250514",
    "max_tokens": "2048",
    "conviction_threshold": "7",
    "min_reward_risk": "3.0",
    "digest_morning_time": "08:00",
    "digest_afternoon_time": "17:00",
    "digest_morning_enabled": "true",
    "digest_afternoon_enabled": "true",
    "timezone": "Asia/Dubai",
    "tradingview_default_symbol": "",
    "tradingview_default_interval": "1D",
    "tradingview_theme": "dark",
    "font_family": "sans-serif",
    "theme_preset": "default",
    "color_bg_primary": "#000000",
    "color_bg_secondary": "#070709",
    "color_bg_tertiary": "#1a1a24",
    "color_accent": "#00ff40",
    "color_text_primary": "#e8e8f0",
    "color_text_secondary": "#888899",
    "color_border": "#1e1e2e",
    "color_bullish": "#00ff88",
    "color_bearish": "#ff3b3b",
    "color_neutral": "#888888",
    "color_urgency_high": "#ff6b00",
    "article_system_prompt": """You are SIGNAL, a trading intelligence system. Analyze the provided news article and determine its market implications.
Trace causality chains from the news event to affected instruments and industries. Examples:
Iran/Hormuz/Middle East → Oil, Gold, Energy stocks, Shipping
Fed decision/CPI/inflation → Gold, USD pairs, Rate-sensitive stocks
China demand data → Oil, Copper, Mining stocks
Supply disruption → Commodity of that supply chain
Geopolitical escalation → Gold (safe haven), Oil (if energy region)

Return ONLY valid JSON, no prose, no markdown, no preamble:
{
"instruments_affected": ["ticker1", "ticker2"],
"industries_affected": ["energy", "shipping"],
"direction": "bullish|bearish|neutral",
"conviction": 1-10,
"timeframe": "intraday|swing|positional",
"reasoning": "max 3 sentences",
"action": "buy|sell|hold|watch",
"urgency": "high|medium|low",
"suggested_entry": null,
"suggested_stop": null,
"suggested_target": null,
"reward_risk_ratio": null
}""",
    "digest_system_prompt": """You are SIGNAL's daily intelligence briefing system. Generate a comprehensive market and world digest for a trader focused on commodities, energy, and global equities.
Cover in order of importance:
Breaking news (last 24h, globally significant, no topic filter)
Macro overview
Geopolitical developments with market implications
Energy sector (oil, gas, Hormuz, OPEC)
Metals (gold, silver, copper)
Equities (major indices, notable movers)
Crypto (brief, top movers only)
Suggested watchlist for today
Scheduled data events today

For the suggested watchlist return each item as:
{"ticker": "USOIL", "name": "Crude Oil", "reason": "one sentence", "bias": "bullish|bearish|neutral"}
Return full digest as structured JSON with a field per section.
Each section has a "summary" string and "items" array where relevant.
Watchlist is an array of watchlist objects.
Data events is an array of {time_utc4, event, importance}.""",
    "sources": json.dumps([
        {"name": "Reuters", "url": "https://feeds.reuters.com/reuters/topNews", "category": "general", "enabled": True},
        {"name": "AP News", "url": "https://rsshub.app/apnews/topics/apf-topnews", "category": "general", "enabled": True},
        {"name": "Al Jazeera", "url": "https://www.aljazeera.com/xml/rss/all.xml", "category": "geopolitical", "enabled": True},
        {"name": "CNBC Energy", "url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768", "category": "energy", "enabled": True},
        {"name": "Bloomberg Markets", "url": "https://feeds.bloomberg.com/markets/news.rss", "category": "markets", "enabled": True},
        {"name": "BBC World", "url": "https://feeds.bbci.co.uk/news/world/rss.xml", "category": "geopolitical", "enabled": True},
        {"name": "BBC Business", "url": "https://feeds.bbci.co.uk/news/business/rss.xml", "category": "general", "enabled": True},
    ]),
}

# System-wide settings (not per-user)
SYSTEM_DEFAULTS = {
    "fetch_interval_seconds": "60",
    "retention_days": "30",
}


async def get_db():
    return await aiosqlite.connect(DB_PATH)


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        for stmt in CREATE_TABLES.strip().split(";"):
            stmt = stmt.strip()
            if stmt:
                await db.execute(stmt)
        await db.commit()

        # Migrations for existing DBs
        for migration in [
            "ALTER TABLE positions ADD COLUMN user_id INTEGER DEFAULT 1",
            "ALTER TABLE saved_calculations ADD COLUMN user_id INTEGER DEFAULT 1",
        ]:
            try:
                await db.execute(migration)
                await db.commit()
            except Exception:
                pass  # Column already exists

        # Seed system settings
        for key, value in SYSTEM_DEFAULTS.items():
            await db.execute(
                "INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)",
                (key, value)
            )
        await db.commit()


# ─── System settings ──────────────────────────────────────────────────────────

async def get_system_setting(key: str) -> Optional[str]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT value FROM system_settings WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
            return row[0] if row else None


async def set_system_setting(key: str, value: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)",
            (key, value)
        )
        await db.commit()


# ─── User settings ────────────────────────────────────────────────────────────

async def get_user_setting(user_id: int, key: str) -> Optional[str]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT value FROM user_settings WHERE user_id=? AND key=?", (user_id, key)
        ) as cur:
            row = await cur.fetchone()
            if row:
                return row[0]
    return USER_SETTING_DEFAULTS.get(key)


async def get_all_user_settings(user_id: int) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT key, value FROM user_settings WHERE user_id=?", (user_id,)
        ) as cur:
            rows = await cur.fetchall()
    stored = {r[0]: r[1] for r in rows}
    # Merge with defaults so missing keys always return something
    return {**USER_SETTING_DEFAULTS, **stored}


async def set_user_setting(user_id: int, key: str, value: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)",
            (user_id, key, value)
        )
        await db.commit()


async def seed_user_settings(user_id: int, settings_dict: dict):
    async with aiosqlite.connect(DB_PATH) as db:
        for key, value in settings_dict.items():
            await db.execute(
                "INSERT OR IGNORE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)",
                (user_id, key, value)
            )
        await db.commit()


# ─── Users ────────────────────────────────────────────────────────────────────

async def count_users() -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM users") as cur:
            row = await cur.fetchone()
            return row[0]


async def get_all_user_ids() -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id FROM users") as cur:
            rows = await cur.fetchall()
            return [r[0] for r in rows]


# ─── Article state ────────────────────────────────────────────────────────────

async def mark_article_read(user_id: int, article_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO user_article_states (user_id, article_id, read, tag) "
            "VALUES (?, ?, 1, COALESCE((SELECT tag FROM user_article_states WHERE user_id=? AND article_id=?), NULL))",
            (user_id, article_id, user_id, article_id)
        )
        await db.commit()


async def set_article_tag(user_id: int, article_id: int, tag: Optional[str]):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO user_article_states (user_id, article_id, read, tag) "
            "VALUES (?, ?, COALESCE((SELECT read FROM user_article_states WHERE user_id=? AND article_id=?), 0), ?)",
            (user_id, article_id, user_id, article_id, tag)
        )
        await db.commit()


# ─── Data management ──────────────────────────────────────────────────────────

async def purge_old_articles(days: int = 30):
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM articles WHERE fetched_at < ?", (cutoff,))
        await db.commit()
