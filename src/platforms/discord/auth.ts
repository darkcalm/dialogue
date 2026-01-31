/**
 * Discord authentication and connection management
 */

import { Client, IntentsBitField } from 'discord.js'
import config from '@/helpers/env'

/**
 * Create and configure a Discord client with required intents
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      IntentsBitField.Flags.Guilds,
      IntentsBitField.Flags.GuildMessages,
      IntentsBitField.Flags.DirectMessages,
      IntentsBitField.Flags.MessageContent,
      IntentsBitField.Flags.GuildMessageReactions,
      IntentsBitField.Flags.DirectMessageReactions,
    ],
  })
}

/**
 * Authenticate and connect to Discord
 */
export async function connectDiscord(client: Client): Promise<void> {
  return new Promise((resolve, reject) => {
    // Set up ready handler (clientReady in discord.js v15+)
    client.once('clientReady', () => {
      resolve()
    })

    // Set up error handler
    client.once('error', (error) => {
      reject(error)
    })

    // Login with token
    client.login(config.DISCORD_BOT_TOKEN).catch(reject)
  })
}

/**
 * Disconnect from Discord
 */
export async function disconnectDiscord(client: Client): Promise<void> {
  await client.destroy()
}
