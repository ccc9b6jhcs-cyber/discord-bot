# Rolimons Discord Bot 🎮

A Discord bot that finds active Rolimons trade ads where someone is **offering** a specific Roblox limited item. Results are sent back as an ephemeral (private, DM-style) reply.

## Commands

| Command | Description |
|---|---|
| `/lookfor item:<name or ID>` | Find trade ads offering the specified limited |

**Examples:**
- `/lookfor item:Valkyrie Helm`
- `/lookfor item:19027209`
- `/lookfor item:clockwork`

---

## Setup

### 1. Create a Discord Application & Bot

1. Go to https://discord.com/developers/applications
2. Click **New Application**, give it a name
3. Go to **Bot** → click **Add Bot**
4. Under **Token**, click **Reset Token** and copy it → this is your `DISCORD_TOKEN`
5. Copy your **Application ID** from the **General Information** page → this is your `CLIENT_ID`
6. Under **Bot → Privileged Gateway Intents**, you don't need any extras — this bot uses only slash commands

### 2. Invite the Bot to Your Server

Generate an invite URL:
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=2048
```
Replace `YOUR_CLIENT_ID` with your actual Application ID.

### 3. Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to https://railway.app → **New Project** → **Deploy from GitHub Repo**
3. Select your repo
4. Go to **Variables** and add:
   - `DISCORD_TOKEN` = your bot token
   - `CLIENT_ID` = your Discord Application ID
5. Railway will auto-detect the Node.js app and start it

The bot registers the `/lookfor` command globally on startup (takes up to 1 hour for Discord to propagate globally, but usually ~1 minute for your own server).

### 4. Run Locally (optional)

```bash
npm install

# Create a .env file:
echo "DISCORD_TOKEN=your_token_here" >> .env
echo "CLIENT_ID=your_client_id_here" >> .env

node -e "require('dotenv').config(); require('./index.js')"
```

---

## How It Works

1. Fetches all Roblox limited item details from `api.rolimons.com/items/v1/itemdetails`
2. Resolves your search query to an item ID (supports partial name or direct asset ID)
3. Fetches recent trade ads from `api.rolimons.com/tradeads/v1/getrecentads` (refreshes every ~3 min)
4. Filters ads where that item appears in the **offering** list
5. Sends back an ephemeral embed showing matching traders + links to their Rolimons profiles

---

## Notes

- The Rolimons trade ads endpoint only returns ads from the **last ~3 minutes** — this is by design
- Results are **ephemeral** (only visible to you, like a DM in the channel)
- Up to 10 results are shown per query; more are linked to Rolimons
- Rolimons' API asks bots to use the API rather than scraping — this bot complies
