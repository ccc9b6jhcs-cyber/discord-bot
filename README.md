# Limited Sniper

A Roblox limited item sniper with a web dashboard, Discord bot control, and deal alerts. Deploys to Railway in one click.

-----

## What it does

- Monitors Roblox limited items you add via the dashboard or Discord
- Compares listing prices against **Rolimons item value** to detect discounts
- Posts deal alerts to Discord channels based on discount tier
- Auto-buys items when the discount hits your threshold (e.g. 60%+ off)
- Tracks price changes in real time and shows fetch/buy latency in ms
- Fully controllable from a Discord channel with slash-style commands

-----

## Discord channels to create

|Channel name     |Purpose                                                       |
|-----------------|--------------------------------------------------------------|
|`#small-deals`   |Alerts for items 20–39% below Rolimons value                  |
|`#medium-deals`  |Alerts for items 40–59% below Rolimons value                  |
|`#big-deals`     |Alerts for items 60%+ below Rolimons value + buy confirmations|
|`#price-tracker` |Every price change on tracked items + ping/ms stats           |
|`#sniper-control`|Type commands here to control the sniper                      |

-----

## Railway environment variables

Go to your Railway service → **Variables** → **+ New Variable** and add all of these:

|Variable               |Where to get it                                                                                 |
|-----------------------|------------------------------------------------------------------------------------------------|
|`ROBLOSECURITY`        |Your Roblox `.ROBLOSECURITY` cookie                                                             |
|`DISCORD_TOKEN`        |[Discord Developer Portal](https://discord.com/developers/applications) → Your app → Bot → Token|
|`CLIENT_ID`            |Discord Developer Portal → Your app → General Information → Application ID                      |
|`SMALL_DEALS_CHANNEL`  |Right-click `#small-deals` in Discord → Copy Channel ID                                         |
|`MEDIUM_DEALS_CHANNEL` |Right-click `#medium-deals` → Copy Channel ID                                                   |
|`BIG_DEALS_CHANNEL`    |Right-click `#big-deals` → Copy Channel ID                                                      |
|`PRICE_TRACKER_CHANNEL`|Right-click `#price-tracker` → Copy Channel ID                                                  |
|`CONTROL_CHANNEL`      |Right-click `#sniper-control` → Copy Channel ID                                                 |


> **Copy Channel ID not showing?** Go to Discord Settings → Advanced → turn on Developer Mode first.

-----

## File structure

```
limited-sniper/
├── app.py
├── Procfile
├── railway.toml
├── requirements.txt
└── templates/
    └── index.html
```

`index.html` **must** be inside the `templates/` folder or the app will crash on startup.

-----

## Deploy steps

1. Create a new GitHub repo and push all the files above (keeping the folder structure)
1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
1. Select your repo
1. Go to your service → **Variables** and add all the env vars from the table above
1. Railway will automatically redeploy — visit the generated URL to open the dashboard

-----

## Inviting the bot to your server

Replace `YOUR_CLIENT_ID` with your actual Client ID:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2048&scope=bot
```

The bot only needs **Send Messages** and **Embed Links** permissions.

-----

## Using the dashboard

1. Open your Railway URL
1. Paste your `.ROBLOSECURITY` cookie and save settings
1. Add items by asset ID (find the ID in the Roblox catalog URL, e.g. `roblox.com/catalog/1365767/...` → ID is `1365767`)
1. Set a max buy price per item, or leave at `0` for alert-only
1. Click **Start sniper**

-----

## Discord control commands

Type these in your `#sniper-control` channel:

|Command                      |What it does                                               |
|-----------------------------|-----------------------------------------------------------|
|`/start`                     |Start the sniper                                           |
|`/stop`                      |Stop the sniper                                            |
|`/status`                    |Show running state, item count, auto-buy threshold         |
|`/list`                      |List all tracked items with Rolimons values                |
|`/add <asset_id> [max_price]`|Add an item (max_price optional, 0 = alert only)           |
|`/remove <asset_id>`         |Remove an item                                             |
|`/setbuy <discount%>`        |Auto-buy anything at this % off or more (e.g. `/setbuy 60`)|
|`/setbuy 0`                  |Disable auto-buy entirely (alert-only mode)                |
|`/setdebug on|off`           |Toggle verbose price logging                               |
|`/help`                      |Show all commands                                          |

-----

## How auto-buy works

There are two ways an item gets purchased:

1. **Discount threshold** — `/setbuy 60` means any item listed at 60%+ below its Rolimons value gets bought automatically
1. **Manual max price** — set a max price per item in the dashboard or with `/add`; if the listing hits that price it buys

Both can be active at the same time. Set max price to `0` and `/setbuy 0` to run in alert-only mode.

-----

## Price tracker channel

`#price-tracker` gets two types of embeds:

**Price change** — posted whenever a tracked item’s price moves:

- Old price → new price
- Change amount and %
- How far the new price is from Rolimons value
- Fetch latency in ms

**Buy result** — posted on every purchase attempt (success or fail):

- Price paid
- Fetch ping (time to read the Roblox page)
- Buy request time (time for the purchase API call)
- Total latency
- Fail reason if it didn’t go through

-----

## Notes

- Config is **in-memory only** — redeploying clears your item list. Set `ROBLOSECURITY` as an env var so your cookie persists across deploys.
- Rolimons data refreshes every 10 minutes automatically.
- The bot reconnects automatically if the Discord gateway drops.
- Uses 1 gunicorn worker + 4 threads so the background sniper and Discord bot run alongside the web server.