import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { createClient } from '@supabase/supabase-js';

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,   // optional for slash-command sync, REQUIRED for the
                       // auto-announce/Leviathan-role features below -- both
                       // need a specific guild to look members up in.
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

for (const [name, val] of Object.entries({ DISCORD_TOKEN, DISCORD_CLIENT_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Display names confirmed against claude/art-and-neon.md. mort/bishop are the
// only tier-4 (Legendary) species roll_cast() can actually produce; lev
// (Leviathan, Mythic) used to be excluded from roll_cast()'s own table --
// 24 Sep, it's reachable again, gated on a real shared spawn pool.
const SPEC_NAMES = {
  mort: 'Mortgage Shark',
  bishop: 'Bishop of the Deep',
  lev: 'Leviathan of Slough',
};
const TIER_LABEL = { 4: 'Legendary', 5: 'Mythic' };

// blood/toxic confirmed in project docs (Blood Moon, Toxic Tide). freeze/
// ember are real surge ids in roll_cast() but no confirmed display name yet
// -- falls back to a generic label rather than guessing one. Swap these in
// once Joseph confirms them.
const SURGE_NAMES = {
  blood: 'Blood Moon',
  toxic: 'Toxic Tide',
};

// 24 Sep -- the 7 Leviathan roles, in the exact rank order the game's own
// VARS array (deploy-index.html) and roll_cast()'s var_ids use: each entry
// is strictly rarer than the one before it. This is a single, ever-
// upgrading role -- landing a rarer variant swaps it in and removes
// whichever lower one was held; a worse catch afterwards never downgrades.
const LEVIATHAN_CHANNEL_ID = '1552756661696073921';
const LEVIATHAN_ROLES = [
  { va: null, name: 'Leviathan', roleId: '1552759685738664036' },
  { va: 'gold', name: 'Gold Leviathan', roleId: '1552760077495177317' },
  { va: 'dia', name: 'Diamond Leviathan', roleId: '1552760238942195743' },
  { va: 'blood', name: 'Bloodrot Leviathan', roleId: '1552760320253231215' },
  { va: 'lava', name: 'Lava Leviathan', roleId: '1552760446631682232' },
  { va: 'galaxy', name: 'Galaxy Leviathan', roleId: '1552760513409187900' },
  { va: 'rain', name: 'Rainbow Leviathan', roleId: '1552760607261069455' },
];
function leviathanRoleIndex(va) {
  const i = LEVIATHAN_ROLES.findIndex((r) => r.va === (va || null));
  return i < 0 ? 0 : i;
}

function speciesName(id) {
  return SPEC_NAMES[id] || (id.charAt(0).toUpperCase() + id.slice(1));
}
function surgeName(id) {
  return SURGE_NAMES[id] || (id.charAt(0).toUpperCase() + id.slice(1) + ' Surge');
}
function money(n) {
  return '£' + Math.round(Number(n || 0)).toLocaleString('en-GB');
}

const commands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Pier Nine account to Discord')
    .addStringOption((o) =>
      o.setName('code').setDescription('The code shown on the Link Discord screen in-game').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show your Pier Nine stats'),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    const route = DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
      : Routes.applicationCommands(DISCORD_CLIENT_ID);
    await rest.put(route, { body: commands });
    console.log(
      'Slash commands registered' +
        (DISCORD_GUILD_ID ? ' (guild-scoped, instant).' : ' (global -- can take up to an hour the first time).')
    );
  } catch (e) {
    console.error('Failed to register slash commands:', e);
  }

  if (!DISCORD_GUILD_ID) {
    console.warn(
      'DISCORD_GUILD_ID is not set -- the auto-announce and Leviathan role ' +
        'features need a specific guild to look members up in, so they will ' +
        'silently no-op until it is set. /link and /stats are unaffected.'
    );
  }

  startEventPoller();
});

// ---------------------------------------------------------------------
// 24 Sep: bot_events is the queue the server writes to for anything this
// bot needs to react to asynchronously -- a Discord link (auto-announce)
// or a genuine, server-verified Leviathan catch (role grant/upgrade).
// Both are written by SECURITY DEFINER database functions the moment the
// real thing happens server-side, so there's nothing to trust here beyond
// "this row exists" -- no client input is read directly.
// ---------------------------------------------------------------------
const EVENT_POLL_MS = 10000;
function startEventPoller() {
  pollEvents();
  setInterval(pollEvents, EVENT_POLL_MS);
}

async function pollEvents() {
  const { data: events, error } = await supabase
    .from('bot_events')
    .select('*')
    .is('processed_at', null)
    .order('id', { ascending: true })
    .limit(20);
  if (error) {
    console.error('bot_events fetch failed:', error.message);
    return;
  }
  for (const ev of events || []) {
    try {
      if (ev.kind === 'discord_link') await handleDiscordLink(ev.payload);
      else if (ev.kind === 'leviathan_catch') await handleLeviathanCatch(ev.payload);
    } catch (e) {
      console.error(`failed to process bot_event #${ev.id} (${ev.kind}):`, e && e.message ? e.message : e);
    }
    // Marked processed either way. A bad event (member left the server, a
    // one-off Discord API hiccup, etc.) should never wedge the whole queue
    // by retrying forever -- it's logged above instead.
    const { error: markErr } = await supabase
      .from('bot_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', ev.id);
    if (markErr) console.error(`failed to mark bot_event #${ev.id} processed:`, markErr.message);
  }
}

async function getGuild() {
  if (!DISCORD_GUILD_ID) return null;
  return client.guilds.cache.get(DISCORD_GUILD_ID) || (await client.guilds.fetch(DISCORD_GUILD_ID).catch(() => null));
}

async function handleDiscordLink(payload) {
  if (!payload || !payload.discord_id) return;
  if (!DISCORD_GUILD_ID) return;
  const channel = await client.channels.fetch(LEVIATHAN_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('could not reach the announce channel', LEVIATHAN_CHANNEL_ID);
    return;
  }
  const { data: card, error } = await supabase.rpc('discord_player_card', { p_discord_id: payload.discord_id });
  if (error || !card) {
    console.error('discord_player_card failed for link announce:', error && error.message);
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle(`${card.handle}${card.tag} just connected Discord`)
    .setColor(0x2ecc71)
    .addFields(
      { name: 'Money', value: money(card.active_money), inline: true },
      { name: 'Licence', value: `Class ${card.lic_class}`, inline: true },
      {
        name: 'Best catch ever',
        value: card.best_fish ? `${card.best_fish} (${money(card.best_value)})` : '_None yet_',
        inline: false,
      }
    );
  await channel
    .send({ content: `<@${payload.discord_id}>`, embeds: [embed] })
    .catch((e) => console.error('failed to post link announcement:', e.message));
}

async function handleLeviathanCatch(payload) {
  if (!payload || !payload.discord_id) return; // not linked to Discord -- nothing to grant
  const guild = await getGuild();
  if (!guild) return;
  const member = await guild.members.fetch(payload.discord_id).catch(() => null);
  if (!member) {
    console.warn(`Leviathan catch by discord id ${payload.discord_id}, but they're not in the server -- no role to grant`);
    return;
  }

  const newIdx = leviathanRoleIndex(payload.variant);
  const held = LEVIATHAN_ROLES
    .map((r, i) => ({ i, roleId: r.roleId, has: member.roles.cache.has(r.roleId) }))
    .filter((r) => r.has);
  const bestHeldIdx = held.length ? Math.max(...held.map((r) => r.i)) : -1;

  if (newIdx <= bestHeldIdx) return; // one evolving role, upgrade-only -- never a downgrade

  const toRemove = held.filter((r) => r.i !== newIdx).map((r) => r.roleId);
  if (toRemove.length) {
    await member.roles.remove(toRemove).catch((e) => console.error('failed to remove old Leviathan role:', e.message));
  }
  await member.roles
    .add(LEVIATHAN_ROLES[newIdx].roleId)
    .catch((e) => console.error('failed to add Leviathan role:', e.message));
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'link') {
    const code = interaction.options.getString('code', true).trim();
    await interaction.deferReply({ ephemeral: true });
    const { data, error } = await supabase.rpc('claim_discord_link', {
      p_code: code,
      p_discord_id: interaction.user.id,
    });
    if (error) {
      await interaction.editReply(`Something went wrong on my end: ${error.message}`);
      return;
    }
    if (!data?.ok) {
      const reason =
        data?.reason === 'discord_already_linked'
          ? 'That Discord account is already linked to a different Pier Nine account.'
          : "That code's wrong or has expired -- grab a fresh one from the game's Link Discord screen and try again within 10 minutes.";
      await interaction.editReply(reason);
      return;
    }
    await interaction.editReply(`Linked! You're now **${data.handle}${data.tag}** in here.`);
    return;
  }

  if (interaction.commandName === 'stats') {
    await interaction.deferReply({ ephemeral: true });
    const { data: card, error } = await supabase.rpc('discord_player_card', {
      p_discord_id: interaction.user.id,
    });
    if (error) {
      await interaction.editReply(`Something went wrong on my end: ${error.message}`);
      return;
    }
    if (!card) {
      await interaction.editReply(
        "You're not linked yet -- run `/link` with the code from the game's Link Discord screen first."
      );
      return;
    }

    const badges = card.badges || [];
    const badgeLines = badges.length
      ? badges
          .map((b) =>
            b.kind === 'catch_rarity'
              ? `${TIER_LABEL[b.tier] || 'Rare'} catch: ${speciesName(b.key)}`
              : `Event: ${surgeName(b.key)} angler`
          )
          .join('\n')
      : '_None yet_';

    const embed = new EmbedBuilder()
      .setTitle(`${card.handle}${card.tag}`)
      .setColor(0x2ecc71)
      .addFields(
        { name: 'Money', value: money(card.active_money), inline: true },
        { name: 'Lifetime', value: money(card.lifetime_money), inline: true },
        { name: 'Licence', value: `Class ${card.lic_class}`, inline: true },
        {
          name: 'Best catch ever',
          value: card.best_fish ? `${card.best_fish} (${money(card.best_value)})` : '_None yet_',
          inline: false,
        },
        { name: 'Weekly board', value: `#${card.week_rank} of ${card.week_total}`, inline: false },
        { name: 'Badges', value: badgeLines, inline: false }
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }
});

client.login(DISCORD_TOKEN).catch((e) => {
  console.error('Login failed -- check DISCORD_TOKEN is correct and not expired/reset:', e.message || e);
  process.exit(1);
});
