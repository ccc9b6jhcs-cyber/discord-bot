const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Rolimons API endpoints (official, bot-friendly)
const ITEMS_API = 'https://api.rolimons.com/items/v1/itemdetails';
const TRADE_ADS_API = 'https://api.rolimons.com/tradeads/v1/getrecentads';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── Register slash command ───────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('lookfor')
      .setDescription('Find Rolimons trade ads where someone is offering a specific Roblox limited')
      .addStringOption(opt =>
        opt.setName('item')
          .setDescription('Name or Asset ID of the Roblox limited (e.g. "Valkyrie Helm" or 19027209)')
          .setRequired(true)
      )
      .toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash command /lookfor registered globally.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// ─── Fetch all item details from Rolimons ─────────────────────────────────────
async function fetchItems() {
  const res = await fetch(ITEMS_API, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RoliBot/1.0)',
      'Referer': 'https://www.rolimons.com/'
    }
  });
  if (!res.ok) throw new Error(`Items API error: ${res.status}`);
  return res.json();
}

// ─── Fetch recent trade ads ───────────────────────────────────────────────────
async function fetchTradeAds() {
  const res = await fetch(TRADE_ADS_API, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RoliBot/1.0)',
      'Referer': 'https://www.rolimons.com/'
    }
  });
  if (!res.ok) throw new Error(`Trade Ads API error: ${res.status}`);
  return res.json();
}

// ─── Find item ID by name or direct ID ───────────────────────────────────────
function resolveItem(query, itemDetails) {
  // If it's a number, treat as asset ID
  const asId = parseInt(query, 10);
  if (!isNaN(asId) && itemDetails[asId]) {
    const d = itemDetails[asId];
    return { id: String(asId), name: d[0], rap: d[2], value: d[3] };
  }

  // Otherwise fuzzy match by name (case-insensitive)
  const lower = query.toLowerCase();
  for (const [id, data] of Object.entries(itemDetails)) {
    if (data[0] && data[0].toLowerCase().includes(lower)) {
      return { id, name: data[0], rap: data[2], value: data[3] };
    }
  }
  return null;
}

// ─── Parse trade ads for matches ─────────────────────────────────────────────
// Trade ad format: [playerId, playerName, offeringItems[], requestingTags[], timestamp, adNote]
// offeringItems: array of asset IDs
function findAdsWithItem(tradeAds, targetItemId) {
  const matches = [];
  const ads = tradeAds.trade_ads || [];

  for (const ad of ads) {
    const [playerId, playerName, offering, , , note] = ad;
    const offeringIds = (offering || []).map(String);

    if (offeringIds.includes(String(targetItemId))) {
      matches.push({ playerId, playerName, offering: offeringIds, note });
    }
  }
  return matches;
}

// ─── Format value nicely ─────────────────────────────────────────────────────
function formatNum(n) {
  if (!n || n <= 0) return 'N/A';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Slash command handler ────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'lookfor') return;

  const query = interaction.options.getString('item');
  await interaction.deferReply({ ephemeral: true }); // DM-style: ephemeral = only visible to user

  try {
    // Fetch data in parallel
    const [itemData, tradeData] = await Promise.all([fetchItems(), fetchTradeAds()]);
    const itemDetails = itemData.items || {};

    // Resolve the item
    const item = resolveItem(query, itemDetails);
    if (!item) {
      return interaction.editReply({
        content: `❌ Could not find a Roblox limited matching **"${query}"**.\nTry using the exact name or the Asset ID.`
      });
    }

    // Find matching ads
    const matches = findAdsWithItem(tradeData, item.id);

    if (matches.length === 0) {
      return interaction.editReply({
        content: `🔍 No recent trade ads found where someone is **offering ${item.name}**.\nTry again in a few minutes as ads refresh every ~3 minutes.`
      });
    }

    // Build embed
    const embed = new EmbedBuilder()
      .setTitle(`🔎 Trade Ads Offering: ${item.name}`)
      .setColor(0x5865F2)
      .setURL(`https://www.rolimons.com/item/${item.id}`)
      .setDescription(
        `Found **${matches.length}** recent trade ad${matches.length !== 1 ? 's' : ''} where someone is offering **${item.name}**.\n` +
        `📈 RAP: **${formatNum(item.rap)}** | 💎 Value: **${formatNum(item.value)}**`
      )
      .setFooter({ text: 'Data from Rolimons • Ads refresh every ~3 min' })
      .setTimestamp();

    // Add up to 10 results
    const shown = matches.slice(0, 10);
    for (const ad of shown) {
      const offerCount = ad.offering.length;
      const note = ad.note ? `\n📝 *${ad.note.slice(0, 60)}${ad.note.length > 60 ? '…' : ''}*` : '';
      embed.addFields({
        name: `👤 ${ad.playerName}`,
        value:
          `🔗 [View Profile](https://www.rolimons.com/player/${ad.playerId})\n` +
          `📦 Offering **${offerCount}** item${offerCount !== 1 ? 's' : ''} total` +
          note,
        inline: true
      });
    }

    if (matches.length > 10) {
      embed.addFields({
        name: `…and ${matches.length - 10} more`,
        value: `[See all ads on Rolimons](https://www.rolimons.com/trades)`,
        inline: false
      });
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    console.error('Error handling /lookfor:', err);
    await interaction.editReply({
      content: `⚠️ Something went wrong fetching data from Rolimons. Please try again shortly.\n\`${err.message}\``
    });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN env var is missing!');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('❌ CLIENT_ID env var is missing!');
  process.exit(1);
}

client.login(DISCORD_TOKEN);
