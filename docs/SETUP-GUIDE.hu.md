# Crucix Intelligence Engine — Beállítási és Konfigurációs Útmutató (Setup Guide)

Ez az útmutató lépésről lépésre bemutatja a **Crucix** beállítását, az interaktív varázsló használatát, a `.env` konfigurációs fájl felépítését, valamint a Telegram, Discord, Mesterséges Intelligencia (AI) és ingyenes OSINT API kulcsok beállítását.

---

## ⚡ Gyors Beállítás (1-Kattintásos Webes Felület vagy Terminálos Varázsló)

A kényelmes beállítás érdekében **nem kell kézzel linkeket másolgatni a böngészőbe**. A Crucix közvetlenül a böngészőben nyitja meg a szükséges botokat és regisztrációs oldalakat, vagy egy kényelmes, 1-kattintásos grafikus felületet indít el:

```bash
# 🌐 1-Kattintásos webes beállító központ (Ajánlott):
crucix setup
# vagy közvetlenül a webes felület indítása:
crucix setup --web

# 💻 Szöveges terminálos varázsló (automatikus böngésző-megnyitással):
crucix setup --cli

# Node.js forrásból futtatva:
npm run setup
```

Ha a Crucix éles szervere már fut a háttérben (`crucix --serve` vagy `npm start`), a beállító központ a böngészőből közvetlenül elérhető:
👉 **`http://localhost:3117/setup.html`** (vagy a dashboard fejlécében a **🔑 Keys & Setup** gombra kattintva).

*(Ha a `crucix` parancsot először futtatod egy új gépen és még nincs `.env` fájlod, a rendszer automatikusan felajánlja a varázsló elindítását!)*

---

## 📁 Hol található a `.env` konfigurációs fájl?

A Crucix a következő sorrendben keresi a konfigurációt:

1. `CRUCIX_ENV_FILE` környezeti változó által mutatott fájl (ha meg van adva)
2. Az aktuális munkakönyvtár `.env` fájlja
3. A projekt gyökérkönyvtára (`.env`)
4. **Felhasználói profilkönyvtár**:
   - Windows: `C:\Users\<Felhasználó>\.crucix\.env`
   - Linux / macOS: `~/.crucix/.env`

> **💡 Megjegyzés:** A natív önálló bináris (`crucix.exe`) a `%USERPROFILE%\.crucix\.env` fájlt használja, így bárhonnan futtathatod, mindig a saját beállításaidat és adatbázisodat éri el.

---

## 📱 Telegram Riasztások és Kétirányú Bot Vezérlés

A Crucix képes valós időben Telegram üzeneteket küldeni kritikus geopolitikai eseményekről (földrengések, piaci zuhanás, katonai eszkaláció, internetkimaradások), és kétirányú parancsokkal távolról is lekérdezhető.

### 1. Telegram Bot létrehozása (1 perc)
1. Nyisd meg a Telegramban a hivatalos **[@BotFather](https://t.me/BotFather)** botot.
2. Küldd el neki: `/newbot`
3. Adj meg egy megjelenített nevet (pl. `Crucix Intelligence Alert`).
4. Adj meg egy felhasználónevet, amelynek `bot`-ra kell végződnie (pl. `my_crucix_alert_bot`).
5. A BotFather kiír egy API Tokent (pl. `7123456789:AAFlkjhGFD...`).
6. Másold ki ezt a tokent: ez a `TELEGRAM_BOT_TOKEN`.

### 2. Saját Chat ID lekérése (30 másodperc)
1. Nyisd meg a Telegramban a **[@userinfobot](https://t.me/userinfobot)**-ot, és nyomj a Start gombra.
2. A bot kiírja az adataidat: keresd meg az **`Id`** sort (pl. `123456789`).
3. Másold ki ezt a számot: ez a `TELEGRAM_CHAT_ID`.
4. **Fontos:** Nyisd meg a saját, frissen létrehozott botodat is, és nyomj a **START** gombra (különben a bot nem küldhet neked üzenetet).

### 3. Beállítás a `.env`-ben:
```env
TELEGRAM_BOT_TOKEN=7123456789:AAFlkjhGFD...
TELEGRAM_CHAT_ID=123456789
ALERT_NOTIFY_CHANNELS=telegram
```

### 4. Elérhető Telegram Bot Parancsok:
- `/brief` — Friss vezetői intelligencia összefoglaló
- `/status` — Rendszerállapot és a 71 OSINT adatforrás vizsgálata
- `/sweep` — Azonnali elemzési és adatgyűjtési ciklus indítása
- `/alerts` — Aktív riasztások listázása
- `/mute 2h` — Riasztások némítása 2 órára

---

## 💬 Discord Webhook Riasztások

Ha Discord szerveren szeretnéd látni a riasztásokat, nem szükséges külön botot regisztrálnod a Discord Developer Portalon; a Crucix támogatja a közvetlen Webhook integrációt:

### 1. Webhook létrehozása a Discordban:
1. Kattints a célcsatorna melletti **Fogaskerék (Csatorna beállítások)** ikonra.
2. Válaszd az **Integrációk (Integrations)** fület.
3. Kattints a **Webhookok (Webhooks)** -> **Új Webhook (New Webhook)** gombra.
4. Adj nevet neki (pl. `Crucix OSINT`), és válaszd a **Webhook URL másolása (Copy Webhook URL)** gombot.

### 2. Beállítás a `.env`-ben:
```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1234567890/abcdefgh...
ALERT_NOTIFY_CHANNELS=discord
# Vagy mindkettő együtt:
ALERT_NOTIFY_CHANNELS=telegram,discord
```

---

## 🤖 Mesterséges Intelligencia (AI / LLM) Motor

A Crucix beépített heurisztikákkal és szabályrendszerrel dolgozik, de mesterséges intelligenciával kiegészítve képes:
- Piaci kereskedési ötleteket és összefüggéseket generálni
- Eseményeket szövegesen elemezni
- Vezetői hírszerzési jelentéseket fogalmazni

### Választható AI szolgáltatók (`LLM_PROVIDER`):

| Szolgáltató | Beállítás | Előny |
| :--- | :--- | :--- |
| **`cursor`** | `LLM_PROVIDER=cursor` | **Zero-config!** A Cursor IDE beépített modelljét használja, nincs szükség külön API kulcsra. |
| **`ollama`** | `LLM_PROVIDER=ollama`<br>`OLLAMA_BASE_URL=http://localhost:11434`<br>`LLM_MODEL=llama3.1:8b` | **100% privát, helyi, ingyenes.** Teljesen offline fut a gépeden. |
| **`openai-compatible`** | `LLM_PROVIDER=openai-compatible`<br>`LLM_BASE_URL=http://localhost:1234/v1` | LM Studio, llama.cpp vagy vLLM helyi szerverekhez. |
| **`anthropic`** | `LLM_PROVIDER=anthropic`<br>`LLM_API_KEY=sk-ant-...` | Claude 3.5 / 3.7 Sonnet (a legmagasabb szövegelemzési minőség). |
| **`openai`** | `LLM_PROVIDER=openai`<br>`LLM_API_KEY=sk-...` | GPT-4o / GPT-5 modellek. |
| **`gemini`** | `LLM_PROVIDER=gemini`<br>`LLM_API_KEY=AIzaSy...` | Google Gemini Flash / Pro modellek. |
| **`none`** *(alap)* | `LLM_PROVIDER=` | Külső AI nélküli működés. 100% szabályalapú, zéró erőforrás-igény és azonnali válaszidő. |

---

## 🌐 Ingyenes Geopolitikai & OSINT API Kulcsok

A Crucix több tucat forrása **kulcs nélkül is azonnal működik**:
- ✅ USGS és EMSC Földrengések (kulcsmentes)
- ✅ 539 globális hírforrás 191+ országból (kulcsmentes RSS/Atom)
- ✅ CISA KEV és ThreatFox kiberbiztonság (kulcsmentes)
- ✅ ENSZ, Világbank, RIPEstat, IODA internetkimaradások (kulcsmentes)
- ✅ YFinance piaci adatok és árfolyamok (kulcsmentes)

Az alábbi ingyenes regisztrációkkal növelheted az adatfrissítés sebességét és a lekérdezési limiteket:

### 1. NASA FIRMS (Műholdas hőtérkép és tűzérzékelés)
- **Hol kérhető:** [firms.modaps.eosdis.nasa.gov/api](https://firms.modaps.eosdis.nasa.gov/api)
- **Ár:** Teljesen ingyenes.
- **Konfiguráció:** `FIRMS_MAP_KEY=a1b2c3d4e5f6...`

### 2. FRED (Federal Reserve Economic Data — Amerikai jegybanki makroadatok)
- **Hol kérhető:** [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html)
- **Ár:** Ingyenes regisztráció után azonnal elérhető.
- **Konfiguráció:** `FRED_API_KEY=abcdef123456...`

### 3. EIA (Energy Information Administration — Olaj, gáz és energiastatisztikák)
- **Hol kérhető:** [api.eia.gov/register](https://api.eia.gov/register)
- **Ár:** Ingyenes.
- **Konfiguráció:** `EIA_API_KEY=fedcba654321...`

### 4. AISStream (Élő globális tengeri hajóforgalom és fojtópontok)
- **Hol kérhető:** [aisstream.io/account](https://aisstream.io/account) (Belépés GitHub fiókkal)
- **Ár:** Ingyenes.
- **Konfiguráció:** `AISSTREAM_API_KEY=...`

### 5. Cloudflare Radar (Globális internetkimaradások és hálózati forgalom)
- **Hol kérhető:** [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) (Account Analytics Read jogosultsággal)
- **Ár:** Ingyenes.
- **Konfiguráció:** `CLOUDFLARE_API_TOKEN=...`

---

## 🖥️ Szerver és Hálózati Beállítások

```env
# Dashboard és REST API port (alapértelmezett: 3117)
PORT=3117

# Hálózati elérhetőség:
# 127.0.0.1  = Csak a helyi gépről érhető el
# 0.0.0.0    = Elérhető a helyi hálózatról (LAN) is (pl. telefonról vagy más PC-ről)
HOST=127.0.0.1

# Kimeneti nyelv a terminálban és jelentésekben: hu | en | fr
CRUCIX_LANG=hu

# Automatikus adatfrissítési ciklus (percekben, alapértelmezett: 15)
REFRESH_INTERVAL_MINUTES=15
```

---

## 🚀 Telepítés a rendszerbe (Standalone .exe)

Ha szeretnéd a gépeden a rendszerbe telepíteni, hogy bárhonnan fusson:

```bash
# Fordítás és telepítés a felhasználói profilba:
npm run install:local

# Telepítés és azonnali beállító varázsló:
npm run install:local -- --setup
```

Ez a parancs:
1. Lefordítja a legfrissebb, zárt `crucix.exe` natív binárist.
2. Kimásolja a `%USERPROFILE%\.local\bin` mappába.
3. Létrehozza a `crucix.cmd` és unix shimeket.
4. Megtisztítja a felhasználói profilt a felesleges forráskódoktól.

Ezután a terminálban egyszerűen:
```bash
crucix -b           # Vezetői összefoglaló
crucix -m           # Piacok és nyersanyagok
crucix setup        # Beállító varázsló újrafuttatása
```
