"""
Globe tracking: live commercial flights (OpenSky) + vessels (aisstream.io snapshot).
Both refresh every 15 minutes. Vessels use a 45-second WebSocket snapshot with global
bounding box instead of a persistent connection — lighter on the Pi and gives full coverage.
Writes position history to DB — 48h for vessels, 12h for flights.
"""
import asyncio
import json
import logging
from datetime import datetime, timezone, timedelta

import httpx
import aiosqlite
from database import DB_PATH

logger = logging.getLogger(__name__)

# ─── In-memory caches ─────────────────────────────────────────────────────────

_flights: list = []
_flights_updated: str | None = None
_last_flight_history_write: datetime | None = None

_vessels: dict = {}          # mmsi → vessel dict
_vessels_updated: str | None = None
_last_vessel_history_write: dict = {}  # mmsi → last write time

_ais_api_key: str = ""

FLIGHT_HISTORY_HOURS = 12
VESSEL_HISTORY_HOURS = 48
HISTORY_WRITE_INTERVAL_MIN = 15   # match the refresh interval

AIS_SNAPSHOT_SECONDS = 45         # how long to collect per refresh cycle
AIS_MAX_VESSELS = 3000            # cap to avoid runaway memory


# ─── Flights (OpenSky Network — no API key, global) ───────────────────────────

OPENSKY_URL = "https://opensky-network.org/api/states/all"

CARGO_PREFIXES = {
    "UPS", "FDX", "ABX", "ATN", "GTI", "CLX", "MPH", "DHL",
    "DHX", "TNT", "PAC", "KZR", "SQC", "NCA", "CKS",
}


async def refresh_flights() -> None:
    global _flights, _flights_updated, _last_flight_history_write
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            resp = await client.get(OPENSKY_URL, headers={"User-Agent": "SIGNAL/1.0"})
        data = resp.json()
        states = data.get("states") or []

        result = []
        for s in states:
            if len(s) < 11:
                continue
            callsign = (s[1] or "").strip()
            if not callsign or s[8]:  # skip empty callsign or on_ground
                continue
            lat, lng = s[6], s[5]
            if not lat or not lng:
                continue
            alt_m = s[7] or s[13] or 0
            if alt_m < 1500:
                continue
            vel_ms = s[9] or 0
            heading = s[10]
            result.append({
                "icao24": s[0],
                "callsign": callsign,
                "country": s[2] or "",
                "lat": round(lat, 4),
                "lng": round(lng, 4),
                "altitude_ft": round(alt_m * 3.281) if alt_m else None,
                "speed_kts": round(vel_ms * 1.944) if vel_ms else None,
                "heading": round(heading) if heading is not None else None,
                "is_cargo": callsign[:3].upper() in CARGO_PREFIXES,
            })

        _flights = result
        _flights_updated = datetime.now(timezone.utc).isoformat()
        logger.info(f"Flights: {len(result)} aircraft")

        now = datetime.now(timezone.utc)
        if (_last_flight_history_write is None or
                (now - _last_flight_history_write).total_seconds() >= HISTORY_WRITE_INTERVAL_MIN * 60):
            await _write_flight_history(result, now)
            _last_flight_history_write = now
            await _prune_flight_history()

    except Exception as e:
        logger.warning(f"OpenSky fetch error: {e}")


async def _write_flight_history(flights: list, recorded_at: datetime) -> None:
    ts = recorded_at.isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executemany(
            "INSERT INTO flight_history (icao24, callsign, lat, lng, heading, altitude_ft, speed_kts, recorded_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            [(f["icao24"], f["callsign"], f["lat"], f["lng"],
              f["heading"], f["altitude_ft"], f["speed_kts"], ts) for f in flights]
        )
        await db.commit()


async def _prune_flight_history() -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=FLIGHT_HISTORY_HOURS)).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM flight_history WHERE recorded_at < ?", (cutoff,))
        await db.commit()


async def get_flight_history(icao24: str) -> list:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=FLIGHT_HISTORY_HOURS)).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT lat, lng, heading, altitude_ft, speed_kts, recorded_at "
            "FROM flight_history WHERE icao24=? AND recorded_at >= ? ORDER BY recorded_at ASC",
            (icao24, cutoff)
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ─── Vessels (aisstream.io — 45s snapshot, global) ────────────────────────────

VESSEL_TYPES = set(range(70, 90))  # tankers, bulk, container, general cargo


async def refresh_vessels() -> None:
    global _vessels, _vessels_updated, _last_vessel_history_write
    if not _ais_api_key:
        logger.debug("Vessel refresh skipped: no AIS API key")
        return

    import websockets

    subscribe = json.dumps({
        "APIKey": _ais_api_key,
        "BoundingBoxes": [[[-90.0, -180.0], [90.0, 180.0]]],  # global
        "FilterMessageTypes": ["PositionReport"],
    })

    snapshot: dict = {}
    try:
        async with websockets.connect(
            "wss://stream.aisstream.io/v0/stream",
            ping_interval=20,
            ping_timeout=10,
            open_timeout=15,
        ) as ws:
            await ws.send(subscribe)
            deadline = asyncio.get_event_loop().time() + AIS_SNAPSHOT_SECONDS
            logger.info("AIS snapshot started (global, 45s)")

            while asyncio.get_event_loop().time() < deadline:
                if len(snapshot) >= AIS_MAX_VESSELS:
                    break
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    msg = json.loads(raw)
                    if msg.get("MessageType") != "PositionReport":
                        continue
                    meta = msg.get("MetaData", {})
                    pos = msg.get("Message", {}).get("PositionReport", {})
                    mmsi = str(meta.get("MMSI", ""))
                    if not mmsi:
                        continue
                    ship_type = int(meta.get("ShipType") or 0)
                    if ship_type not in VESSEL_TYPES and ship_type != 0:
                        continue
                    lat = meta.get("latitude")
                    lng = meta.get("longitude")
                    if not lat or not lng:
                        continue
                    existing = _vessels.get(mmsi, {})
                    snapshot[mmsi] = {
                        "mmsi": mmsi,
                        "name": existing.get("name", ""),
                        "ship_type": ship_type,
                        "destination": existing.get("destination", ""),
                        "flag": existing.get("flag", ""),
                        "callsign": existing.get("callsign", ""),
                        "lat": round(lat, 4),
                        "lng": round(lng, 4),
                        "heading": pos.get("TrueHeading") or pos.get("Cog"),
                        "speed_kts": pos.get("Sog"),
                        "updated": datetime.now(timezone.utc).isoformat(),
                    }
                except asyncio.TimeoutError:
                    break
                except Exception:
                    pass

    except Exception as e:
        logger.warning(f"AIS snapshot error: {e}")

    if snapshot:
        _vessels.update(snapshot)
        _vessels_updated = datetime.now(timezone.utc).isoformat()
        logger.info(f"Vessels: {len(snapshot)} positions collected ({len(_vessels)} total cached)")

        now = datetime.now(timezone.utc)
        async with aiosqlite.connect(DB_PATH) as db:
            rows = []
            for mmsi, v in snapshot.items():
                last = _last_vessel_history_write.get(mmsi)
                if last is None or (now - last).total_seconds() >= HISTORY_WRITE_INTERVAL_MIN * 60:
                    rows.append((mmsi, v["lat"], v["lng"], v["heading"], v["speed_kts"], now.isoformat()))
                    _last_vessel_history_write[mmsi] = now
            if rows:
                await db.executemany(
                    "INSERT INTO vessel_history (mmsi, lat, lng, heading, speed_kts, recorded_at) VALUES (?,?,?,?,?,?)",
                    rows
                )
                await db.commit()
        await _prune_vessel_history()


async def _prune_vessel_history() -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=VESSEL_HISTORY_HOURS)).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM vessel_history WHERE recorded_at < ?", (cutoff,))
        await db.commit()


async def get_vessel_history(mmsi: str) -> list:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=VESSEL_HISTORY_HOURS)).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT lat, lng, heading, speed_kts, recorded_at "
            "FROM vessel_history WHERE mmsi=? AND recorded_at >= ? ORDER BY recorded_at ASC",
            (mmsi, cutoff)
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


def set_ais_key(key: str) -> None:
    global _ais_api_key
    _ais_api_key = key


# ─── Public getters ───────────────────────────────────────────────────────────

def get_flights_data() -> dict:
    return {"flights": _flights, "updated_at": _flights_updated, "count": len(_flights)}


def get_vessels_data() -> dict:
    vessels = [v for v in _vessels.values() if v.get("lat") and v.get("lng")]
    return {"vessels": vessels, "updated_at": _vessels_updated, "count": len(vessels)}
