# BCD (Basic Consultant Dialogues) Discord Bot

A Discord bot for managing and conducting basic consultant dialogues, built with TypeScript and Discord.js.

This bot is a TypeScript port of the original [darkcalm/bcd](https://replit.com/@darkcalm/bcd#main.py) Python implementation.

## Features

- **Dialogue Management**: Create and manage consultant dialogues using `/bcd` commands
- **Interactive CLI**: Post messages and interact with Discord channels via terminal CLI
- **Message Reading**: Read channels and threads via slash commands
- **Session Management**: Handle dialogue sessions with reply-based updates

## How to run the bot:

1. Clone the repository: `git clone <repository-url>`
2. Install dependencies: `npm install`
3. Go to [Discord Developer Portal](https://discord.com/developers) and create a new application
4. Create a bot in the Bot tab and copy the token
5. Create `.env` file in project root with the following variables:
   ```
   DISCORD_BOT_TOKEN=your_bot_token_here
   CLIENT_ID=your_client_id_here
   GUILD_ID=your_guild_id_here (optional, for guild-specific commands)
   ```
6. Run `npm run develop` to start the bot in development mode
7. Try sending `/help` or `/ping` in your Discord server

## Available Scripts

- `npm run develop` — runs the bot in development mode with auto-reload
- `npm run start` — builds and runs the bot for production
- `npm run build-ts` — compiles TypeScript to JavaScript
- `npm run post` — launches interactive CLI for posting messages as the bot
- `npm run check-token` — checks if a Discord token is valid

## Commands

### Slash Commands

- `/help` — Show help information
- `/ping` — Check if the bot is responsive
- `/bcd` — Manage consultant dialogues (see_keys, diagram, assign, publish)
- `/readChannel` — Read messages from a channel
- `/readThread` — Read messages from a thread
- `/postMessage` — Post a message to a channel or thread
- `/checkToken` — Check if a Discord token is valid

### CLI Commands (when running `npm run post`)

- `i` — Focus input box to send messages
- `c` — Switch to channel selection mode
- `→` (right arrow) — Select a channel from the list
- `↑↓` — Navigate channels or scroll messages
- `Esc` or `q` — Exit the CLI

## Environment Variables

| Name              | Description                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| DISCORD_BOT_TOKEN | Bot token from Discord Developer Portal (Bot tab)                                                 |
| CLIENT_ID         | Application ID from Discord Developer Portal (General Information tab)                            |
| GUILD_ID          | Server ID (optional - if not provided, commands are registered globally)                          |

## Deploying to Heroku

1. Create a Heroku account
2. Connect your GitHub repository to Heroku
3. Deploy the bot to Heroku
4. On Heroku dashboard, go to `Resources`, disable `web` and enable `worker`
5. Set environment variables in Heroku settings

## License

MIT
