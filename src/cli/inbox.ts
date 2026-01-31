/**
 * CLI tool to show inbox-style channel grouping
 * Groups channels by: @-mentions, new messages, never visited
 * Uses Ink for interactive terminal UI with 1-column layout
 */

import { Client, GatewayIntentBits, TextChannel, ThreadChannel } from 'discord.js'
import {
  ChannelInfo,
  loadVisitData,
  removeChannelVisit,
} from './shared'
import { renderApp } from './ui/App'
import { showPlatformSelector } from './ui/showPlatformSelector'
import { PlatformType, IPlatformClient } from '@/platforms/types'
import { createPlatformClient } from '@/platforms/factory'
import config from '@/helpers/env'

interface InboxChannelInfo extends ChannelInfo {
  group: 'mentions' | 'new' | 'unvisited' | 'visited'
  mentionCount?: number
  newMessageCount?: number
  lastMessageTimestamp?: Date
}

// Build WhatsApp inbox with grouping
async function buildWhatsAppInbox(platformClient: IPlatformClient): Promise<{
  channels: InboxChannelInfo[]
  displayItems: string[]
  displayIndexToChannelIndex: Map<number, number>
}> {
  const visitData = loadVisitData()
  const channels = await platformClient.getChannels()

  const newMessageChannels: InboxChannelInfo[] = []
  const unvisitedChannels: InboxChannelInfo[] = []
  const visitedChannels: InboxChannelInfo[] = []

  for (const channel of channels) {
    // Get chat metadata for last message info
    const chatMetadata = channel.metadata?.nativeChat as any
    const unreadCount = chatMetadata?.unreadCount || 0
    const lastMessageTimestamp = chatMetadata?.conversationTimestamp
      ? new Date(chatMetadata.conversationTimestamp * 1000)
      : undefined

    const channelInfo: InboxChannelInfo = {
      ...channel,
      group: 'visited',
      lastMessageTimestamp,
    }

    // Check visit data (use platform-prefixed key)
    const visitKey = `whatsapp:${channel.id}`
    const channelVisit = visitData[visitKey] || visitData[channel.id] // fallback to old format

    if (!channelVisit) {
      // Never visited
      channelInfo.group = 'unvisited'
      if (unreadCount > 0) {
        channelInfo.newMessageCount = unreadCount
      }
    } else {
      // Check for new messages since last visit
      const lastVisitDate = new Date(channelVisit.lastVisited)

      if (unreadCount > 0 || (lastMessageTimestamp && lastMessageTimestamp > lastVisitDate)) {
        channelInfo.group = 'new'
        channelInfo.newMessageCount = unreadCount || 1
      } else {
        channelInfo.group = 'visited'
      }
    }

    // Categorize
    switch (channelInfo.group) {
      case 'new':
        newMessageChannels.push(channelInfo)
        break
      case 'unvisited':
        unvisitedChannels.push(channelInfo)
        break
      case 'visited':
        visitedChannels.push(channelInfo)
        break
    }
  }

  // Sort by timestamp (most recent first)
  const sortByTimestamp = (a: InboxChannelInfo, b: InboxChannelInfo) => {
    if (!a.lastMessageTimestamp && !b.lastMessageTimestamp) return 0
    if (!a.lastMessageTimestamp) return 1
    if (!b.lastMessageTimestamp) return -1
    return b.lastMessageTimestamp.getTime() - a.lastMessageTimestamp.getTime()
  }

  newMessageChannels.sort(sortByTimestamp)
  unvisitedChannels.sort(sortByTimestamp)
  visitedChannels.sort(sortByTimestamp)

  // Build display list
  const displayItems: string[] = []
  const channelList: InboxChannelInfo[] = []
  const displayIndexToChannelIndex: Map<number, number> = new Map()
  let channelIndex = 0

  if (newMessageChannels.length > 0) {
    displayItems.push(`══════ 🆕 NEW MESSAGES (${newMessageChannels.length}) ══════`)
    newMessageChannels.forEach(ch => {
      const badge = ch.newMessageCount ? ` [${ch.newMessageCount} new]` : ''
      displayItems.push(`${ch.name}${badge}`)
      displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
      channelList.push(ch)
      channelIndex++
    })
  }

  if (visitedChannels.length > 0) {
    displayItems.push(`══════ ✓ UP TO DATE (${visitedChannels.length}) ══════`)
    visitedChannels.forEach(ch => {
      displayItems.push(ch.name)
      displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
      channelList.push(ch)
      channelIndex++
    })
  }

  return { channels: channelList, displayItems, displayIndexToChannelIndex }
}

// Build channel list and display items (reusable for refresh)
async function buildInboxChannels(client: Client, hideUnvisited: boolean = true): Promise<{
  channels: InboxChannelInfo[]
  displayItems: string[]
  displayIndexToChannelIndex: Map<number, number>
}> {
  const visitData = loadVisitData()
  const botUserId = client.user?.id

  const mentionChannels: InboxChannelInfo[] = []
  const newMessageChannels: InboxChannelInfo[] = []
  const unvisitedChannels: InboxChannelInfo[] = []
  const visitedChannels: InboxChannelInfo[] = []
  
  for (const [guildId, guild] of client.guilds.cache) {
    for (const [channelId, channel] of guild.channels.cache) {
      if (channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
        const permissions = channel.permissionsFor(guild.members.me!)
        if (!permissions?.has('ViewChannel') || !permissions?.has('SendMessages')) {
          continue
        }
        
        const channelInfo: InboxChannelInfo = {
          id: channel.id,
          name: channel.name,
          type: channel.isThread() ? 'thread' : 'text',
          guildName: guild.name,
          group: 'visited',
        }

        const channelVisit = visitData[channel.id]
        
        try {
          const messages = await channel.messages.fetch({ limit: 50 })
          const messagesArray = Array.from(messages.values())
          
          if (messagesArray.length > 0) {
            channelInfo.lastMessageTimestamp = new Date(messagesArray[0].createdTimestamp)
          }

          const mentionMessages = messagesArray.filter(msg => 
            msg.mentions.users.has(botUserId!) || 
            msg.content.includes(`<@${botUserId}>`) ||
            msg.content.includes(`<@!${botUserId}>`)
          )
          
          if (!channelVisit) {
            channelInfo.group = 'unvisited'
            channelInfo.newMessageCount = messagesArray.length
            
            if (mentionMessages.length > 0) {
              channelInfo.group = 'mentions'
              channelInfo.mentionCount = mentionMessages.length
            }
          } else {
            const lastVisitDate = new Date(channelVisit.lastVisited)
            
            const newMessages = messagesArray.filter(msg => 
              new Date(msg.createdTimestamp) > lastVisitDate &&
              msg.author.id !== botUserId
            )
            
            const newMentions = mentionMessages.filter(msg =>
              new Date(msg.createdTimestamp) > lastVisitDate
            )
            
            if (newMentions.length > 0) {
              channelInfo.group = 'mentions'
              channelInfo.mentionCount = newMentions.length
            } else if (newMessages.length > 0) {
              channelInfo.group = 'new'
              channelInfo.newMessageCount = newMessages.length
            } else {
              channelInfo.group = 'visited'
            }
          }
        } catch (err) {
          if (!channelVisit) {
            channelInfo.group = 'unvisited'
          }
        }

        switch (channelInfo.group) {
          case 'mentions':
            mentionChannels.push(channelInfo)
            break
          case 'new':
            newMessageChannels.push(channelInfo)
            break
          case 'unvisited':
            unvisitedChannels.push(channelInfo)
            break
          case 'visited':
            visitedChannels.push(channelInfo)
            break
        }
      }
    }
  }

  const sortByTimestamp = (a: InboxChannelInfo, b: InboxChannelInfo) => {
    if (!a.lastMessageTimestamp && !b.lastMessageTimestamp) return 0
    if (!a.lastMessageTimestamp) return 1
    if (!b.lastMessageTimestamp) return -1
    return b.lastMessageTimestamp.getTime() - a.lastMessageTimestamp.getTime()
  }

  mentionChannels.sort(sortByTimestamp)
  newMessageChannels.sort(sortByTimestamp)
  unvisitedChannels.sort(sortByTimestamp)
  visitedChannels.sort(sortByTimestamp)

  const displayItems: string[] = []
  const channelList: InboxChannelInfo[] = []
  const displayIndexToChannelIndex: Map<number, number> = new Map()
  let channelIndex = 0
  
  if (mentionChannels.length > 0) {
    displayItems.push(`══════ 📢 MENTIONS (${mentionChannels.length}) ══════`)
    mentionChannels.forEach(ch => {
      const badge = ch.mentionCount ? ` [${ch.mentionCount} @]` : ''
      displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}${badge}`)
      displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
      channelList.push(ch)
      channelIndex++
    })
  }
  
  if (newMessageChannels.length > 0) {
    displayItems.push(`══════ 🆕 NEW MESSAGES (${newMessageChannels.length}) ══════`)
    newMessageChannels.forEach(ch => {
      const badge = ch.newMessageCount ? ` [${ch.newMessageCount} new]` : ''
      displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}${badge}`)
      displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
      channelList.push(ch)
      channelIndex++
    })
  }
  
  // Hide unvisited by default
  if (!hideUnvisited && unvisitedChannels.length > 0) {
    displayItems.push(`══════ 👀 NEVER VISITED (${unvisitedChannels.length}) ══════`)
    unvisitedChannels.forEach(ch => {
      displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}`)
      displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
      channelList.push(ch)
      channelIndex++
    })
  }
  
  if (visitedChannels.length > 0) {
    displayItems.push(`══════ ✓ UP TO DATE (${visitedChannels.length}) ══════`)
    visitedChannels.forEach(ch => {
      displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}`)
      displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
      channelList.push(ch)
      channelIndex++
    })
  }

  return { channels: channelList, displayItems, displayIndexToChannelIndex }
}

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

    console.log('✅ Connected!')
    console.log('📥 Scanning channels for inbox...')

    // Build initial channel list based on platform
    let inboxData: {
      channels: InboxChannelInfo[]
      displayItems: string[]
      displayIndexToChannelIndex: Map<number, number>
    }

    if (selectedPlatform === 'discord') {
      // Get native Discord client for inbox scanning (temporary - will be refactored)
      const client = platformClient.getNativeClient() as Client
      inboxData = await buildInboxChannels(client)
    } else {
      // For WhatsApp, build grouped inbox
      inboxData = await buildWhatsAppInbox(platformClient)
    }
    
    if (inboxData.channels.length === 0) {
      console.log('❌ No accessible channels found')
      await client.destroy()
      process.exit(0)
    }

    console.log(`Found ${inboxData.channels.length} channels`)
    console.log('Starting UI...\n')

    // Helper to get channel from display index (uses closure over current inboxData)
    const getChannelFromDisplayIndex = (displayIndex: number, channels: ChannelInfo[]): ChannelInfo | null => {
      const channelIdx = inboxData.displayIndexToChannelIndex.get(displayIndex)
      if (channelIdx === undefined) return null
      return inboxData.channels[channelIdx] || null
    }

    // Refresh callback - rebuilds channel list
    const onRefreshChannels = async () => {
      if (selectedPlatform === 'discord') {
        const client = platformClient.getNativeClient() as Client
        inboxData = await buildInboxChannels(client)
      } else {
        inboxData = await buildWhatsAppInbox(platformClient)
      }
      return { channels: inboxData.channels, displayItems: inboxData.displayItems }
    }

    // Unfollow callback - removes visit data and rebuilds
    const onUnfollowChannel = async (channel: ChannelInfo) => {
      removeChannelVisit(channel.id)
      if (selectedPlatform === 'discord') {
        const client = platformClient.getNativeClient() as Client
        inboxData = await buildInboxChannels(client)
      } else {
        await onRefreshChannels()
      }
      return { channels: inboxData.channels, displayItems: inboxData.displayItems }
    }

    // Render the Ink app
    const { waitUntilExit } = renderApp({
      client: platformClient,
      initialChannels: inboxData.channels,
      initialDisplayItems: inboxData.displayItems,
      title: `${selectedPlatform.charAt(0).toUpperCase() + selectedPlatform.slice(1)} Inbox`,
      getChannelFromDisplayIndex,
      onRefreshChannels,
      onUnfollowChannel,
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
