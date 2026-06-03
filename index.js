const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; RoliBot/1.0)',
  'Referer': 'https://www.rolimons.com/'
};

const RESULTS_PER_PAGE = 10;
const sessions = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

// ─── API helpers ──────────────────────────────────────────────────────────────

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

async function getPlayerTradeAdCount(playerId) {
  try {
    const res = await fetch(`https://api.rolimons.com/players/v1/playerinfo/${playerId}`, { headers: HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    // trade_ad_count or similar field
    return data.trade_ad_count ?? data.tradeAdCount ?? data.player_trade_ad_count ?? null;
  } catch {
    return null;
  }
}

// ─── Item search — returns up to 10 fuzzy matches ────────────────────────────

function searchItems(items, query) {
  const q = query.toLowerCase().trim();

  // Direct asset ID
  const asId = parseInt(q, 10);
  if (!isNaN(asId) && items[asId]) {
    return [{ id: String(asId), name: items[asId][0] }];
  }

  const matches = [];
  for (const [id, data] of Object.entries(items)) {
    const name = (data[0] || '').toLowerCase();
    if (name.includes(q)) {
      matches.push({ id, name: data[0], score: name === q ? 0 : name.indexOf(q) === 0 ? 1 : 2 });
    }
  }

  matches.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return matches.slice(0, 10);
}

// ─── Extract offering item IDs from a trade ad ───────────────────────────────
// Real format from logs:
// ad = [playerId, robloxId, rolimonId, username, {}, { items: [...], tags: [...] }, ...]
// ad[5] = { items: [itemId, itemId, ...], tags: [...] }

function getOfferingIds(ad) {
  try {
    // Try ad[5].items first (confirmed from logs)
    if (ad[5] && typeof ad[5] === 'object' && Array.isArray(ad[5].items)) {
      return ad[5].items.map(String);
    }
    // Fallback: ad[2] in various formats
    const raw = ad[2];
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.map(item => String(Array.isArray(item) ? item[0] : typeof item === 'object' ? (item.id || Object.values(item)[0]) : item));
    }
    if (typeof raw === 'object') return Object.keys(raw).map(String);
  } catch (e) {
    console.error('getOfferingIds error:', e.message);
  }
  return [];
}

// ─── Build results ────────────────────────────────────────────────────────────

async function buildResults(itemId, tradeAds, maxAds) {
  const seen = new Set();
  const candidates = [];

  for (const ad of tradeAds) {
    const playerId = String(ad[0]);
    const username = ad[3] || ad[1] || 'Unknown';

    if (seen.has(playerId)) continue;

    const offeringIds = getOfferingIds(ad);
    if (!offeringIds.includes(String(itemId))) continue;

    seen.add(playerId);

    // Count how many ads this player has in the current feed
    const adCountInFeed = tradeAds.filter(a => String(a[0]) === playerId).length;

    candidates.push({
      playerId,
      username,
      adCountInFeed,
      profileUrl: `https://www.rolimons.com/player/${playerId}`,
      robloxUrl: `https://www.roblox.com/users/${playerId}/profile`
    });
  }

  // Fetch total trade ad counts from Rolimons profiles in parallel (max 20 players)
  const toFetch = candidates.slice(0, 20);
  await Promise.all(toFetch.map(async p => {
    const count = await getPlayerTradeAdCount(p.playerId);
    p.totalAdCount = count;
  }));

  // Filter by maxAds using total count if available, otherwise feed count
  const filtered = candidates.filter(p => {
    const count = p.totalAdCount !== null && p.totalAdCount !== undefined ? p.totalAdCount : p.adCountInFeed;
    return count <= maxAds;
  });

  filtered.sort((a, b) => {
    const ca = a.totalAdCount ?? a.adCountInFeed;
    const cb = b.totalAdCount ?? b.adCountInFeed;
    return ca - cb;
  });

  return filtered;
}

// ─── Embed ────────────────────────────────────────────────────────────────────

function buildEmbed(itemName, results, page, totalPages) {
  const start = page * RESULTS_PER_PAGE;
  const slice = results.slice(start, start + RESULTS_PER_PAGE);

  const description = results.length === 0
    ? '❌ No matching traders found.\n\n**Tips:**\n• Try increasing `max_ads`\n• Trade ads refresh every ~3 minutes, try again soon\n• Make sure the item name is correct'
    : slice.map((p, i) => {
        const count = p.totalAdCount !== null && p.totalAdCount !== undefined ? p.totalAdCount : `~${p.adCountInFeed}`;
        return `\`${String(start + i + 1).padStart(2, '0')}.\` **[${p.username}](${p.profileUrl})** — ${count} total ads • [Roblox](${p.robloxUrl})`;
      }).join('\n');

  return new EmbedBuilder()
    .setTitle(`🔎 Offering: ${itemName}`)
    .setColor(0x5865F2)
    .setDescription(description)
    .setFooter({ text: `Page ${page + 1}/${totalPages} • ${results.length} result${results.length !== 1 ? 's' : ''}` })
    .setTimestamp();
}

function buildRow(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('page_prev').setLabel('◀ Back').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('page_next').setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages - 1)
  );
}

// ─── Register commands ────────────────────────────────────────────────────────

async function registerCommands() {
  const command = new SlashCommandBuilder()
    .setName('lookfor')
    .setDescription('Find traders on Rolimons offering a specific Roblox limited')
    .setDMPermission(true)
    .addStringOption(opt =>
      opt.setName('item')
        .setDescription('Item name or Asset ID (e.g. "Valkyrie Helm" or 19027209)')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('max_ads')
        .setDescription('Max total trade ads the player can have (default: 5)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000)
    );

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [command.toJSON()] });
  console.log('✅ /lookfor registered globally with DM support v3');
}

// ─── Events ───────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.error('Command registration failed:', e); }
});

client.on('interactionCreate', async interaction => {

  // ── /lookfor ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'lookfor') {
    await interaction.deferReply({ ephemeral: true });

    const query = interaction.options.getString('item');
    const maxAds = interaction.options.getInteger('max_ads') ?? 5;

    try {
      await interaction.editReply({ content: '⏳ Searching items...' });
      const allItems = await getAllItems();
      const matches = searchItems(allItems, query);

      if (matches.length === 0) {
        return interaction.editReply({ content: `❌ No items found matching **"${query}"**. Try a different name or use the Asset ID.` });
      }

      // If only one match, go straight to results
      if (matches.length === 1) {
        await interaction.editReply({ content: `✅ Found **${matches[0].name}**. Fetching trade ads...` });
        const tradeAds = await getTradeAds();
        const results = await buildResults(matches[0].id, tradeAds, maxAds);
        const totalPages = Math.max(1, Math.ceil(results.length / RESULTS_PER_PAGE));
        sessions.set(interaction.user.id, { results, itemName: matches[0].name, page: 0, totalPages });
        const embed = buildEmbed(matches[0].name, results, 0, totalPages);
        return interaction.editReply({ content: null, embeds: [embed], components: totalPages > 1 ? [buildRow(0, totalPages)] : [] });
      }

      // Multiple matches — show a select menu
      const select = new StringSelectMenuBuilder()
        .setCustomId('item_select')
        .setPlaceholder('Choose the item you mean...')
        .addOptions(matches.map(m => ({
          label: m.name.slice(0, 100),
          value: `${m.id}|${m.name.slice(0, 90)}`,
          description: `Asset ID: ${m.id}`
        })));

      sessions.set(interaction.user.id, { maxAds, pendingSelect: true });

      return interaction.editReply({
        content: `Found **${matches.length}** items matching **"${query}"** — which one?`,
        components: [new ActionRowBuilder().addComponents(select)]
      });

    } catch (err) {
      console.error('Error handling /lookfor:', err);
      await interaction.editReply({ content: `❌ Something went wrong: \`${err.message}\`` });
    }
  }

  // ── Item select ──
  if (interaction.isStringSelectMenu() && interaction.customId === 'item_select') {
    const session = sessions.get(interaction.user.id);
    const [itemId, itemName] = interaction.values[0].split('|');
    const maxAds = session?.maxAds ?? 5;

    await interaction.update({ content: `✅ Got it — searching for **${itemName}** traders...`, components: [] });

    try {
      const tradeAds = await getTradeAds();
      const results = await buildResults(itemId, tradeAds, maxAds);
      const totalPages = Math.max(1, Math.ceil(results.length / RESULTS_PER_PAGE));
      sessions.set(interaction.user.id, { results, itemName, page: 0, totalPages });
      const embed = buildEmbed(itemName, results, 0, totalPages);
      await interaction.editReply({ content: null, embeds: [embed], components: totalPages > 1 ? [buildRow(0, totalPages)] : [] });
    } catch (err) {
      console.error('Error in item_select:', err);
      await interaction.editReply({ content: `❌ Something went wrong: \`${err.message}\`` });
    }
  }

  // ── Pagination ──
  if (interaction.isButton() && ['page_prev', 'page_next'].includes(interaction.customId)) {
    const session = sessions.get(interaction.user.id);
    if (!session) return interaction.reply({ content: '❌ Session expired — run `/lookfor` again.', ephemeral: true });

    if (interaction.customId === 'page_next') session.page = Math.min(session.page + 1, session.totalPages - 1);
    if (interaction.customId === 'page_prev') session.page = Math.max(session.page - 1, 0);

    await interaction.update({
      embeds: [buildEmbed(session.itemName, session.results, session.page, session.totalPages)],
      components: [buildRow(session.page, session.totalPages)]
    });
  }
});

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID!');
  process.exit(1);
}

client.login(DISCORD_TOKEN);
