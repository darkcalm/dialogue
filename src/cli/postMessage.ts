/**
 * CLI tool to post messages as the bot
 * Uses Ink for interactive terminal UI with 1-column layout
 */

import { Client, GatewayIntentBits, TextChannel, ThreadChannel } from 'discord.js'
import { ChannelInfo } from './shared'
import { renderApp } from './ui/App'
import { showPlatformSelector } from './ui/showPlatformSelector'
import { PlatformType, IPlatformClient } from '@/platforms/types'
import { createPlatformClient } from '@/platforms/factory'
import config from '@/helpers/env'

async function main() {
  try {
    // Show platform selector
    const selectedPlatform = await showPlatformSelector()

    if (!selectedPlatform) {
      console.log('❌ No platform selected')
      process.exit(0)
    }

    console.log(`🔌 Connecting to ${selectedPlatform}...`)

    // Create platform client
    const platformClient = await createPlatformClient(selectedPlatform)
    await platformClient.connect()

    console.log('✅ Connected!\n')

    // Fetch all channels based on platform
    let channelList: ChannelInfo[] = []

    if (selectedPlatform === 'discord') {
      // Get native Discord client for channel scanning (temporary - will be refactored)
      const client = platformClient.getNativeClient() as Client

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
    } else {
      // For WhatsApp, use platform client to get channels
      const channels = await platformClient.getChannels()
      channelList = channels
      channelList.sort((a, b) => a.name.localeCompare(b.name))
    }

    if (channelList.length === 0) {
      console.log('❌ No accessible channels found')
      await platformClient.disconnect()
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
      client: platformClient,
      initialChannels: channelList,
      initialDisplayItems: displayItems,
      title: `${selectedPlatform.charAt(0).toUpperCase() + selectedPlatform.slice(1)} Bot CLI`,
      onExit: async () => {
        await platformClient.disconnect()
      }
    })

    await waitUntilExit()
    await platformClient.disconnect()
    process.exit(0)
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
}

// Run main
void main()
