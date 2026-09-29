// World boss announcer: posts to one channel when The Colossal is
// 15 minutes out, when it surfaces, and how it ended. Polls Supabase every
// 30s with the service role (read-only: it never writes to the database).
//
// Posts to the same world-events channel as the surge announcements and
// pings @everyone on the warning and the surfacing (not on the result), the
// same way those do. No new env vars: the channel is passed in from index.js.
//
// Hotspots are deliberately not announced (Joseph, 28 Sep).

import { EmbedBuilder } from 'discord.js';

const POLL_MS = 30_000;
const WARN_MIN = 15;
const IVORY = 0xe9dfc7;

export function startWbossAnnouncer(client, supabase, channelId) {
  if (!channelId) {
    console.log('World boss announcer off (no channel).');
    return;
  }

  const warned = new Set();   // "sea:timestamp"
  const surfaced = new Set(); // boss id
  const ended = new Set();    // boss id
  let booted = false;
  let channel = null;

  const ping = '@everyone ';
  const allowed = { allowedMentions: { parse: ['everyone'] } };
  const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);
  const money = (n) => '£' + Math.round(Number(n || 0)).toLocaleString('en-GB');

  async function send(payload) {
    if (!channel) channel = await client.channels.fetch(channelId);
    await channel.send({ ...allowed, ...payload });
  }

  async function tick() {
    const now = Date.now();
    const since = new Date(now - 6 * 3600_000).toISOString();

    const [{ data: seas, error: e1 }, { data: bosses, error: e2 }] = await Promise.all([
      supabase.from('seas').select('id, next_wboss_at'),
      supabase.from('world_bosses').select('id, sea_id, hp, hp_max, spawned_at, ends_at, killed_at, forced').gte('spawned_at', since).order('id'),
    ]);
    if (e1 || e2) throw e1 || e2;
    const manySeas = (seas || []).length > 1;
    const where = (sea) => (manySeas ? ` (Sea ${sea})` : '');

    // first pass after a restart: remember what already happened, post nothing old
    if (!booted) {
      for (const s of seas || []) {
        if (s.next_wboss_at && new Date(s.next_wboss_at) - now <= WARN_MIN * 60_000) warned.add(`${s.id}:${s.next_wboss_at}`);
      }
      for (const b of bosses || []) {
        const done = b.killed_at || new Date(b.ends_at) <= now;
        if (done) { surfaced.add(b.id); ended.add(b.id); }
        else if (now - new Date(b.spawned_at) > 120_000) surfaced.add(b.id);
      }
      booted = true;
    }

    // 15 minutes out
    for (const s of seas || []) {
      if (!s.next_wboss_at) continue;
      const left = new Date(s.next_wboss_at) - now, key = `${s.id}:${s.next_wboss_at}`;
      if (left > 0 && left <= WARN_MIN * 60_000 && !warned.has(key)) {
        warned.add(key);
        await send({ content: `${ping}**The Colossal** surfaces in the Bone Waters${where(s.id)} <t:${unix(s.next_wboss_at)}:R>. Get your boat out there.` });
      }
    }

    for (const b of bosses || []) {
      const done = b.killed_at || new Date(b.ends_at) <= now;

      // it's up
      if (!surfaced.has(b.id)) {
        surfaced.add(b.id);
        if (!done) {
          await send({
            content: `${ping}**The Colossal has surfaced** in the Bone Waters${where(b.sea_id)}.`,
            embeds: [new EmbedBuilder()
              .setColor(IVORY)
              .setTitle('The Colossal · world boss')
              .setDescription(`${b.hp_max.toLocaleString('en-GB')} energy. Everyone on the sea can fight it. It dives <t:${unix(b.ends_at)}:R>.\nThe pot is shared by damage; the top angler lands the fish.`)],
          });
        }
      }

      // how it ended
      if (done && !ended.has(b.id)) {
        ended.add(b.id);
        const { data: hits, error } = await supabase
          .from('world_boss_hits')
          .select('dmg, paid, profiles(handle, tag)')
          .eq('boss_id', b.id)
          .order('dmg', { ascending: false })
          .limit(3);
        if (error) throw error;
        const { count } = await supabase.from('world_boss_hits').select('user_id', { count: 'exact', head: true }).eq('boss_id', b.id);
        const podium = (hits || []).map((h, i) =>
          `${['🥇', '🥈', '🥉'][i]} **${h.profiles ? h.profiles.handle + (h.profiles.tag || '') : 'someone'}** · ${h.dmg.toLocaleString('en-GB')} damage${h.paid ? ' · ' + money(h.paid) : ''}`
        ).join('\n');
        const title = b.killed_at ? 'The Colossal has been landed' : 'The Colossal dived';
        const body = b.killed_at
          ? `${count || 0} anglers took it down${where(b.sea_id)}.\n\n${podium || ''}`
          : `It got away with ${b.hp.toLocaleString('en-GB')} / ${b.hp_max.toLocaleString('en-GB')} energy left. Nobody gets paid.${podium ? '\n\n' + podium : ''}`;
        await send({ embeds: [new EmbedBuilder().setColor(IVORY).setTitle(title).setDescription(body)], allowedMentions: { parse: [] } });
      }
    }
  }

  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (e) { console.error('World boss announcer:', e.message || e); }
    running = false;
  };
  loop();
  setInterval(loop, POLL_MS);
  console.log(`World boss announcer on (channel ${channelId}).`);
}
