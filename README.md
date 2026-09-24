# Pier Nine Discord bot

`/link` and `/stats` slash commands, backed by the `pier-nine` Supabase project.

## Run it (locally, or on any host -- NOT this Cowork sandbox, which can't reach discord.com)

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DISCORD_TOKEN` -- Discord Developer Portal -> your app -> Bot -> Reset Token
   - `DISCORD_CLIENT_ID` -- your app's Application ID (General Information tab)
   - `DISCORD_GUILD_ID` -- optional, your server's ID (enable Developer Mode in Discord,
     right-click your server icon -> Copy Server ID). Set this while testing so slash
     commands register instantly; global registration (no guild id) can take up to an
     hour the first time.
   - `SUPABASE_URL` -- https://foqjwozwegmzpmnbwzfe.supabase.co
   - `SUPABASE_SERVICE_ROLE_KEY` -- Supabase dashboard -> pier-nine project ->
     Project Settings -> API -> service_role secret key. NOT the publishable/anon key --
     this one bypasses row-level security, so treat it like a password. Never put it
     in a client-side file or a public repo.
3. `node --env-file=.env index.js`

## Deploy (Railway, recommended)

1. Push this folder to a GitHub repo (or use `railway up` from the CLI in this folder).
2. In Railway: New Project -> Deploy from GitHub repo (or the CLI upload).
3. Set the same four env vars as above in Railway's Variables tab.
4. Railway runs `npm install` and `npm start` automatically. Leave it running --
   that's what keeps the bot online.

## What each command does

- `/link <code>` -- claims the one-time code the game shows on its "Link Discord"
  screen, sets `profiles.discord_id` for that account.
- `/stats` -- pulls money, best-ever catch, weekly board rank and earned badges via
  the `discord_player_card()` Supabase function, one round trip.

## Known gaps, not yet wired

- The game doesn't have a "Link Discord" screen yet showing the code from
  `create_discord_link_code()` -- needs a small in-game UI addition.
- Nothing in the game yet calls `grant_catch_achievement()` /
  `grant_event_achievement()` at the moment a Legendary/Mythic fish is actually
  kept, or a fish lands during a live surge -- badges won't populate until that's
  wired into the client's catch-landing code.
- `freeze` and `ember` surge display names are placeholders ("Freeze Surge",
  "Ember Surge") -- swap in `SURGE_NAMES` in index.js once real names exist.
