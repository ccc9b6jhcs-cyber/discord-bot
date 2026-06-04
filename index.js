const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, EmbedBuilder, StringSelectMenuBuilder
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const ROLIMONS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://www.rolimons.com/',
  'Accept': 'application/json'
};

const RESULTS_PER_PAGE = 5;
const sessions = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

// ─── Rolimons: all items ──────────────────────────────────────────────────────

async function getAllItems() {
  const res = await fetch('https://www.rolimons.com/itemapi/itemdetails', { headers: ROLIMONS_HEADERS });
  if (!res.ok) throw new Error(`Items API ${res.status}`);
  const data = await res.json();
  return data.items;
}

// ─── Roblox: get owners of an asset (paginated) ───────────────────────────────
// Returns up to `limit` owners as [{ userId, username }]

async function getAssetOwners(assetId, limit = 50) {
  const owners = [];
  let cursor = '';

  while (owners.length < limit) {
    const url = `https://inventory.roblox.com/v2/assets/${assetId}/owners?limit=100&sortOrder=Asc${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`Roblox owners API ${res.status}`);
    const data = await res.json();

    for (const entry of (data.data || [])) {
      owners.push({
        userId: String(entry.owner?.id || entry.id),
        username: entry.owner?.name || entry.name || 'Unknown'
      });
      if (owners.length >= limit) break;
    }

    if (!data.nextPageCursor) break;
    cursor = data.nextPageCursor;
    await new Promise(r => setTimeout(r, 300)); // be polite
  }

  return owners;
}

// ─── Rolimons: player profile ─────────────────────────────────────────────────

async function getPlayerProfile(userId) {
  try {
    const res = await fetch(`https://www.rolimons.com/playerapi/player/${userId}`, { headers: ROLIMONS_HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ─── Roblox: avatar thumbnail ─────────────────────────────────────────────────

async function getRobloxThumbnail(userId) {
  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=48x48&format=Png&isCircular=false`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.imageUrl || null;
  } catch { return null; }
}

// ─── Trade ad tier from Rolimons badges ──────────────────────────────────────
// 0 = <10, 10 = 10+, 100 = 100+, 1000 = 1000+

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

// ─── Build results ────────────────────────────────────────────────────────────

async function buildResults(itemId, maxTier, ownerLimit) {
  // 1. Get owners from Roblox API
  const owners = await getAssetOwners(itemId, ownerLimit);
  console.log(`Got ${owners.length} owners for asset ${itemId}`);

  if (owners.length === 0) throw new Error('No owners found for this item via Roblox API.');

  // 2. Enrich with Rolimons profile in batches (respect ~10 req/min limit)
  const enriched = [];
  const batchSize = 5;

  for (let i = 0; i < owners.length; i += batchSize) {
    const batch = owners.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async o => {
      const [profile, thumbnail] = await Promise.all([
        getPlayerProfile(o.userId),
        getRobloxThumbnail(o.userId)
      ]);
      const tier = getTradeAdTier(profile?.rolibadges);
      return {
        userId: o.userId,
        username: o.username,
        tier,
        value: profile?.value ?? null,
        rap: profile?.rap ?? null,
        lastOnline: profile?.last_online ?? null,
        thumbnail,
        profileUrl: `https://www.rolimons.com/player/${o.userId}`,
        robloxUrl: `https://www.roblox.com/users/${o.userId}/profile`
      };
    }));
    enriched.push(...results);
    if (i + batchSize < owners.length) await new Promise(r => setTimeout(r, 700));
  }

  // 3. Filter by tier and sort by tier then value
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
    .setTitle(`🔎 Owners of: ${itemName}`)
    .setColor(0x5865F2)
    .setURL(`https://www.rolimons.com/item/${itemId}`)
    .setFooter({ text: `Page ${page + 1}/${totalPages} • ${results.length} owner${results.length !== 1 ? 's' : ''} matched` })
    .setTimestamp();

  if (results.length === 0) {
    embed.setDescription([
      '❌ No owners found matching your criteria.',
      '',
      '**Tips:**',
      '• Try a higher `max_ads` tier',
      '• Try increasing `scan_owners` to check more people',
      '• This item may have no Rolimons-tracked owners'
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
    .setDescription('Find owners of a Roblox limited with low trade ads on Rolimons')
    .setDMPermission(true)
    .addStringOption(opt =>
      opt.setName('item')
        .setDescription('Item name or Asset ID (e.g. "Valkyrie Helm" or 19027209)')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('max_ads')
        .setDescription('Max trade ads tier (default: under 100)')
        .setRequired(false)
        .addChoices(
          { name: 'Under 10 ads created', value: 0 },
          { name: 'Under 100 ads created', value: 10 },
          { name: 'Under 1000 ads created', value: 100 },
          { name: 'Any amount', value: 9999 }
        )
    )
    .addIntegerOption(opt =>
      opt.setName('scan_owners')
        .setDescription('How many owners to scan from Roblox (default: 50, max: 200)')
        .setRequired(false)
        .setMinValue(10)
        .setMaxValue(200)
    );

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [command.toJSON()] });
  console.log('✅ /lookfor registered v9 — Roblox owner API');
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
    const ownerLimit = interaction.options.getInteger('scan_owners') ?? 50;

    try {
      await interaction.editReply({ content: '⏳ Searching items...' });
      const allItems = await getAllItems();
      const matches = searchItems(allItems, query);

      if (matches.length === 0) {
        return interaction.editReply({ content: `❌ No items found matching **"${query}"**.` });
      }

      sessions.set(interaction.user.id, { maxTier, ownerLimit });

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
    const ownerLimit = session?.ownerLimit ?? 50;

    await interaction.update({ content: `✅ Fetching owners of **${itemName}** from Roblox...`, components: [] });

    try {
      await interaction.editReply({ content: `🔍 Scanning up to **${ownerLimit}** owners & checking Rolimons profiles...` });
      const results = await buildResults(itemId, maxTier, ownerLimit);
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
