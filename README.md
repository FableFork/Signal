# SIGNAL — Trading Intelligence

Real-time news intelligence, AI analysis, position tracking, and daily market digests.

## Stack
- **Frontend**: React + Tailwind CSS (Vite 4)
- **Backend**: FastAPI + SQLite + APScheduler
- **AI**: Anthropic Claude API
- **Prices**: yfinance (no API key needed)
- **Charts**: TradingView embedded widget

---

## Local Development

### 1. Backend
```bash
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

### 2. Frontend
```bash
cd frontend
npm install
npm run dev -- --port 5173
```

Open **http://localhost:5173**

### One-liner (Windows)
Double-click `start-dev.bat` — opens backend and frontend in separate terminal windows.

### First-run setup
1. Go to **Settings**
2. Paste your Anthropic API key
3. Verify or edit RSS sources
4. Click **Save All**

The news feed starts auto-fetching immediately. The first articles appear within ~10 seconds.

---

## Configuration (Settings tab)

| Setting | Default | Notes |
|---|---|---|
| Anthropic API key | — | Required for AI analysis and daily digest |
| Claude model | `claude-sonnet-4-20250514` | |
| Fetch interval | 10s | How often RSS feeds are polled |
| Conviction threshold | 7 | Hides AI signals below this in feed |
| Min R/R ratio | 3.0 | Calculator highlights red below this |
| Morning digest | 08:00 Asia/Dubai | |
| Afternoon digest | 17:00 Asia/Dubai | |

---

## How it works

### Signal Feed (Dashboard left)
- RSS feeds polled every N seconds
- New articles pushed via WebSocket — no page refresh needed
- **Hover** any card for a preview pane
- **Click** to open full article + run AI analysis on demand
- AI results cached in SQLite — never re-calls API for same article

### Daily Digest (Daily tab)
- One Claude call per scheduled run
- Covers: breaking news, macro, geopolitical, energy, metals, equities, crypto
- Generates a suggested watchlist with directional bias
- Each watchlist item has a "Chart" button that loads TradingView

### Calculator
- Live price auto-fetch via yfinance
- Enter margin + leverage + stop/target
- Outputs exposure, risk $, reward $, R/R ratio, liquidation price
- R/R highlighted red if below minimum threshold
- Save/load named setups

### Positions
- Manual position tracking
- Live P/L updated from yfinance every 30s
- Total portfolio P/L shown at top

### TradingView
- Embedded dark-theme chart
- Symbol controlled by clicking instruments in AI analysis results
- Or the watchlist in Daily tab
- Or typing directly

---

## Docker (production)

```bash
cp .env.example .env
# Add ANTHROPIC_API_KEY to .env

docker-compose up --build
```

Frontend serves on port 80, backend on 8000. SQLite database persisted via Docker volume.

---

## Notes
- **Windows ARM64**: Vite 4 is used (not 5) because rollup 4's native ARM64 Windows binaries conflict with emulated Node.js on this machine. Docker builds use Linux so this isn't an issue there.
- Settings changes apply immediately without restart.
- Theme colors update live via CSS variables — no reload needed.
