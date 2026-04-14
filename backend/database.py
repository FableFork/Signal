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
    body TEXT,
    read INTEGER DEFAULT 0,
    tag TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS ai_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_guid TEXT UNIQUE NOT NULL,
    result_json TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    name TEXT UNIQUE NOT NULL,
    data_json TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    result_json TEXT,
    generated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

DEFAULT_SETTINGS = {
    "anthropic_api_key": "",
    "claude_model": "claude-sonnet-4-20250514",
    "max_tokens": "2048",
    "conviction_threshold": "7",
    "min_reward_risk": "3.0",
    "fetch_interval_seconds": "10",
    "digest_morning_time": "08:00",
    "digest_afternoon_time": "17:00",
    "digest_morning_enabled": "true",
    "digest_afternoon_enabled": "true",
    "timezone": "Asia/Dubai",
    "tradingview_default_symbol": "",
    "tradingview_default_interval": "1D",
    "tradingview_theme": "dark",
    "retention_days": "30",
    "font_family": "monospace",
    "theme_preset": "default",
    "color_bg_primary": "#0a0a0f",
    "color_bg_secondary": "#111118",
    "color_bg_tertiary": "#1a1a24",
    "color_accent": "#00d4ff",
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
    ])
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

        # Seed defaults
        for key, value in DEFAULT_SETTINGS.items():
            await db.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                (key, value)
            )
        await db.commit()


async def get_setting(key: str) -> Optional[str]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
            return row[0] if row else None


async def get_all_settings() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT key, value FROM settings") as cur:
            rows = await cur.fetchall()
            return {r[0]: r[1] for r in rows}


async def set_setting(key: str, value: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, value)
        )
        await db.commit()


async def purge_old_articles(days: int = 30):
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM articles WHERE fetched_at < ?", (cutoff,))
        await db.commit()
