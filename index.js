import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { createClient } from '@supabase/supabase-js';

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,   // optional -- set this while testing for instant command sync
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
// (Leviathan, Mythic) is excluded from roll_cast()'s own table and comes
// from a separate spawn mechanism, kept here for when that's wired up too.
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
});

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
