const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, EmbedBuilder, StringSelectMenuBuilder
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; RoliBot/1.0)',
  'Referer': 'https://www.rolimons.com/'
};

const RESULTS_PER_PAGE = 5;
const sessions = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

// ─── Rolimons API ─────────────────────────────────────────────────────────────

async function getAllItems() {
  const res = await fetch('https://www.rolimons.com/itemapi/itemdetails', { headers: HEADERS });
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

// Returns { name, value, rap, trade_ad_count, last_online, ... }
async function getPlayerProfile(rolimonPlayerId) {
  try {
    const res = await fetch(`https://www.rolimons.com/playerapi/player/${rolimonPlayerId}`, { headers: HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Roblox headshot thumbnail
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

// ─── Item search — fuzzy, returns up to 10 ───────────────────────────────────

function searchItems(items, query) {
  const q = query.toLowerCase().trim();

  // Direct asset ID lookup
  const asId = parseInt(q, 10);
  if (!isNaN(asId) && items[asId]) {
    return [{ id: String(asId), name: items[asId][0] }];
  }

  const matches = [];
  for (const [id, data] of Object.entries(items)) {
    const name = (data[0] || '').toLowerCase();
    const acronym = (data[1] || '').toLowerCase();
    if (name.includes(q) || acronym === q) {
      matches.push({
        id,
        name: data[0],
        score: name === q ? 0 : name.startsWith(q) ? 1 : acronym === q ? 2 : 3
      });
    }
  }

  matches.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return matches.slice(0, 10);
}

// ─── Extract offering IDs from trade ad ──────────────────────────────────────
// From debug: ad[5] = { items: [id, id, ...], tags: [...] }

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

// ─── Build results ────────────────────────────────────────────────────────────
// Trade ad format from debug logs:
// ad[0] = rolimons player ID
// ad[1] = roblox user ID  
// ad[3] = username

async function buildResults(itemId, tradeAds, maxAds) {
  const seen = new Set();
  const rawCandidates = [];

  for (const ad of tradeAds) {
    const rolimonId = String(ad[0]);
    const robloxId = String(ad[1]);
    const username = ad[3] || 'Unknown';

    if (seen.has(rolimonId)) continue;
    const offeringIds = getOfferingIds(ad);
    if (!offeringIds.includes(String(itemId))) continue;

    seen.add(rolimonId);
    rawCandidates.push({ rolimonId, robloxId, username });
  }

  console.log(`Found ${rawCandidates.length} raw candidates for item ${itemId}`);

  // Fetch player profiles + thumbnails in parallel (cap at 20)
  const toEnrich = rawCandidates.slice(0, 20);
  const enriched = await Promise.all(toEnrich.map(async p => {
    const [profile, thumbnail] = await Promise.all([
      getPlayerProfile(p.rolimonId),
      getRobloxThumbnail(p.robloxId)
    ]);

    // trade_ad_count is the total ads created shown on their Rolimons profile
    const tradeAdCount = profile?.trade_ad_count ?? null;
    const value = profile?.value ?? null;
    const rap = profile?.rap ?? null;
    const lastOnline = profile?.last_online ?? null;

    console.log(`Player ${p.username} (${p.rolimonId}): trade_ad_count=${tradeAdCount}, profile keys=${profile ? Object.keys(profile).join(',') : 'null'}`);

    return {
      ...p,
      tradeAdCount,
      value,
      rap,
      lastOnline,
      thumbnail,
      profileUrl: `https://www.rolimons.com/player/${p.rolimonId}`,
      robloxUrl: `https://www.roblox.com/users/${p.robloxId}/profile`
    };
  }));

  // Filter — if we can't get the count, include them anyway with a note
  const filtered = enriched.filter(p => {
    if (p.tradeAdCount === null) return true; // include unknowns
    return p.tradeAdCount <= maxAds;
  });

  filtered.sort((a, b) => (a.tradeAdCount ?? Infinity) - (b.tradeAdCount ?? Infinity));
  return filtered;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n) {
  if (!n || n < 0) return 'N/A';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function timeAgo(epoch) {
  if (!epoch) return 'Unknown';
  const diff = Math.floor(Date.now() / 1000) - epoch;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Embed ────────────────────────────────────────────────────────────────────

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
    embed.setDescription('❌ No traders found.\n\n**Tips:**\n• Try increasing `max_ads`\n• Trade ads refresh every ~3 min — try again soon\n• Make sure the item name is correct');
    return embed;
  }

  if (slice[0]?.thumbnail) embed.setThumbnail(slice[0].thumbnail);

  for (const p of slice) {
    const adStr = p.tradeAdCount !== null ? `**${p.tradeAdCount}** trade ads created` : 'Trade ads: unknown';
    const valStr = `💎 ${fmt(p.value)} value • 📈 ${fmt(p.rap)} RAP`;
    const onlineStr = `🕐 Last online: ${timeAgo(p.lastOnline)}`;

    embed.addFields({
      name: `👤 ${p.username}`,
      value: [
        `🔗 [Rolimons](${p.profileUrl}) • [Roblox](${p.robloxUrl})`,
        `🗒️ ${adStr}`,
        valStr,
        onlineStr
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

// ─── Commands ─────────────────────────────────────────────────────────────────

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
        .setDescription('Max total Trade Ads Created on their Rolimons profile (default: 5)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(100000)
    );

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [command.toJSON()] });
  console.log('✅ /lookfor registered globally v5');
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
        return interaction.editReply({ content: `❌ No items found matching **"${query}"**.\nTry a different spelling or use the Asset ID from Rolimons.` });
      }

      // Always show dropdown so user can confirm the right item
      sessions.set(interaction.user.id, { maxAds });

      const select = new StringSelectMenuBuilder()
        .setCustomId('item_select')
        .setPlaceholder('Select the item you want to search...')
        .addOptions(matches.map(m => ({
          label: m.name.slice(0, 100),
          value: `${m.id}||${m.name.slice(0, 90)}`,
          description: `Asset ID: ${m.id}`
        })));

      return interaction.editReply({
        content: `Found **${matches.length}** item${matches.length !== 1 ? 's' : ''} matching **"${query}"** — pick one:`,
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

    await interaction.update({ content: `✅ Searching for traders offering **${itemName}**...`, components: [] });

    try {
      const tradeAds = await getTradeAds();
      await interaction.editReply({ content: `🔍 Checking ${tradeAds.length} trade ads & fetching player profiles...` });
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
    if (!session?.results) return interaction.reply({ content: '❌ Session expired — run `/lookfor` again.', ephemeral: true });
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
