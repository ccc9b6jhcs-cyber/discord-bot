import os
import json
import threading
import websocket
import requests as r
from flask import Flask, render_template, request, jsonify
from time import sleep, perf_counter
from re import compile
from datetime import datetime

app = Flask(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
config = {
    "cookie": os.environ.get("ROBLOSECURITY", ""),
    "pingall": False,
    "DEBUG_MESSAGES": False,
    "limiteds": [],
    # Minimum discount % required to trigger auto-buy (0 = use per-item max price only)
    "buy_discount_threshold": float(os.environ.get("BUY_DISCOUNT_THRESHOLD", "0")),
}

DISCORD_TOKEN   = os.environ.get("DISCORD_TOKEN", "")
CLIENT_ID       = os.environ.get("CLIENT_ID", "")
CONTROL_CHANNEL = os.environ.get("CONTROL_CHANNEL", "")  # channel ID for sniper control

CHANNEL_IDS = {
    "small":  os.environ.get("SMALL_DEALS_CHANNEL", ""),
    "medium": os.environ.get("MEDIUM_DEALS_CHANNEL", ""),
    "big":    os.environ.get("BIG_DEALS_CHANNEL", ""),
}
PRICE_TRACKER_CHANNEL = os.environ.get("PRICE_TRACKER_CHANNEL", "")
CHANNEL_IDS["tracker"] = PRICE_TRACKER_CHANNEL

# asset_id -> last seen price
price_cache: dict = {}

sniper_running  = False
sniper_thread   = None
results_log     = []
buy_log         = []
x_token         = None
rate_limit      = False

# Cache Rolimons data so we don't hammer it every loop
rolimons_cache      = {}   # asset_id -> value
rolimons_cache_time = 0

# ── Helpers ───────────────────────────────────────────────────────────────────
def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    results_log.append(f"[{ts}] {msg}")
    if len(results_log) > 200:
        results_log.pop(0)

def get_cookie():
    raw = config["cookie"]
    if ".ROBLOSECURITY=_" in raw:
        return "_" + raw.split(".ROBLOSECURITY=_")[1]
    return raw

# ── Rolimons ──────────────────────────────────────────────────────────────────
def refresh_rolimons():
    global rolimons_cache, rolimons_cache_time
    try:
        res = r.get("https://www.rolimons.com/itemapi/itemdetails", timeout=10)
        data = res.json().get("items", {})
        # Rolimons item format: { "asset_id": [name, abbr, demand, trend, projected, hyped, rare, rat, value, ...] }
        # Index 8 = item value (-1 means no value)
        new_cache = {}
        for asset_id, details in data.items():
            val = details[8] if len(details) > 8 else -1
            if val and val > 0:
                new_cache[str(asset_id)] = val
        rolimons_cache = new_cache
        rolimons_cache_time = datetime.now().timestamp()
        log(f"[ROLIMONS] Refreshed — {len(rolimons_cache)} items with values")
    except Exception as e:
        log(f"[ROLIMONS ERROR] {e}")

def get_rolimons_value(asset_id):
    # Refresh every 10 minutes
    if datetime.now().timestamp() - rolimons_cache_time > 600:
        refresh_rolimons()
    return rolimons_cache.get(str(asset_id), None)

# ── Discord ───────────────────────────────────────────────────────────────────
def discord_send(channel_id, embed):
    if not channel_id or not DISCORD_TOKEN:
        return
    try:
        r.post(
            f"https://discord.com/api/v10/channels/{channel_id}/messages",
            headers={
                "Authorization": f"Bot {DISCORD_TOKEN}",
                "Content-Type": "application/json"
            },
            json={"embeds": [embed]}
        )
    except Exception as e:
        log(f"[DISCORD ERROR] {e}")

def post_deal(asset_id, name, listed_price, rolimons_value, discount_pct):
    if discount_pct >= 60:
        tier = "big"
        colour = 0xFF4466   # red
        tier_label = "🔥 BIG DEAL"
    elif discount_pct >= 40:
        tier = "medium"
        colour = 0xFF8800   # orange
        tier_label = "💰 MEDIUM DEAL"
    else:
        tier = "small"
        colour = 0x00FF88   # green
        tier_label = "📉 SMALL DEAL"

    channel_id = CHANNEL_IDS.get(tier, "")
    if not channel_id:
        log(f"[DISCORD] No channel ID set for {tier}-deals — skipping post")
        return

    embed = {
        "title": f"{tier_label} — {name}",
        "url": f"https://www.roblox.com/catalog/{asset_id}",
        "color": colour,
        "fields": [
            {"name": "Listed price",      "value": f"**{listed_price:,} R$**",    "inline": True},
            {"name": "Rolimons value",    "value": f"**{rolimons_value:,} R$**",  "inline": True},
            {"name": "Discount",          "value": f"**{discount_pct:.1f}% off**","inline": True},
            {"name": "Asset ID",          "value": str(asset_id),                 "inline": True},
        ],
        "timestamp": datetime.utcnow().isoformat(),
        "footer": {"text": "Limited Sniper"}
    }
    discord_send(channel_id, embed)
    log(f"[DEAL] {name} — {discount_pct:.1f}% off → #{tier}-deals")

# ── Discord control channel bot (Gateway) ────────────────────────────────────
HELP_TEXT = """```
Sniper control commands:

/start                       — start the sniper
/stop                        — stop the sniper
/status                      — show current status & targets
/add <asset_id> [max_price]  — add item (max_price optional, 0 = alert only)
/remove <asset_id>           — remove item
/setbuy <discount%>          — auto-buy only if discount ≥ this % (0 = off)
/setdebug on|off             — toggle price logging
/list                        — list all tracked items
/help                        — show this message
```"""

def ctrl_reply(content=None, embed=None):
    """Send a message to the control channel."""
    if not CONTROL_CHANNEL or not DISCORD_TOKEN:
        return
    payload = {}
    if content:
        payload["content"] = content
    if embed:
        payload["embeds"] = [embed]
    try:
        r.post(
            f"https://discord.com/api/v10/channels/{CONTROL_CHANNEL}/messages",
            headers={"Authorization": f"Bot {DISCORD_TOKEN}", "Content-Type": "application/json"},
            json=payload
        )
    except Exception as e:
        log(f"[CTRL ERROR] {e}")

def handle_control_message(content):
    """Parse and execute a control command. Returns reply string or None."""
    global sniper_running, sniper_thread
    parts = content.strip().split()
    if not parts:
        return
    cmd = parts[0].lower()

    if cmd == "/help":
        ctrl_reply(content=HELP_TEXT)

    elif cmd == "/start":
        if sniper_running:
            ctrl_reply(content="⚠️ Sniper is already running.")
        elif not config["cookie"]:
            ctrl_reply(content="❌ No cookie set — update `ROBLOSECURITY` env var.")
        else:
            sniper_running = True
            sniper_thread = threading.Thread(target=sniper_loop, daemon=True)
            sniper_thread.start()
            ctrl_reply(content="▶️ Sniper started.")

    elif cmd == "/stop":
        sniper_running = False
        ctrl_reply(content="⏹️ Sniper stopped.")

    elif cmd == "/status":
        threshold = config["buy_discount_threshold"]
        buy_str = f"{threshold:.0f}% off" if threshold > 0 else "disabled (alert-only)"
        lines = [
            f"**Status:** {'🟢 Running' if sniper_running else '🔴 Stopped'}",
            f"**Targets:** {len(config['limiteds'])} item(s)",
            f"**Auto-buy threshold:** {buy_str}",
            f"**Debug logging:** {'on' if config['DEBUG_MESSAGES'] else 'off'}",
        ]
        ctrl_reply(embed={
            "title": "Sniper Status",
            "description": "\n".join(lines),
            "color": 0x00FF88 if sniper_running else 0xFF4466,
            "timestamp": datetime.utcnow().isoformat()
        })

    elif cmd == "/list":
        if not config["limiteds"]:
            ctrl_reply(content="📋 No items tracked.")
            return
        rows = []
        for item in config["limiteds"]:
            rv = rolimons_cache.get(str(item["asset"]))
            rv_str = f"{rv:,} R$" if rv else "no value"
            max_p = item['price'] if int(item.get('price', 0)) > 0 else "—"
            rows.append(f"`{item['asset']}` | max {max_p} R$ | Rolimons: {rv_str} | multi: {'✓' if item.get('buyagain') else '✗'}")
        ctrl_reply(embed={
            "title": f"Tracked Items ({len(config['limiteds'])})",
            "description": "\n".join(rows),
            "color": 0x5865F2
        })

    elif cmd == "/add":
        if len(parts) < 2:
            ctrl_reply(content="Usage: `/add <asset_id> [max_price]`")
            return
        asset_id  = parts[1].strip()
        max_price = parts[2] if len(parts) > 2 else "0"
        ctrl_reply(content=f"🔍 Fetching product ID for `{asset_id}`...")
        try:
            out = r.get(f"https://www.roblox.com/catalog/{asset_id}").text
            product_id = out.split('data-product-id="')[1].split('"')[0]
        except Exception as e:
            ctrl_reply(content=f"❌ Could not fetch product ID: {e}")
            return
        rv = get_rolimons_value(asset_id)
        config["limiteds"] = [l for l in config["limiteds"] if l["asset"] != asset_id]
        config["limiteds"].append({
            "asset": asset_id, "price": max_price,
            "buyagain": False, "productid": product_id
        })
        log(f"[CONFIG] Added {asset_id} via Discord")
        rv_str = f"{rv:,} R$" if rv else "not on Rolimons"
        ctrl_reply(embed={
            "title": "✅ Item Added",
            "color": 0x00FF88,
            "fields": [
                {"name": "Asset ID",        "value": asset_id,   "inline": True},
                {"name": "Max price",       "value": f"{max_price} R$" if int(max_price) > 0 else "alert only", "inline": True},
                {"name": "Rolimons value",  "value": rv_str,     "inline": True},
            ]
        })

    elif cmd == "/remove":
        if len(parts) < 2:
            ctrl_reply(content="Usage: `/remove <asset_id>`")
            return
        asset_id = parts[1].strip()
        before = len(config["limiteds"])
        config["limiteds"] = [l for l in config["limiteds"] if l["asset"] != asset_id]
        if len(config["limiteds"]) < before:
            log(f"[CONFIG] Removed {asset_id} via Discord")
            ctrl_reply(content=f"🗑️ Removed `{asset_id}`.")
        else:
            ctrl_reply(content=f"⚠️ `{asset_id}` not found in tracked items.")

    elif cmd == "/setbuy":
        if len(parts) < 2:
            ctrl_reply(content="Usage: `/setbuy <discount%>` — e.g. `/setbuy 60` to auto-buy at 60%+ off, `/setbuy 0` to disable")
            return
        try:
            pct = float(parts[1].replace("%", ""))
            config["buy_discount_threshold"] = pct
            log(f"[CONFIG] Auto-buy threshold set to {pct}% via Discord")
            if pct == 0:
                ctrl_reply(content="✅ Auto-buy disabled — sniper will alert only.")
            else:
                ctrl_reply(content=f"✅ Auto-buy threshold set to **{pct:.0f}% off**. Items listed at ≥{pct:.0f}% below Rolimons value will be purchased.")
        except ValueError:
            ctrl_reply(content="❌ Invalid number. Example: `/setbuy 60`")

    elif cmd == "/setdebug":
        if len(parts) < 2 or parts[1].lower() not in ("on", "off"):
            ctrl_reply(content="Usage: `/setdebug on` or `/setdebug off`")
            return
        config["DEBUG_MESSAGES"] = parts[1].lower() == "on"
        ctrl_reply(content=f"🔧 Debug logging {'enabled' if config['DEBUG_MESSAGES'] else 'disabled'}.")

    else:
        ctrl_reply(content=f"❓ Unknown command `{cmd}`. Type `/help` for a list.")


# ── Discord Gateway (receives messages) ───────────────────────────────────────
_gateway_ws  = None
_heartbeat_t = None

def _send_json(ws, data):
    ws.send(json.dumps(data))

def _heartbeat(ws, interval):
    while True:
        sleep(interval / 1000)
        try:
            _send_json(ws, {"op": 1, "d": None})
        except Exception:
            break

def _on_message(ws, raw):
    try:
        msg = json.loads(raw)
    except Exception:
        return

    op = msg.get("op")
    t  = msg.get("t")
    d  = msg.get("d", {})

    if op == 10:  # Hello — start heartbeat + identify
        interval = d["heartbeat_interval"]
        global _heartbeat_t
        _heartbeat_t = threading.Thread(target=_heartbeat, args=(ws, interval), daemon=True)
        _heartbeat_t.start()
        _send_json(ws, {
            "op": 2, "d": {
                "token": DISCORD_TOKEN,
                "intents": 512 + 32768,  # GUILD_MESSAGES + MESSAGE_CONTENT
                "properties": {"os": "linux", "browser": "sniper", "device": "sniper"}
            }
        })

    elif op == 0 and t == "MESSAGE_CREATE":
        # Only respond to messages in the control channel
        if str(d.get("channel_id")) != str(CONTROL_CHANNEL):
            return
        # Ignore own messages
        if d.get("author", {}).get("bot"):
            return
        content = d.get("content", "").strip()
        if content.startswith("/"):
            threading.Thread(target=handle_control_message, args=(content,), daemon=True).start()

def _on_error(ws, error):
    log(f"[GATEWAY ERROR] {error}")

def _on_close(ws, *_):
    log("[GATEWAY] Disconnected — reconnecting in 10s...")
    sleep(10)
    start_gateway()

def start_gateway():
    if not DISCORD_TOKEN or not CONTROL_CHANNEL:
        log("[GATEWAY] DISCORD_TOKEN or CONTROL_CHANNEL not set — control bot disabled")
        return
    try:
        gw = r.get("https://discord.com/api/v10/gateway",
                   headers={"Authorization": f"Bot {DISCORD_TOKEN}"}).json()
        url = gw.get("url", "wss://gateway.discord.gg") + "/?v=10&encoding=json"
    except Exception as e:
        log(f"[GATEWAY] Could not get gateway URL: {e}")
        return

    global _gateway_ws
    _gateway_ws = websocket.WebSocketApp(
        url,
        on_message=_on_message,
        on_error=_on_error,
        on_close=_on_close,
    )
    t = threading.Thread(target=_gateway_ws.run_forever, daemon=True)
    t.start()
    log("[GATEWAY] Discord control bot connected")


# ── Price tracker channel ─────────────────────────────────────────────────────
def post_price_change(asset_id, name, old_price, new_price, fetch_ms, rolimons_value):
    if not PRICE_TRACKER_CHANNEL or not DISCORD_TOKEN:
        return
    diff      = old_price - new_price
    diff_pct  = (diff / old_price) * 100 if old_price else 0
    went_up   = new_price > old_price
    arrow     = "🔺" if went_up else "🔻"
    color     = 0xFF4466 if went_up else 0x00FF88

    fields = [
        {"name": "Was",          "value": f"**{old_price:,} R$**",            "inline": True},
        {"name": "Now",          "value": f"**{new_price:,} R$**",            "inline": True},
        {"name": "Change",       "value": f"{arrow} **{abs(diff):,} R$** ({abs(diff_pct):.1f}%)", "inline": True},
        {"name": "Fetch ping",   "value": f"`{fetch_ms:.0f} ms`",             "inline": True},
    ]
    if rolimons_value and rolimons_value > 0:
        discount = (1 - new_price / rolimons_value) * 100
        fields.append({"name": "vs Rolimons", "value": f"{discount:.1f}% off ({rolimons_value:,} R$)", "inline": True})

    embed = {
        "title": f"{arrow} Price change — {name}",
        "url":   f"https://www.roblox.com/catalog/{asset_id}",
        "color": color,
        "fields": fields,
        "timestamp": datetime.utcnow().isoformat(),
        "footer": {"text": "Limited Sniper • price tracker"}
    }
    discord_send(PRICE_TRACKER_CHANNEL, embed)
    log(f"[PRICE CHANGE] {name}: {old_price} → {new_price} R$ ({fetch_ms:.0f}ms fetch)")

def post_buy_result(asset_id, name, price, rolimons_value, fetch_ms, buy_ms, success, reason=""):
    if not PRICE_TRACKER_CHANNEL or not DISCORD_TOKEN:
        return
    total_ms = fetch_ms + buy_ms
    rv = rolimons_value or 0
    dp = (1 - price / rv) * 100 if rv > 0 else 0
    color  = 0x00FF88 if success else 0xFF4466
    status = "✅ BOUGHT" if success else "❌ BUY FAILED"

    fields = [
        {"name": "Price",         "value": f"**{price:,} R$**",              "inline": True},
        {"name": "Rolimons val",  "value": f"{rv:,} R$" if rv else "N/A",    "inline": True},
        {"name": "Discount",      "value": f"{dp:.1f}%" if rv else "N/A",    "inline": True},
        {"name": "Fetch ping",    "value": f"`{fetch_ms:.0f} ms`",           "inline": True},
        {"name": "Buy request",   "value": f"`{buy_ms:.0f} ms`",             "inline": True},
        {"name": "Total latency", "value": f"`{total_ms:.0f} ms`",           "inline": True},
    ]
    if not success and reason:
        fields.append({"name": "Reason", "value": reason, "inline": False})

    embed = {
        "title": f"{status} — {name}",
        "url":   f"https://www.roblox.com/catalog/{asset_id}",
        "color": color,
        "fields": fields,
        "timestamp": datetime.utcnow().isoformat(),
        "footer": {"text": "Limited Sniper • price tracker"}
    }
    discord_send(PRICE_TRACKER_CHANNEL, embed)

# ── X-CSRF token ──────────────────────────────────────────────────────────────
def get_xtoken_loop():
    global x_token
    while True:
        try:
            cookie = get_cookie()
            x_token = r.post(
                "https://auth.roblox.com/v2/logout",
                headers={"cookie": ".ROBLOSECURITY=" + cookie}
            ).headers.get("x-csrf-token")
        except Exception as e:
            log(f"[XTOKEN ERROR] {e}")
        sleep(120)

# ── Snipe one item ────────────────────────────────────────────────────────────
def snipe_item(data):
    global rate_limit
    try:
        asset_id = data["asset"]
        cookie   = get_cookie()

        fetch_start = perf_counter()
        out = r.get(
            f"https://www.roblox.com/catalog/{asset_id}",
            cookies={".ROBLOSECURITY": cookie}
        ).content
        fetch_ms = (perf_counter() - fetch_start) * 1000

        price_pattern = compile(r"data-expected-price=.*")
        price = None
        for m in price_pattern.finditer(str(out)):
            raw = m.group()[21:].split('"')[0]
            if raw:
                price = int(raw)
                break

        if price is None:
            rate_limit = True
            log(f"[RATELIMIT] Asset {asset_id}")
            return

        # ── Item name ────────────────────────────────────────────────────────
        name = str(asset_id)
        try:
            nm = compile(r'<title>(.*?) - Roblox</title>').search(str(out))
            if nm:
                name = nm.group(1).strip()
        except Exception:
            pass

        if config["DEBUG_MESSAGES"]:
            log(f"[PRICE] {name} = {price} R$ ({fetch_ms:.0f}ms)")

        # ── Price change detection ────────────────────────────────────────────
        rolimons_value = get_rolimons_value(asset_id)
        old_price = price_cache.get(str(asset_id))
        if old_price is not None and old_price != price:
            post_price_change(asset_id, name, old_price, price, fetch_ms, rolimons_value)
        price_cache[str(asset_id)] = price

        # ── Discount alert check ──────────────────────────────────────────────
        if rolimons_value and rolimons_value > 0:
            discount_pct = (1 - price / rolimons_value) * 100
            if discount_pct >= 20:
                post_deal(asset_id, name, price, rolimons_value, discount_pct)

        # ── Auto-buy logic ────────────────────────────────────────────────────
        threshold = config["buy_discount_threshold"]
        max_price = int(data.get("price", 0))

        discount_triggered = (
            threshold > 0
            and rolimons_value and rolimons_value > 0
            and (1 - price / rolimons_value) * 100 >= threshold
        )
        price_triggered = max_price > 0 and price <= max_price

        if not discount_triggered and not price_triggered:
            return

        log(f"[FOUND] {name} at {price} R$")

        seller_pattern = compile(r"data-expected-seller-id=.*")
        unique_pattern = compile(r"data-lowest-private-sale-userasset-id.*")

        seller_id = "0"
        for m in seller_pattern.finditer(str(out)):
            seller_id = str(m.group()[24:].split('"')[1])

        unique_id = "0"
        for m in unique_pattern.finditer(str(out)):
            unique_id = str(m.group()[38:].split('"')[1])

        headers = {"cookie": config["cookie"], "x-csrf-token": x_token}
        payload = {
            "expectedCurrency": "1",
            "expectedPrice": str(price),
            "expectedSellerId": seller_id,
            "userAssetId": unique_id
        }

        buy_start = perf_counter()
        check = r.post(
            f"https://economy.roblox.com/v1/purchases/products/{data['productid']}",
            headers=headers, data=payload
        )
        buy_ms = (perf_counter() - buy_start) * 1000

        if check.ok and check.json().get("purchased"):
            item_name = check.json().get("assetName", name)
            log(f"[BUY ✓] {item_name} for {price} R$ — fetch {fetch_ms:.0f}ms buy {buy_ms:.0f}ms")
            buy_log.append({"status": "success", "asset": asset_id, "price": price, "name": item_name,
                            "fetch_ms": round(fetch_ms), "buy_ms": round(buy_ms)})

            post_buy_result(asset_id, item_name, price, rolimons_value, fetch_ms, buy_ms, True)

            rv = rolimons_value or 0
            dp = (1 - price / rv) * 100 if rv > 0 else 0
            if CHANNEL_IDS.get("big") and DISCORD_TOKEN:
                embed = {
                    "title": f"✅ BOUGHT — {item_name}",
                    "url": f"https://www.roblox.com/catalog/{asset_id}",
                    "color": 0x00FF88,
                    "fields": [
                        {"name": "Paid",            "value": f"{price:,} R$",                    "inline": True},
                        {"name": "Rolimons value",  "value": f"{rv:,} R$" if rv else "N/A",      "inline": True},
                        {"name": "Saved",           "value": f"{dp:.1f}%" if rv else "N/A",      "inline": True},
                        {"name": "Total latency",   "value": f"`{fetch_ms+buy_ms:.0f} ms`",      "inline": True},
                    ],
                    "timestamp": datetime.utcnow().isoformat(),
                    "footer": {"text": "Limited Sniper"}
                }
                discord_send(CHANNEL_IDS["big"], embed)

            if not data.get("buyagain"):
                config["limiteds"] = [l for l in config["limiteds"] if l["asset"] != asset_id]
        else:
            reason = check.json().get("message", check.reason) if check.content else check.reason
            log(f"[BUY ✗] {name} — {check.status_code} {reason} (buy {buy_ms:.0f}ms)")
            buy_log.append({"status": "failed", "asset": asset_id, "price": price, "name": name,
                            "fetch_ms": round(fetch_ms), "buy_ms": round(buy_ms), "reason": reason})

            post_buy_result(asset_id, name, price, rolimons_value, fetch_ms, buy_ms, False, reason)

    except Exception as e:
        log(f"[ERROR] Asset {data.get('asset', '?')} — {e}")

# ── Sniper loop ───────────────────────────────────────────────────────────────
def sniper_loop():
    global sniper_running, rate_limit

    threading.Thread(target=get_xtoken_loop, daemon=True).start()
    refresh_rolimons()
    sleep(2)

    log("[SNIPER] Started")
    while sniper_running:
        if not config["limiteds"]:
            sleep(10)
            continue

        if rate_limit:
            wait = 60 - datetime.now().second
            log(f"[RATELIMIT] Cooling down {wait}s...")
            sleep(wait)
            rate_limit = False

        threads = [
            threading.Thread(target=snipe_item, args=(item,), daemon=True)
            for item in list(config["limiteds"])
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    log("[SNIPER] Stopped")

# ── Routes ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html",
                           config=config,
                           running=sniper_running,
                           log=results_log[-50:],
                           buys=buy_log[-20:],
                           channel_ids=CHANNEL_IDS)

@app.route("/api/status")
def api_status():
    return jsonify({
        "running": sniper_running,
        "items": len(config["limiteds"]),
        "log": results_log[-50:],
        "buys": buy_log[-20:]
    })

@app.route("/api/config/settings", methods=["POST"])
def update_settings():
    data = request.json
    config["cookie"]          = data.get("cookie", config["cookie"])
    config["pingall"]         = data.get("pingall", config["pingall"])
    config["DEBUG_MESSAGES"]  = data.get("debug",   config["DEBUG_MESSAGES"])
    return jsonify({"ok": True})

@app.route("/api/config/add_item", methods=["POST"])
def add_item():
    data     = request.json
    asset_id = data.get("asset_id", "").strip()
    max_price = data.get("max_price", "0").strip()
    buyagain  = data.get("buyagain", False)

    if not asset_id:
        return jsonify({"ok": False, "error": "Missing asset ID"}), 400

    try:
        out = r.get(f"https://www.roblox.com/catalog/{asset_id}").text
        product_id = out.split('data-product-id="')[1].split('"')[0]
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not fetch product ID: {e}"}), 400

    # Get Rolimons value for display
    rolimons_value = get_rolimons_value(asset_id)

    config["limiteds"] = [l for l in config["limiteds"] if l["asset"] != asset_id]
    config["limiteds"].append({
        "asset": asset_id,
        "price": max_price,
        "buyagain": buyagain,
        "productid": product_id
    })
    log(f"[CONFIG] Added {asset_id} — Rolimons value: {rolimons_value or 'N/A'} R$")
    return jsonify({"ok": True, "product_id": product_id, "rolimons_value": rolimons_value})

@app.route("/api/config/remove_item", methods=["POST"])
def remove_item():
    asset_id = request.json.get("asset_id", "").strip()
    config["limiteds"] = [l for l in config["limiteds"] if l["asset"] != asset_id]
    log(f"[CONFIG] Removed {asset_id}")
    return jsonify({"ok": True})

@app.route("/api/sniper/start", methods=["POST"])
def start_sniper():
    global sniper_running, sniper_thread
    if sniper_running:
        return jsonify({"ok": False, "error": "Already running"})
    if not config["cookie"]:
        return jsonify({"ok": False, "error": "No cookie set"})
    sniper_running = True
    sniper_thread  = threading.Thread(target=sniper_loop, daemon=True)
    sniper_thread.start()
    return jsonify({"ok": True})

@app.route("/api/sniper/stop", methods=["POST"])
def stop_sniper():
    global sniper_running
    sniper_running = False
    return jsonify({"ok": True})

# Start Discord gateway bot on app startup
def on_startup():
    start_gateway()

import atexit
threading.Thread(target=on_startup, daemon=True).start()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
