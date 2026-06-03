const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, EmbedBuilder, StringSelectMenuBuilder
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const ROLIMONS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; RoliBot/1.0)',
  'Referer': 'https://www.rolimons.com/'
};

const RESULTS_PER_PAGE = 5; // Lower so each result can show more detail
const sessions = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

// ─── API helpers ──────────────────────────────────────────────────────────────

async function getAllItems() {
  const res = await fetch('https://api.rolimons.com/items/v1/itemdetails', { headers: ROLIMONS_HEADERS });
  if (!res.ok) throw new Error(`Items API error: ${res.status}`);
  const data = await res.json();
  return data.items;
}

async function getTradeAds() {
  const res = await fetch('https://api.rolimons.com/tradeads/v1/getrecentads', { headers: ROLIMONS_HEADERS });
  if (!res.ok) throw new Error(`Trade ads API error: ${res.status}`);
  const data = await res.json();
  return data.trade_ads || [];
}

async function getPlayerInfo(playerId) {
  try {
    const res = await fetch(`https://api.rolimons.com/players/v1/playerinfo/${playerId}`, { headers: ROLIMONS_HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Get Roblox avatar thumbnail URL
async function getRobloxThumbnail(robloxId) {
  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=48x48&format=Png&isCircular=false`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.imageUrl || null;
  } catch { return null; }
}

// ─── Item search ──────────────────────────────────────────────────────────────

function searchItems(items, query) {
  const q = query.toLowerCase().trim();
  const asId = parseInt(q, 10);
  if (!isNaN(asId) && items[asId]) {
    return [{ id: String(asId), name: items[asId][0] }];
  }
  const matches = [];
  for (const [id, data] of Object.entries(items)) {
    const name = (data[0] || '').toLowerCase();
    if (name.includes(q)) {
      matches.push({ id, name: data[0], score: name === q ? 0 : name.startsWith(q) ? 1 : 2 });
    }
  }
  matches.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return matches.slice(0, 10);
}

// ─── Extract offering IDs from trade ad ──────────────────────────────────────
// From debug logs: ad = [playerId, robloxId, rolimonId, username, {}, {items:[...], tags:[...]}, ...]

function getOfferingIds(ad) {
  try {
    if (ad[5] && typeof ad[5] === 'object' && Array.isArray(ad[5].items)) {
      return ad[5].items.map(String);
    }
    const raw = ad[2];
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(i => String(Array.isArray(i) ? i[0] : typeof i === 'object' ? Object.values(i)[0] : i));
    if (typeof raw === 'object') return Object.keys(raw).map(String);
  } catch (e) { console.error('getOfferingIds:', e.message); }
  return [];
}

// ─── Build results with player details ───────────────────────────────────────

async function buildResults(itemId, tradeAds, maxAds) {
  const seen = new Set();
  const rawCandidates = [];

  for (const ad of tradeAds) {
    const playerId = String(ad[0]);
    const robloxId = String(ad[1]);
    const username = ad[3] || ad[1] || 'Unknown';

    if (seen.has(playerId)) continue;
    const offeringIds = getOfferingIds(ad);
    if (!offeringIds.includes(String(itemId))) continue;

    seen.add(playerId);
    rawCandidates.push({ playerId, robloxId, username });
  }

  // Fetch player info + thumbnails in parallel
  const enriched = await Promise.all(rawCandidates.map(async p => {
    const [info, thumbnail] = await Promise.all([
      getPlayerInfo(p.playerId),
      getRobloxThumbnail(p.robloxId)
    ]);

    const totalAdCount = info?.trade_ad_count ?? info?.tradeAdCount ?? null;
    const value = info?.value ?? null;
    const rap = info?.rap ?? null;

    return {
      ...p,
      totalAdCount,
      value,
      rap,
      thumbnail,
      profileUrl: `https://www.rolimons.com/player/${p.playerId}`,
      robloxUrl: `https://www.roblox.com/users/${p.robloxId}/profile`
    };
  }));

  // Filter by max ads
  const filtered = enriched.filter(p => {
    const count = p.totalAdCount !== null ? p.totalAdCount : 999;
    return count <= maxAds;
  });

  filtered.sort((a, b) => (a.totalAdCount ?? 999) - (b.totalAdCount ?? 999));
  return filtered;
}

// ─── Format number ────────────────────────────────────────────────────────────

function fmt(n) {
  if (!n || n < 0) return 'N/A';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Build embed ──────────────────────────────────────────────────────────────

function buildEmbed(itemName, itemId, results, page, totalPages) {
  const start = page * RESULTS_PER_PAGE;
  const slice = results.slice(start, start + RESULTS_PER_PAGE);

  const embed = new EmbedBuilder()
    .setTitle(`🔎 Traders offering: ${itemName}`)
    .setColor(0x5865F2)
    .setURL(`https://www.rolimons.com/item/${itemId}`)
    .setFooter({ text: `Page ${page + 1}/${totalPages} • ${results.length} trader${results.length !== 1 ? 's' : ''} found` })
    .setTimestamp();

  if (results.length === 0) {
    embed.setDescription('❌ No traders found matching your criteria.\n\n**Tips:**\n• Try increasing `max_ads`\n• Trade ads refresh every ~3 min, try again soon');
    return embed;
  }

  // Use thumbnail of first result as embed thumbnail
  if (slice[0]?.thumbnail) embed.setThumbnail(slice[0].thumbnail);

  for (const p of slice) {
    const adCount = p.totalAdCount !== null ? `${p.totalAdCount} total ads` : 'ads unknown';
    const valueStr = p.value ? `💎 ${fmt(p.value)}` : '';
    const rapStr = p.rap ? `📈 ${fmt(p.rap)} RAP` : '';
    const stats = [valueStr, rapStr].filter(Boolean).join(' • ') || 'Stats unavailable';

    embed.addFields({
      name: `👤 ${p.username}`,
      value: [
        `🔗 [Rolimons](${p.profileUrl}) • [Roblox](${p.robloxUrl})`,
        `🗒️ ${adCount}`,
        stats
      ].join('\n'),
      inline: false
    });
  }

  return embed;
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
        .setMaxValue(10000)
    );

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [command.toJSON()] });
  console.log('✅ /lookfor registered globally with DM support v4');
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

      if (matches.length === 1) {
        await interaction.editReply({ content: `✅ Found **${matches[0].name}**. Fetching trade ads...` });
        const tradeAds = await getTradeAds();
        await interaction.editReply({ content: `🔍 Fetching trader details...` });
        const results = await buildResults(matches[0].id, tradeAds, maxAds);
        const totalPages = Math.max(1, Math.ceil(results.length / RESULTS_PER_PAGE));
        sessions.set(interaction.user.id, { results, itemName: matches[0].name, itemId: matches[0].id, page: 0, totalPages });
        const embed = buildEmbed(matches[0].name, matches[0].id, results, 0, totalPages);
        return interaction.editReply({ content: null, embeds: [embed], components: totalPages > 1 ? [buildRow(0, totalPages)] : [] });
      }

      // Multiple matches — dropdown
      sessions.set(interaction.user.id, { maxAds });
      const select = new StringSelectMenuBuilder()
        .setCustomId('item_select')
        .setPlaceholder('Choose the item you mean...')
        .addOptions(matches.map(m => ({
          label: m.name.slice(0, 100),
          value: `${m.id}||${m.name.slice(0, 90)}`,
          description: `Asset ID: ${m.id}`
        })));

      return interaction.editReply({
        content: `Found **${matches.length}** items matching **"${query}"** — pick one:`,
        components: [new ActionRowBuilder().addComponents(select)]
      });

    } catch (err) {
      console.error('Error /lookfor:', err);
      await interaction.editReply({ content: `❌ Error: \`${err.message}\`` });
    }
  }

  // ── Item select ──
  if (interaction.isStringSelectMenu() && interaction.customId === 'item_select') {
    const session = sessions.get(interaction.user.id);
    const [itemId, itemName] = interaction.values[0].split('||');
    const maxAds = session?.maxAds ?? 5;

    await interaction.update({ content: `✅ Searching for **${itemName}** traders...`, components: [] });

    try {
      const tradeAds = await getTradeAds();
      await interaction.editReply({ content: `🔍 Fetching trader details...` });
      const results = await buildResults(itemId, tradeAds, maxAds);
      const totalPages = Math.max(1, Math.ceil(results.length / RESULTS_PER_PAGE));
      sessions.set(interaction.user.id, { results, itemName, itemId, page: 0, totalPages });
      const embed = buildEmbed(itemName, itemId, results, 0, totalPages);
      await interaction.editReply({ content: null, embeds: [embed], components: totalPages > 1 ? [buildRow(0, totalPages)] : [] });
    } catch (err) {
      console.error('Error item_select:', err);
      await interaction.editReply({ content: `❌ Error: \`${err.message}\`` });
    }
  }

  // ── Pagination ──
  if (interaction.isButton() && ['page_prev', 'page_next'].includes(interaction.customId)) {
    const session = sessions.get(interaction.user.id);
    if (!session) return interaction.reply({ content: '❌ Session expired — run `/lookfor` again.', ephemeral: true });
    if (interaction.customId === 'page_next') session.page = Math.min(session.page + 1, session.totalPages - 1);
    if (interaction.customId === 'page_prev') session.page = Math.max(session.page - 1, 0);
    const embed = buildEmbed(session.itemName, session.itemId, session.results, session.page, session.totalPages);
    await interaction.update({ embeds: [embed], components: [buildRow(session.page, session.totalPages)] });
  }
});

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID!');
  process.exit(1);
}

client.login(DISCORD_TOKEN);
