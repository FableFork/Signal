import feedparser
import httpx
import json
import asyncio
from datetime import datetime, timezone
from bs4 import BeautifulSoup
from database import aiosqlite, DB_PATH
from websocket_manager import ws_manager
import hashlib


def _make_guid(url: str, title: str) -> str:
    raw = (url or "") + (title or "")
    return hashlib.sha1(raw.encode()).hexdigest()


def _strip_html(html: str) -> str:
    if not html:
        return ""
    soup = BeautifulSoup(html, "html.parser")
    return soup.get_text(separator=" ", strip=True)


def _snippet(text: str, words: int = 15) -> str:
    parts = text.split()
    return " ".join(parts[:words]) + ("..." if len(parts) > words else "")


PAYWALL_SIGNALS = [
    "are you a robot",
    "unusual activity",
    "please enable javascript",
    "please enable cookies",
    "verify you are human",
    "access denied",
    "subscribe to continue",
    "subscribe now",
    "this content is for subscribers",
    "create a free account",
    "sign in to read",
    "log in to read",
    "403 forbidden",
    "cloudflare",
    "just a moment",
    "checking your browser",
]


def _is_blocked(text: str) -> bool:
    lower = text.lower()
    hits = sum(1 for s in PAYWALL_SIGNALS if s in lower)
    # If 2+ paywall signals appear in a short text, it's a block page
    return hits >= 2 or (hits >= 1 and len(text) < 1500)


async def fetch_body(url: str, timeout: int = 8) -> str:
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        }
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
            resp = await client.get(url, headers=headers)
            soup = BeautifulSoup(resp.text, "html.parser")
            # Remove nav/header/footer/script/style
            for tag in soup(["script", "style", "nav", "header", "footer", "aside", "form"]):
                tag.decompose()
            # Try common article containers
            for selector in ["article", '[class*="article-body"]', '[class*="story-body"]',
                              '[class*="content-body"]', "main", ".post-content"]:
                el = soup.select_one(selector)
                if el:
                    text = el.get_text(separator=" ", strip=True)
                    if len(text) > 200:
                        if _is_blocked(text):
                            return ""
                        return text[:3000]
            full = soup.get_text(separator=" ", strip=True)
            if _is_blocked(full):
                return ""
            return full[:3000]
    except Exception:
        return ""


async def fetch_feed(source: dict) -> list:
    """Fetch and parse a single RSS feed, return list of article dicts."""
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            resp = await client.get(source["url"], headers={"User-Agent": "Mozilla/5.0"})
            content = resp.text
    except Exception as e:
        return []

    feed = feedparser.parse(content)
    articles = []
    for entry in feed.entries[:30]:
        url = entry.get("link", "")
        title = entry.get("title", "")
        guid = entry.get("id", _make_guid(url, title))

        # Parse date
        published = None
        if hasattr(entry, "published_parsed") and entry.published_parsed:
            try:
                published = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc).isoformat()
            except Exception:
                pass
        if not published:
            published = datetime.utcnow().isoformat()

        # Body from entry content/summary
        raw_body = ""
        if hasattr(entry, "content") and entry.content:
            raw_body = entry.content[0].get("value", "")
        elif hasattr(entry, "summary"):
            raw_body = entry.summary or ""
        body_text = _strip_html(raw_body)

        articles.append({
            "guid": guid,
            "source_name": source["name"],
            "source_url": source["url"],
            "category": source.get("category", "general"),
            "title": title,
            "url": url,
            "published_at": published,
            "fetched_at": datetime.utcnow().isoformat(),
            "snippet": _snippet(body_text or title),
            "body": body_text[:3000] if body_text else "",
        })
    return articles


async def store_articles(articles: list) -> list:
    """Insert new articles into DB, return only the newly inserted ones (with db id)."""
    new_articles = []
    async with aiosqlite.connect(DB_PATH) as db:
        for art in articles:
            try:
                cur = await db.execute(
                    """INSERT INTO articles
                    (guid, source_name, source_url, category, title, url,
                     published_at, fetched_at, snippet, body, read, tag)
                    VALUES (?,?,?,?,?,?,?,?,?,?,0,NULL)""",
                    (art["guid"], art["source_name"], art["source_url"], art["category"],
                     art["title"], art["url"], art["published_at"], art["fetched_at"],
                     art["snippet"], art["body"])
                )
                new_articles.append({**art, "id": cur.lastrowid})
            except Exception:
                pass  # UNIQUE constraint = already exists
        await db.commit()
    return new_articles


async def run_fetch_cycle():
    """Main fetch loop: pull all enabled sources across all users, store new articles, broadcast via WS."""
    from settings_manager import get_all_enabled_sources
    enabled = await get_all_enabled_sources()
    if not enabled:
        return
    tasks = [fetch_feed(s) for s in enabled]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    all_articles = []
    for r in results:
        if isinstance(r, list):
            all_articles.extend(r)

    new_ones = await store_articles(all_articles)
    for art in new_ones:
        await ws_manager.broadcast({"type": "new_article", "article": art})

    return len(new_ones)


async def get_article_body_full(url: str) -> str:
    """Fetch full article body from URL on demand."""
    return await fetch_body(url)
