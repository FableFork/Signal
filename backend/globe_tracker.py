"""
Globe tracking: live commercial flights (OpenSky) + vessels (aisstream.io WebSocket).
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
_last_flight_history_write: datetime | None = None  # throttle to every 10min

_vessels: dict = {}          # mmsi → vessel dict
_vessels_updated: str | None = None
_last_vessel_history_write: dict = {}  # mmsi → last write time (5min throttle)

_ais_task: asyncio.Task | None = None
_ais_api_key: str = ""

FLIGHT_HISTORY_HOURS = 12
VESSEL_HISTORY_HOURS = 48
FLIGHT_HISTORY_INTERVAL_MIN = 10
VESSEL_HISTORY_INTERVAL_MIN = 5


# ─── Flights (OpenSky Network — no API key needed) ────────────────────────────

OPENSKY_URL = "https://opensky-network.org/api/states/all"

# Known cargo operator prefixes for type labelling
CARGO_PREFIXES = {
    "UPS", "FDX", "ABX", "ATN", "GTI", "CLX", "MPH", "DHL",
    "DHX", "TNT", "PAC", "KZR", "SQC", "NCA", "CKS", "KLM",
}


async def refresh_flights() -> None:
    global _flights, _flights_updated, _last_flight_history_write
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(OPENSKY_URL, headers={"User-Agent": "SIGNAL/1.0"})
        data = resp.json()
        states = data.get("states") or []

        result = []
        for s in states:
            if len(s) < 11:
                continue
            callsign = (s[1] or "").strip()
            if not callsign:
                continue
            if s[8]:  # on_ground
                continue
            lat, lng = s[6], s[5]
            if not lat or not lng:
                continue

            alt_m = s[7] or s[13] or 0
            if alt_m < 1500:  # exclude takeoff/landing clutter
                continue

            vel_ms = s[9] or 0
            heading = s[10]
            prefix = callsign[:3].upper()
            is_cargo = prefix in CARGO_PREFIXES

            result.append({
                "icao24": s[0],
                "callsign": callsign,
                "country": s[2] or "",
                "lat": round(lat, 4),
                "lng": round(lng, 4),
                "altitude_ft": round(alt_m * 3.281) if alt_m else None,
                "speed_kts": round(vel_ms * 1.944) if vel_ms else None,
                "heading": round(heading) if heading is not None else None,
                "is_cargo": is_cargo,
            })

        _flights = result
        _flights_updated = datetime.now(timezone.utc).isoformat()
        logger.info(f"Flights: {len(result)} aircraft (cargo+passenger)")

        # Write history every FLIGHT_HISTORY_INTERVAL_MIN minutes
        now = datetime.now(timezone.utc)
        if (_last_flight_history_write is None or
                (now - _last_flight_history_write).total_seconds() >= FLIGHT_HISTORY_INTERVAL_MIN * 60):
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
              f["heading"], f["altitude_ft"], f["speed_kts"], ts)
             for f in flights]
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


# ─── Vessels (aisstream.io WebSocket) ─────────────────────────────────────────

AIS_BBOXES = [
    [[10.0, 38.0], [26.0, 46.0]],   # Red Sea + Bab-el-Mandeb
    [[8.0,  42.0], [16.0, 65.0]],   # Gulf of Aden
    [[22.0, 47.0], [30.0, 62.0]],   # Persian Gulf + Hormuz
    [[-2.0, 95.0], [8.0, 108.0]],   # Strait of Malacca
    [[6.0, -82.0], [12.0, -74.0]],  # Panama Canal approach
    [[-38.0,16.0], [32.0,  36.0]],  # Suez / Eastern Med
    [[-60.0,-70.0],[-10.0, 20.0]],  # Cape of Good Hope
]

VESSEL_TYPES = set(range(70, 90))  # tankers, bulk, container, general cargo


async def _write_vessel_history(mmsi: str, v: dict, recorded_at: datetime) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO vessel_history (mmsi, lat, lng, heading, speed_kts, recorded_at) VALUES (?,?,?,?,?,?)",
            (mmsi, v.get("lat"), v.get("lng"), v.get("heading"), v.get("speed_kts"),
             recorded_at.isoformat())
        )
        await db.commit()


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


async def _ais_ws_loop(api_key: str) -> None:
    global _vessels, _vessels_updated, _last_vessel_history_write
    import websockets

    subscribe = json.dumps({
        "APIKey": api_key,
        "BoundingBoxes": AIS_BBOXES,
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    })

    while True:
        try:
            async with websockets.connect(
                "wss://stream.aisstream.io/v0/stream",
                ping_interval=30,
                ping_timeout=10,
            ) as ws:
                await ws.send(subscribe)
                logger.info("AIS WebSocket connected")
                prune_counter = 0

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                        mtype = msg.get("MessageType")
                        meta = msg.get("MetaData", {})
                        mmsi = str(meta.get("MMSI", ""))
                        if not mmsi:
                            continue

                        if mtype == "PositionReport":
                            pos = msg.get("Message", {}).get("PositionReport", {})
                            ship_type = int(meta.get("ShipType") or 0)
                            if ship_type not in VESSEL_TYPES and ship_type != 0:
                                continue

                            now = datetime.now(timezone.utc)
                            entry = _vessels.get(mmsi, {})
                            entry.update({
                                "mmsi": mmsi,
                                "lat": round(meta.get("latitude", 0), 4),
                                "lng": round(meta.get("longitude", 0), 4),
                                "heading": pos.get("TrueHeading") or pos.get("Cog"),
                                "speed_kts": pos.get("Sog"),
                                "ship_type": ship_type,
                                "updated": now.isoformat(),
                            })
                            _vessels[mmsi] = entry
                            _vessels_updated = now.isoformat()

                            # Write history every VESSEL_HISTORY_INTERVAL_MIN per vessel
                            last = _last_vessel_history_write.get(mmsi)
                            if last is None or (now - last).total_seconds() >= VESSEL_HISTORY_INTERVAL_MIN * 60:
                                asyncio.create_task(_write_vessel_history(mmsi, entry, now))
                                _last_vessel_history_write[mmsi] = now

                        elif mtype == "ShipStaticData":
                            static = msg.get("Message", {}).get("ShipStaticData", {})
                            entry = _vessels.get(mmsi, {})
                            entry.update({
                                "mmsi": mmsi,
                                "name": (meta.get("ShipName") or static.get("Name") or "").strip(),
                                "ship_type": int(static.get("Type") or meta.get("ShipType") or 0),
                                "destination": (static.get("Destination") or "").strip(),
                                "flag": meta.get("Flag") or "",
                                "callsign": (static.get("CallSign") or "").strip(),
                            })
                            _vessels[mmsi] = entry

                    except Exception:
                        pass

                    # Prune stale positions and old history periodically
                    prune_counter += 1
                    if prune_counter >= 500:
                        prune_counter = 0
                        cutoff_iso = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
                        _vessels = {k: v for k, v in _vessels.items() if v.get("updated", "") >= cutoff_iso}
                        asyncio.create_task(_prune_vessel_history())

        except Exception as e:
            logger.warning(f"AIS WebSocket error: {e} — reconnecting in 30s")
            await asyncio.sleep(30)


async def start_ais_stream(api_key: str) -> None:
    global _ais_task, _ais_api_key
    if not api_key:
        return
    if api_key == _ais_api_key and _ais_task and not _ais_task.done():
        return
    _ais_api_key = api_key
    if _ais_task and not _ais_task.done():
        _ais_task.cancel()
    _ais_task = asyncio.create_task(_ais_ws_loop(api_key))
    logger.info("AIS stream task started")


# ─── Public getters ───────────────────────────────────────────────────────────

def get_flights_data() -> dict:
    return {"flights": _flights, "updated_at": _flights_updated, "count": len(_flights)}


def get_vessels_data() -> dict:
    vessels = [v for v in _vessels.values() if v.get("lat") and v.get("lng")]
    return {"vessels": vessels, "updated_at": _vessels_updated, "count": len(vessels)}
