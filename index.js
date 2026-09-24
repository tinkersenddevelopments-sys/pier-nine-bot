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

// 25 Sep -- pulled straight from the client's own SURGES array
// (deploy-index.html), not guessed: names AND colours. This also fixes a
// real inaccuracy that had been sitting here -- toxic's real name is "Toxic
// Bloom", not "Toxic Tide" -- and fills in freeze/ember, which previously
// fell back to a generic "X Surge" label because their names weren't
// confirmed yet.
const SURGE_NAMES = {
  toxic: 'Toxic Bloom',
  blood: 'Blood Moon',
  freeze: 'Deep Freeze',
  ember: 'Ember Tide',
};
const SURGE_HEX = {
  toxic: 0x63e06a,
  blood: 0xff3b2f,
  freeze: 0x8fe9ff,
  ember: 0xff8a18,
};

// 24 Sep -- the 7 Leviathan roles, in the exact rank order the game's own
// VARS array (deploy-index.html) and roll_cast()'s var_ids use: each entry
// is strictly rarer than the one before it. This is a single, ever-
// upgrading role -- landing a rarer variant swaps it in and removes
// whichever lower one was held; a worse catch afterwards never downgrades.
const LEVIATHAN_CHANNEL_ID = '1552756661696073921';

// 25 Sep, per Joseph: a scheduled/started world event (Blood Moon, Toxic
// Tide, etc. -- world_events.kind='single') should announce itself
// automatically, pinging @everyone: once when the warning window opens and
// again when it actually goes live. Deliberately NOT the Leviathan spawn
// pool (that opens every ~130-180s -- would spam this channel) and NOT the
// four-event auto-rotation ('rotation' kind) -- see pollWorldEvents() below.
const WORLD_EVENTS_CHANNEL_ID = '1552687913047822406';
const SURGE_COLOR = 0xffa726; // amber fallback, used only if a surge id isn't in SURGE_HEX

// 25 Sep, per Joseph: "when a new surge is chosen [every 3 days], that
// notification goes out... e.g. Monday it's Blood Moon, three days later
// it changes to Toxic". Separate from pollWorldEvents() above -- this is
// the deterministic daily-surge CALENDAR (SURGE_WINDOWS = 9-10/12-1/3-4/
// 6-7/9-10 each day, a new one picked every 3 days), not an admin action,
// so nothing is ever written to world_events for it. Ported verbatim from
// deploy-index.html's own SURGE_EPOCH/SURGE_EVERY/surgeOrder() -- confirmed
// bit-for-bit identical against the live client across 60 slots (~180
// days) before shipping, since this is a JS-to-JS port (both Node and
// Chrome are V8, so the same lossy-but-deterministic float64 math
// reproduces exactly) -- NOT the JS-to-SQL port documented elsewhere in
// this project that genuinely diverged past the 53-bit safe-integer range.
const SURGE_EPOCH = Date.UTC(2026, 0, 5); // a Monday, 00:00 UTC
const SURGE_EVERY = 3 * 24 * 3600 * 1000; // a new surge is chosen every 3 days
const SURGE_IDS = ['toxic', 'blood', 'freeze', 'ember']; // same order as the client's SURGES array
const SURGE_WINDOWS = [9, 12, 15, 18, 21]; // each a 1-hour window, start hour (UTC)
function surgeOrder(cycle) {
  const idx = SURGE_IDS.map((_, i) => i);
  let seed = (cycle * 2654435761) % 2147483647;
  for (let i = idx.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    const t = idx[i];
    idx[i] = idx[j];
    idx[j] = t;
  }
  return idx;
}
function currentSurgeSlot(nowMs) {
  const slot = Math.floor((nowMs - SURGE_EPOCH) / SURGE_EVERY);
  if (slot < 0) return null;
  const cycle = Math.floor(slot / SURGE_IDS.length);
  const pos = slot % SURGE_IDS.length;
  const surgeId = SURGE_IDS[surgeOrder(cycle)[pos]];
  const slotStart = SURGE_EPOCH + slot * SURGE_EVERY;
  const slotEnd = slotStart + SURGE_EVERY;
  return { slot, surgeId, slotStart, slotEnd };
}

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
// Discord's own <t:epoch:style> tag -- renders in each reader's local
// timezone automatically, no server-side timezone guessing needed.
// F = full date+time, R = relative ("in 12 minutes").
function discordTs(iso, style) {
  return `<t:${Math.round(new Date(iso).getTime() / 1000)}:${style}>`;
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
  pollWorldEvents();
  setInterval(pollWorldEvents, EVENT_POLL_MS);
  pollSurgeCalendar();
  setInterval(pollSurgeCalendar, EVENT_POLL_MS);
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

// ---------------------------------------------------------------------
// 25 Sep: scheduled/started world events announce themselves directly off
// world_events -- no bot_events row needed, since this is time-triggered
// (crossing a timestamp) rather than action-triggered (a player did
// something). Each UPDATE...RETURNING is one atomic claim: only a poll that
// actually flips a still-null flag gets the row back, so two poll cycles
// (or, if this bot ever runs more than one instance) can never double-post
// the same transition. kind='single' only -- the Leviathan pool and the
// four-event 'rotation' are excluded on purpose, see the const comment above.
// ---------------------------------------------------------------------
async function pollWorldEvents() {
  const nowIso = new Date().toISOString();

  // Warning window opened, event not live yet.
  const { data: warned, error: warnErr } = await supabase
    .from('world_events')
    .update({ warn_announced_at: nowIso })
    .eq('kind', 'single')
    .is('warn_announced_at', null)
    .lte('announce_at', nowIso)
    .gt('starts_at', nowIso)
    .gt('ends_at', nowIso)
    .select('*');
  if (warnErr) console.error('world_events warn-poll failed:', warnErr.message);
  for (const ev of warned || []) {
    await announceWorldEvent(ev, 'warn').catch((e) => console.error('world event warn announce failed:', e.message));
  }

  // Gone live (covers both a scheduled event reaching starts_at, and an
  // instant admin_start_event where announce_at===starts_at). An instant
  // start never matches the warn query above -- its starts_at is never
  // greater than now() by the time this bot first polls it -- so it skips
  // straight to this branch and gets exactly one post, the "live now" one.
  // warn_announced_at is deliberately left untouched here: the warn query's
  // own `gt('starts_at', nowIso)` already guarantees it can never match a
  // row that has gone live, regardless of what warn_announced_at holds, so
  // there's nothing to claim on this branch.
  const { data: live, error: liveErr } = await supabase
    .from('world_events')
    .update({ live_announced_at: nowIso })
    .eq('kind', 'single')
    .is('live_announced_at', null)
    .lte('starts_at', nowIso)
    .gt('ends_at', nowIso)
    .select('*');
  if (liveErr) console.error('world_events live-poll failed:', liveErr.message);
  for (const ev of live || []) {
    await announceWorldEvent(ev, 'live').catch((e) => console.error('world event live announce failed:', e.message));
  }
}

async function announceWorldEvent(ev, phase) {
  const channel = await client.channels.fetch(WORLD_EVENTS_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('could not reach the world-events announce channel', WORLD_EVENTS_CHANNEL_ID);
    return;
  }
  const name = surgeName(ev.surge_id);
  const embed = new EmbedBuilder().setColor(SURGE_HEX[ev.surge_id] ?? SURGE_COLOR);
  let body;
  if (phase === 'warn') {
    embed.setTitle(`${name} incoming`).setDescription(`Starts ${discordTs(ev.starts_at, 'R')} -- ${discordTs(ev.starts_at, 'F')}.`);
    body = `@everyone **${name}** is coming up.`;
  } else {
    embed.setTitle(`${name} is live`).setDescription(`Live now, until ${discordTs(ev.ends_at, 'R')} (${discordTs(ev.ends_at, 'F')}).`);
    body = `@everyone **${name}** is live now!`;
  }
  if (ev.note && ev.note !== 'scheduled') embed.addFields({ name: 'Note', value: String(ev.note).slice(0, 200) });
  await channel
    .send({ content: body, embeds: [embed], allowedMentions: { parse: ['everyone'] } })
    .catch((e) => console.error(`failed to post ${phase} announcement for world_events#${ev.id}:`, e.message));
}

// ---------------------------------------------------------------------
// 25 Sep, per Joseph: announce the daily surge calendar itself, once per
// 3-day slot change -- NOT once per daily window (that would be 5 posts a
// day; he explicitly wants the "a new one was chosen" moment only, e.g.
// "monday its bloodmoon... three days later... toxic is now live"). Uses
// bot_state (key='surge_slot') to survive a Railway redeploy without
// double-posting or missing a transition -- an in-memory-only flag would
// have re-announced the current slot every time this bot restarts.
// ---------------------------------------------------------------------
async function pollSurgeCalendar() {
  const cur = currentSurgeSlot(Date.now());
  if (!cur) return; // before SURGE_EPOCH -- shouldn't happen live, but a clean no-op if it ever does

  const { data: row, error } = await supabase.from('bot_state').select('value').eq('key', 'surge_slot').maybeSingle();
  if (error) {
    console.error('bot_state read failed:', error.message);
    return;
  }
  const lastSlot = row && typeof row.value?.slot === 'number' ? row.value.slot : null;
  if (lastSlot === cur.slot) return; // already the slot we last recorded -- nothing changed

  // Claim it first (atomic upsert), THEN announce -- if two poll cycles ever
  // overlapped (they won't, this bot is single-instance, but this is the
  // cheap-to-get-right order anyway), whichever one's write lands first is
  // the one that announces; the second sees lastSlot===cur.slot next read.
  const { error: writeErr } = await supabase
    .from('bot_state')
    .upsert({ key: 'surge_slot', value: { slot: cur.slot, surgeId: cur.surgeId }, updated_at: new Date().toISOString() });
  if (writeErr) {
    console.error('bot_state write failed:', writeErr.message);
    return;
  }

  // lastSlot === null means this bot has never recorded a slot before (first
  // ever run) -- record the baseline silently rather than announcing
  // whatever surge happens to already be running when the bot first boots.
  if (lastSlot === null) return;

  await announceSurgeChange(cur).catch((e) => console.error('surge-calendar announce failed:', e.message));
}

async function announceSurgeChange(cur) {
  const channel = await client.channels.fetch(WORLD_EVENTS_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('could not reach the world-events announce channel', WORLD_EVENTS_CHANNEL_ID);
    return;
  }
  const name = surgeName(cur.surgeId);
  const windows = SURGE_WINDOWS.map((h) => `${h}:00-${h + 1}:00`).join(', ');
  const embed = new EmbedBuilder()
    .setColor(SURGE_HEX[cur.surgeId] ?? SURGE_COLOR)
    .setTitle(`${name} is the new surge`)
    .setDescription(
      `Live daily ${windows} UTC, until ${discordTs(cur.slotEnd, 'R')} (${discordTs(cur.slotEnd, 'F')}).`
    );
  await channel
    .send({ content: `@everyone **${name}** has been chosen as the new surge.`, embeds: [embed], allowedMentions: { parse: ['everyone'] } })
    .catch((e) => console.error('failed to post surge-change announcement:', e.message));
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
