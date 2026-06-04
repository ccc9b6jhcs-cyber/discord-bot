const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, EmbedBuilder, StringSelectMenuBuilder
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.rolimons.com/',
  'Accept': 'application/json'
};

const RESULTS_PER_PAGE = 5;
const sessions = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

// ─── APIs ─────────────────────────────────────────────────────────────────────

async function getAllItems() {
  const res = await fetch('https://www.rolimons.com/itemapi/itemdetails', { headers: HEADERS });
  if (!res.ok) throw new Error(`Items API ${res.status}`);
  const data = await res.json();
  return data.items;
}

async function getTradeAds() {
  const res = await fetch('https://www.rolimons.com/tradeadsapi/getrecentads', { headers: HEADERS });
  if (!res.ok) throw new Error(`Trade ads API ${res.status}`);
  const data = await res.json();
  return data.trade_ads || [];
}

async function getPlayerProfile(userId) {
  try {
    const res = await fetch(`https://www.rolimons.com/playerapi/player/${userId}`, { headers: HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function getPlayerAssets(userId) {
  try {
    const res = await fetch(`https://www.rolimons.com/api/playerassets/${userId}`, { headers: HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

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

// ─── Trade ad badge tier ──────────────────────────────────────────────────────
// Rolimons only exposes badges, not exact count
// Returns: 0 = <10, 10 = 10+, 100 = 100+, 1000 = 1000+

function getTradeAdTier(rolibadges) {
  if (!rolibadges) return 0;
  if (rolibadges['create_1000_trade_ads']) return 1000;
  if (rolibadges['create_100_trade_ads']) return 100;
  if (rolibadges['create_10_trade_ads']) return 10;
  return 0;
}

function tierLabel(tier) {
  if (tier === 0) return 'Under 10 ads';
  if (tier === 10) return '10–99 ads';
  if (tier === 100) return '100–999 ads';
  return '1000+ ads';
}

// ─── Item search ──────────────────────────────────────────────────────────────

function searchItems(items, query) {
  const q = query.toLowerCase().trim();
  const asId = parseInt(q, 10);
  if (!isNaN(asId) && items[asId]) return [{ id: String(asId), name: items[asId][0] }];

  const matches = [];
  for (const [id, data] of Object.entries(items)) {
    const name = (data[0] || '').toLowerCase();
    const acronym = (data[1] || '').toLowerCase();
    if (name.includes(q) || (acronym && acronym === q)) {
      matches.push({ id, name: data[0], score: name === q ? 0 : name.startsWith(q) ? 1 : acronym === q ? 2 : 3 });
    }
  }
  matches.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return matches.slice(0, 10);
}

// ─── Find owners via trade ads feed ──────────────────────────────────────────
// Trade ad format (from API docs + debug logs):
// [AdId, PostedEpoch, RobloxUserId, Username, {items:[offering]}, {items:[requesting],tags:[]}]

function findOfferersInFeed(tradeAds, itemId) {
  const seen = new Set();
  const offerers = [];

  for (const ad of tradeAds) {
    const robloxId = String(ad[2]);
    const username = ad[3] || 'Unknown';
    const offeringItems = (ad[4]?.items || []).map(String);

    if (seen.has(robloxId)) continue;
    if (!offeringItems.includes(String(itemId))) continue;

    seen.add(robloxId);
    offerers.push({ robloxId, username, source: 'trade_ad' });
  }

  return offerers;
}

// ─── Build results ────────────────────────────────────────────────────────────

async function buildResults(itemId, maxTier) {
  const tradeAds = await getTradeAds();
  console.log(`Fetched ${tradeAds.length} trade ads`);

  // Log first ad structure for debugging
  if (tradeAds.length > 0) {
    const a = tradeAds[0];
    console.log(`Sample ad: id=${a[0]}, epoch=${a[1]}, userId=${a[2]}, user=${a[3]}, offering=${JSON.stringify(a[4])}, requesting=${JSON.stringify(a[5])}`);
  }

  const offerers = findOfferersInFeed(tradeAds, itemId);
  console.log(`Found ${offerers.length} people offering item ${itemId}`);

  // Enrich with profile data
  const enriched = await Promise.all(offerers.slice(0, 20).map(async p => {
    const [profile, thumbnail] = await Promise.all([
      getPlayerProfile(p.robloxId),
      getRobloxThumbnail(p.robloxId)
    ]);

    const tier = getTradeAdTier(profile?.rolibadges);

    return {
      ...p,
      tier,
      value: profile?.value ?? null,
      rap: profile?.rap ?? null,
      lastOnline: profile?.last_online ?? null,
      thumbnail,
      profileUrl: `https://www.rolimons.com/player/${p.robloxId}`,
      robloxUrl: `https://www.roblox.com/users/${p.robloxId}/profile`
    };
  }));

  const filtered = enriched.filter(p => p.tier <= maxTier);
  filtered.sort((a, b) => a.tier - b.tier || (b.value ?? 0) - (a.value ?? 0));
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
    .setTitle(`🔎 Offering: ${itemName}`)
    .setColor(0x5865F2)
    .setURL(`https://www.rolimons.com/item/${itemId}`)
    .setFooter({ text: `Page ${page + 1}/${totalPages} • ${results.length} trader${results.length !== 1 ? 's' : ''} found • Ads refresh every ~3 min` })
    .setTimestamp();

  if (results.length === 0) {
    embed.setDescription([
      '❌ No traders found matching your criteria.',
      '',
      '**Tips:**',
      '• Try a higher `max_ads` tier',
      '• Trade ads only show the last ~3 minutes — try again shortly',
      '• Not everyone with this item has an active trade ad'
    ].join('\n'));
    return embed;
  }

  if (slice[0]?.thumbnail) embed.setThumbnail(slice[0].thumbnail);

  for (const p of slice) {
    embed.addFields({
      name: `👤 ${p.username}`,
      value: [
        `🔗 [Rolimons](${p.profileUrl}) • [Roblox](${p.robloxUrl})`,
        `🗒️ Trade ads created: **${tierLabel(p.tier)}**`,
        `💎 ${fmt(p.value)} value • 📈 ${fmt(p.rap)} RAP`,
        `🕐 Last online: ${timeAgo(p.lastOnline)}`
      ].join('\n'),
      inline: false
    });
  }

  return embed;
}

function buildRow(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('prev').setLabel('◀ Back').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('next').setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages - 1)
  );
}

// ─── Register ─────────────────────────────────────────────────────────────────

async function registerCommands() {
  const command = new SlashCommandBuilder()
    .setName('lookfor')
    .setDescription('Find traders on Rolimons currently offering a specific Roblox limited')
    .setDMPermission(true)
    .addStringOption(opt =>
      opt.setName('item')
        .setDescription('Item name or Asset ID (e.g. "Valkyrie Helm" or 19027209)')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('max_ads')
        .setDescription('Filter by how many trade ads they have created (default: under 100)')
        .setRequired(false)
        .addChoices(
          { name: 'Under 10 ads created', value: 0 },
          { name: 'Under 100 ads created', value: 10 },
          { name: 'Under 1000 ads created', value: 100 },
          { name: 'Any amount', value: 9999 }
        )
    );

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [command.toJSON()] });
  console.log('✅ /lookfor registered v8');
}

// ─── Events ───────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.error('Reg failed:', e); }
});

client.on('interactionCreate', async interaction => {

  if (interaction.isChatInputCommand() && interaction.commandName === 'lookfor') {
    await interaction.deferReply({ ephemeral: true });
    const query = interaction.options.getString('item');
    const maxTier = interaction.options.getInteger('max_ads') ?? 10;

    try {
      await interaction.editReply({ content: '⏳ Searching items...' });
      const allItems = await getAllItems();
      const matches = searchItems(allItems, query);

      if (matches.length === 0) {
        return interaction.editReply({ content: `❌ No items found matching **"${query}"**.\nTry a different spelling or paste the Asset ID from Rolimons.` });
      }

      sessions.set(interaction.user.id, { maxTier });

      const select = new StringSelectMenuBuilder()
        .setCustomId('item_select')
        .setPlaceholder('Select the item...')
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

  if (interaction.isStringSelectMenu() && interaction.customId === 'item_select') {
    const session = sessions.get(interaction.user.id);
    const [itemId, itemName] = interaction.values[0].split('||');
    const maxTier = session?.maxTier ?? 10;

    await interaction.update({ content: `✅ Searching trade ads for **${itemName}**...`, components: [] });

    try {
      const results = await buildResults(itemId, maxTier);
      const totalPages = Math.max(1, Math.ceil(results.length / RESULTS_PER_PAGE));
      sessions.set(interaction.user.id, { results, itemName, itemId, page: 0, totalPages });
      const embed = buildEmbed(itemName, itemId, results, 0, totalPages);
      await interaction.editReply({ content: null, embeds: [embed], components: totalPages > 1 ? [buildRow(0, totalPages)] : [] });
    } catch (err) {
      console.error('Error item_select:', err);
      await interaction.editReply({ content: `❌ Error: \`${err.message}\`` });
    }
  }

  if (interaction.isButton() && ['prev', 'next'].includes(interaction.customId)) {
    const session = sessions.get(interaction.user.id);
    if (!session?.results) return interaction.reply({ content: '❌ Session expired.', ephemeral: true });
    if (interaction.customId === 'next') session.page = Math.min(session.page + 1, session.totalPages - 1);
    if (interaction.customId === 'prev') session.page = Math.max(session.page - 1, 0);
    await interaction.update({
      embeds: [buildEmbed(session.itemName, session.itemId, session.results, session.page, session.totalPages)],
      components: [buildRow(session.page, session.totalPages)]
    });
  }
});

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID!');
  process.exit(1);
}

client.login(DISCORD_TOKEN);
