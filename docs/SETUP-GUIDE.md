# Crucix Intelligence Engine — Setup and Configuration Guide

This guide walks through configuring the **Crucix Intelligence Engine**, using the interactive setup wizard, managing the `.env` configuration file, and connecting Telegram, Discord, AI/LLM models, and free OSINT API keys.

---

## ⚡ Quick Setup (Interactive Wizard)

Starting with v2.38.0, Crucix includes a built-in interactive setup assistant that walks you through configuring your environment, tests notification connections, and automatically creates or updates `.env`.

Run in your terminal:

```bash
# Using the standalone binary:
crucix setup

# Or running from source:
npm run setup
```

*(If you run `crucix` for the first time without arguments on a system with no `.env` file, the setup wizard will launch automatically.)*

---

## 📁 Where is `.env` stored?

Crucix searches for `.env` in the following order:

1. `CRUCIX_ENV_FILE` environment variable (if specified)
2. Current working directory `.env`
3. Repository root `.env`
4. **User Profile Directory**:
   - Windows: `C:\Users\<User>\.crucix\.env`
   - Linux / macOS: `~/.crucix/.env`

> **💡 Note:** The standalone native executable (`crucix.exe` / `crucix`) defaults to `%USERPROFILE%\.crucix\.env` (or `~/.crucix/.env`), allowing you to run it from any directory while keeping your configuration and data intact.

---

## 📱 Telegram Alerts & Two-Way Bot Control

Crucix can send instant alerts on critical geopolitical, economic, and cyber events, and accepts remote two-way commands.

### 1. Create a Telegram Bot (1 minute)
1. Open **[@BotFather](https://t.me/BotFather)** in Telegram.
2. Send: `/newbot`
3. Enter a display name (e.g. `Crucix Intelligence Alert`).
4. Enter a username ending in `bot` (e.g. `my_crucix_alert_bot`).
5. Copy the HTTP API token (format: `7123456789:AAFlkjhGFD...`).
6. This is your `TELEGRAM_BOT_TOKEN`.

### 2. Get your Chat ID (30 seconds)
1. Open **[@userinfobot](https://t.me/userinfobot)** in Telegram and tap Start.
2. Note your numeric **`Id`** (e.g. `123456789`).
3. This is your `TELEGRAM_CHAT_ID`.
4. **Important:** Open your newly created bot in Telegram and tap **START** so it has permission to message you.

### 3. Add to `.env`:
```env
TELEGRAM_BOT_TOKEN=7123456789:AAFlkjhGFD...
TELEGRAM_CHAT_ID=123456789
ALERT_NOTIFY_CHANNELS=telegram
```

### 4. Available Bot Commands:
- `/brief` — Executive intelligence briefing
- `/status` — System health and status of all 71 OSINT data sources
- `/sweep` — Trigger an immediate sweep cycle
- `/alerts` — List active alerts
- `/mute 2h` — Mute alerts for 2 hours

---

## 💬 Discord Webhook Alerts

For Discord channels, no custom bot setup on Discord Developer Portal is required. Direct webhooks are supported:

### 1. Create a Discord Webhook:
1. In your Discord server, open **Channel Settings** (gear icon) next to the target text channel.
2. Go to **Integrations** -> **Webhooks** -> **New Webhook**.
3. Name it (e.g. `Crucix OSINT`) and click **Copy Webhook URL**.

### 2. Add to `.env`:
```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1234567890/abcdefgh...
ALERT_NOTIFY_CHANNELS=discord
# Or both channels:
ALERT_NOTIFY_CHANNELS=telegram,discord
```

---

## 🤖 Artificial Intelligence (AI / LLM) Engine

Crucix includes heuristic and rule-based evaluation by default. Enabling an LLM adds automated trade idea generation, breaking news synthesis, and cited intelligence briefings.

### Supported Providers (`LLM_PROVIDER`):

| Provider | Configuration | Highlights |
| :--- | :--- | :--- |
| **`cursor`** | `LLM_PROVIDER=cursor` | **Zero configuration!** Connects directly to your Cursor IDE active model. |
| **`ollama`** | `LLM_PROVIDER=ollama`<br>`OLLAMA_BASE_URL=http://localhost:11434`<br>`LLM_MODEL=llama3.1:8b` | **100% private, local, and free.** Runs completely offline on your hardware. |
| **`openai-compatible`** | `LLM_PROVIDER=openai-compatible`<br>`LLM_BASE_URL=http://localhost:1234/v1` | For LM Studio, llama.cpp, or vLLM servers. |
| **`anthropic`** | `LLM_PROVIDER=anthropic`<br>`LLM_API_KEY=sk-ant-...` | Claude 3.5 / 3.7 Sonnet for high-precision analytical reporting. |
| **`openai`** | `LLM_PROVIDER=openai`<br>`LLM_API_KEY=sk-...` | GPT-4o / GPT-5 models. |
| **`gemini`** | `LLM_PROVIDER=gemini`<br>`LLM_API_KEY=AIzaSy...` | Google Gemini Flash / Pro models. |
| **`none`** *(default)* | `LLM_PROVIDER=` | Fast, rules-only execution with zero external requests and zero cost. |

---

## 🌐 Free OSINT & Geopolitical API Keys

Most Crucix data sources work out of the box **without any API keys**:
- ✅ USGS & EMSC Earthquakes
- ✅ 539 Global RSS/Atom feeds from 191+ countries
- ✅ CISA KEV & ThreatFox Cyber Indicators
- ✅ UN, World Bank, RIPEstat, IODA Internet Outages
- ✅ Yahoo Finance market indices and commodities

The following optional free API keys increase request limits and resolution:

### 1. NASA FIRMS (Satellite Thermal Anomalies & Wildfires)
- **Sign up:** [firms.modaps.eosdis.nasa.gov/api](https://firms.modaps.eosdis.nasa.gov/api)
- **Cost:** Free.
- **Config:** `FIRMS_MAP_KEY=a1b2c3d4e5f6...`

### 2. FRED (Federal Reserve Economic Data)
- **Sign up:** [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html)
- **Cost:** Free.
- **Config:** `FRED_API_KEY=abcdef123456...`

### 3. EIA (Energy Information Administration — Crude, Gas & Electricity)
- **Sign up:** [api.eia.gov/register](https://api.eia.gov/register)
- **Cost:** Free.
- **Config:** `EIA_API_KEY=fedcba654321...`

### 4. AISStream (Live Maritime Vessel & Chokepoint Tracking)
- **Sign up:** [aisstream.io/account](https://aisstream.io/account) (Sign in with GitHub)
- **Cost:** Free.
- **Config:** `AISSTREAM_API_KEY=...`

### 5. Cloudflare Radar (Global Outages & Traffic Anomalies)
- **Sign up:** [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) (Account Analytics Read token)
- **Cost:** Free.
- **Config:** `CLOUDFLARE_API_TOKEN=...`

---

## 🖥️ Server and Network Settings

```env
# Dashboard & REST API port (default: 3117)
PORT=3117

# Network binding:
# 127.0.0.1  = Local host only (secure)
# 0.0.0.0    = Accessible across your Local Area Network (LAN)
HOST=127.0.0.1

# Language for CLI output and reports: en | hu | fr
CRUCIX_LANG=en

# Background sweep refresh interval in minutes (default: 15)
REFRESH_INTERVAL_MINUTES=15
```

---

## 🚀 Standalone Local Installation

To build and install the binary globally into your user profile:

```bash
# Build and install to ~/.local/bin:
npm run install:local

# Install and immediately start the setup wizard:
npm run install:local -- --setup
```

Then run anywhere:
```bash
crucix -b           # Executive briefing
crucix -m           # Markets and commodities
crucix setup        # Re-run setup wizard at any time
```
