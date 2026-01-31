/**
 * CLI tool to post messages as the bot
 * Uses Ink for interactive terminal UI with 1-column layout
 */

import { Client, GatewayIntentBits, TextChannel, ThreadChannel } from 'discord.js'
import { ChannelInfo } from './shared'
import { renderApp } from './ui/App'
import config from '@/helpers/env'

async function main() {
  try {
    console.log('🔌 Connecting to Discord...')
    
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })

    await client.login(config.DISCORD_BOT_TOKEN)

    await new Promise((resolve) => {
      if (client.isReady()) {
        resolve(undefined)
      } else {
        client.once('clientReady', resolve)
      }
    })

    console.log('✅ Connected!\n')

    // Fetch all channels
    const channelList: ChannelInfo[] = []
    
    for (const [guildId, guild] of client.guilds.cache) {
      for (const [channelId, channel] of guild.channels.cache) {
        if (channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
          const permissions = channel.permissionsFor(guild.members.me!)
          if (permissions?.has('SendMessages')) {
            channelList.push({
              id: channel.id,
              name: channel.name,
              type: channel.isThread() ? 'thread' : 'text',
              guildName: guild.name,
            })
          }
        }
      }
    }

    channelList.sort((a, b) => {
      if (a.guildName !== b.guildName) {
        return (a.guildName || '').localeCompare(b.guildName || '')
      }
      return a.name.localeCompare(b.name)
    })

    if (channelList.length === 0) {
      console.log('❌ No accessible channels found')
      await client.destroy()
      process.exit(0)
    }

    console.log(`Found ${channelList.length} channels`)
    console.log('Starting UI...\n')

    // Build display items (simple list without headers)
    const displayItems = channelList.map((ch) => 
      `${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}${ch.type === 'thread' ? ' (thread)' : ''}`
    )

    // Render the Ink app
    const { waitUntilExit } = renderApp({
      client,
      initialChannels: channelList,
      initialDisplayItems: displayItems,
      title: 'Discord Bot CLI',
      onExit: async () => {
        await client.destroy()
      }
    })

    await waitUntilExit()
    await client.destroy()
    process.exit(0)
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
}

// Run main
void main()
