const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; RoliBot/1.0)',
  'Referer': 'https://www.rolimons.com/'
};

const RESULTS_PER_PAGE = 10;
const sessions = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

async function getAllItems() {
  const res = await fetch('https://api.rolimons.com/items/v1/itemdetails', { headers: HEADERS });
  if (!res.ok) throw new Error(`Items API error: ${res.status}`);
  const data = await res.json();
  return data.items;
}

async function getTradeAds() {
  const res = await fetch('https://api.rolimons.com/tradeads/v1/getrecentads', { headers: HEADERS });
  if (!res.ok) throw new Error(`Trade ads API error: ${res.status}`);
  const data = await res.json();
  return data.trade_ads || [];
}

function findItemByName(items, query) {
  const q = query.toLowerCase().trim();
  const asId = parseInt(q, 10);
  if (!isNaN(asId) && items[asId]) {
    return { id: String(asId), name: items[asId][0] };
  }
  let bestId = null, bestName = null, bestScore = Infinity;
  for (const [id, data] of Object.entries(items)) {
    const name = (data[0] || '').toLowerCase();
    if (name === q) return { id, name: data[0] };
    if (name.includes(q)) {
      const score = name.length - q.length;
      if (score < bestScore) { bestScore = score; bestId = id; bestName = data[0]; }
    }
  }
  return bestId ? { id: bestId, name: bestName } : null;
}

// Log the raw structure of the first trade ad so we can see what Rolimons actually sends
function debugTradeAd(ad) {
  console.log('=== RAW TRADE AD SAMPLE ===');
  console.log(JSON.stringify(ad, null, 2));
  console.log('offering field type:', typeof ad[2], Array.isArray(ad[2]) ? '(array)' : '');
  console.log('offering value:', JSON.stringify(ad[2]));
  console.log('===========================');
}

// Handle any possible format Rolimons returns for offering
function extractOfferingIds(offering) {
  if (!offering) return [];
  try {
    // Flat array of numbers: [123, 456]
    if (Array.isArray(offering)) {
      return offering.map(item => {
        if (Array.isArray(item)) return String(item[0]);
        if (typeof item === 'object' && item !== null) {
          return String(item.id || item.assetId || item.asset_id || Object.values(item)[0]);
        }
        return String(item);
      }).filter(Boolean);
    }
    // Object: { "123": ..., "456": ... }
    if (typeof offering === 'object') {
      return Object.keys(offering).map(String);
    }
    // String of comma-separated IDs
    if (typeof offering === 'string') {
      return offering.split(',').map(s => s.trim()).filter(Boolean);
    }
  } catch (e) {
    console.error('extractOfferingIds error:', e, 'raw offering:', JSON.stringify(offering));
  }
  return [];
}

function buildResults(itemId, tradeAds, maxAds) {
  const seen = new Set();
  const candidates = [];

  // Debug the first ad
  if (tradeAds.length > 0) debugTradeAd(tradeAds[0]);

  for (const ad of tradeAds) {
    const playerId = String(ad[0]);
    const username = ad[1];
    const offeringRaw = ad[2];
    const hasPremium = ad[5] === 1 || ad[5] === true;

    if (seen.has(playerId)) continue;
    if (!hasPremium) continue;

    const offeringIds = extractOfferingIds(offeringRaw);
    if (!offeringIds.includes(String(itemId))) continue;

    const adCount = tradeAds.filter(a => String(a[0]) === playerId).length;
    if (adCount > maxAds) continue;

    seen.add(playerId);
    candidates.push({
      playerId,
      username,
      adCount,
      profileUrl: `https://www.rolimons.com/player/${playerId}`,
      robloxUrl: `https://www.roblox.com/users/${playerId}/profile`
    });
  }

  candidates.sort((a, b) => a.adCount - b.adCount);
  return candidates;
}

function buildEmbed(itemName, results, page, totalPages) {
  const start = page * RESULTS_PER_PAGE;
  const slice = results.slice(start, start + RESULTS_PER_PAGE);

  const description = results.length === 0
    ? '❌ No matching players found.\n\nTips:\n• Check the item name is correct\n• Try increasing `max_ads`\n• Trade ads only show last ~3 minutes of activity'
    : slice.map((p, i) =>
        `\`${String(start + i + 1).padStart(2, '0')}.\` **[${p.username}](${p.profileUrl})** — ${p.adCount} ad${p.adCount !== 1 ? 's' : ''} • [Roblox](${p.robloxUrl})`
      ).join('\n');

  return new EmbedBuilder()
    .setTitle(`🔎  Offering: ${itemName}`)
    .setColor(0x5865F2)
    .setDescription(description)
    .setFooter({ text: `Page ${page + 1}/${totalPages} • ${results.length} result${results.length !== 1 ? 's' : ''} • Premium traders only` })
    .setTimestamp();
}

function buildRow(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('page_prev')
      .setLabel('◀ Back')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId('page_next')
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages - 1)
  );
}

async function registerCommands() {
  const command = new SlashCommandBuilder()
    .setName('lookfor')
    .setDescription('Find Premium traders on Rolimons offering a specific Roblox limited')
    .setDMPermission(true)
    .addStringOption(opt =>
      opt.setName('item')
        .setDescription('Name or Asset ID of the limited (e.g. "Valkyrie Helm" or 19027209)')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('max_ads')
        .setDescription('Max trade ads the player can have (default: 3)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(50)
    );

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [command.toJSON()] });
  console.log('✅ /lookfor registered globally with DM support v2');
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.error('Command registration failed:', e); }
});

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'lookfor') {
    await interaction.deferReply({ ephemeral: true });

    const query = interaction.options.getString('item');
    const maxAds = interaction.options.getInteger('max_ads') ?? 3;

    try {
      await interaction.editReply({ content: '⏳ Fetching items from Rolimons...' });
      const allItems = await getAllItems();

      const found = findItemByName(allItems, query);
      if (!found) {
        return interaction.editReply({
          content: `❌ Couldn't find **"${query}"** in Rolimons.\nTry the exact name or Asset ID.`
        });
      }

      await interaction.editReply({ content: `✅ Found **${found.name}**. Fetching trade ads...` });
      const tradeAds = await getTradeAds();

      await interaction.editReply({ content: `🔍 Scanning ${tradeAds.length} ads...` });
      const results = buildResults(found.id, tradeAds, maxAds);
      const totalPages = Math.max(1, Math.ceil(results.length / RESULTS_PER_PAGE));

      sessions.set(interaction.user.id, { results, itemName: found.name, page: 0, totalPages });

      const embed = buildEmbed(found.name, results, 0, totalPages);
      const row = buildRow(0, totalPages);

      await interaction.editReply({
        content: null,
        embeds: [embed],
        components: totalPages > 1 ? [row] : []
      });

    } catch (err) {
      console.error('Error handling /lookfor:', err);
      await interaction.editReply({ content: `❌ Something went wrong: \`${err.message}\`` });
    }
  }

  if (interaction.isButton() && ['page_prev', 'page_next'].includes(interaction.customId)) {
    const session = sessions.get(interaction.user.id);
    if (!session) {
      return interaction.reply({ content: '❌ Session expired — run `/lookfor` again.', ephemeral: true });
    }

    if (interaction.customId === 'page_next') session.page = Math.min(session.page + 1, session.totalPages - 1);
    if (interaction.customId === 'page_prev') session.page = Math.max(session.page - 1, 0);

    const embed = buildEmbed(session.itemName, session.results, session.page, session.totalPages);
    const row = buildRow(session.page, session.totalPages);

    await interaction.update({ embeds: [embed], components: [row] });
  }
});

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID!');
  process.exit(1);
}

client.login(DISCORD_TOKEN);
