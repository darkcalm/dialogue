/**
 * CLI tool to show inbox-style channel grouping
 * Groups channels by: @-mentions, new messages, never visited
 * Uses Ink for interactive terminal UI with 1-column layout
 */

import { Client, GatewayIntentBits, TextChannel, ThreadChannel, Message } from 'discord.js'
import {
  ChannelInfo,
  loadVisitData,
  removeChannelVisit,
  markChannelVisited,
  platformMessageToMessageInfo,
} from './shared'
import { renderApp } from './ui/App'
import { showPlatformSelector } from './ui/showPlatformSelector'
import { PlatformType, IPlatformClient } from '@/platforms/types'
import { createPlatformClient } from '@/platforms/factory'
import { getCachedMessages, setCachedMessages, createChannelKey } from './cache'
import config from '@/helpers/env'

interface InboxChannelInfo extends ChannelInfo {
  group: 'new' | 'following' | 'unfollowed'
  newMessageCount?: number
  lastMessageTimestamp?: Date
}

export type SectionName = 'new' | 'following' | 'unfollowed'

// Build WhatsApp inbox with grouping
async function buildWhatsAppInbox(
  platformClient: IPlatformClient,
  collapsedSections: Set<SectionName> = new Set()
): Promise<{
  channels: InboxChannelInfo[]
  displayItems: string[]
  displayIndexToChannelIndex: Map<number, number>
}> {
  const visitData = loadVisitData()
  const channels = await platformClient.getChannels()

  const newMessageChannels: InboxChannelInfo[] = []
  const followingChannels: InboxChannelInfo[] = []
  const unfollowedChannels: InboxChannelInfo[] = []

  for (const channel of channels) {
    // Get chat metadata for last message info
    const chatMetadata = channel.metadata?.nativeChat as any
    const unreadCount = chatMetadata?.unreadCount || 0
    const lastMessageTimestamp = chatMetadata?.conversationTimestamp
      ? new Date(chatMetadata.conversationTimestamp * 1000)
      : undefined

    const channelInfo: InboxChannelInfo = {
      ...channel,
      group: 'following',
      lastMessageTimestamp,
    }

    // Check visit data (use platform-prefixed key)
    const visitKey = `whatsapp:${channel.id}`
    const channelVisit = visitData[visitKey] || visitData[channel.id] // fallback to old format

    if (!channelVisit) {
      // Not following
      channelInfo.group = 'unfollowed'
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
        channelInfo.group = 'following'
      }
    }

    // Categorize
    switch (channelInfo.group) {
      case 'new':
        newMessageChannels.push(channelInfo)
        break
      case 'unfollowed':
        unfollowedChannels.push(channelInfo)
        break
      case 'following':
        followingChannels.push(channelInfo)
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
  followingChannels.sort(sortByTimestamp)
  unfollowedChannels.sort(sortByTimestamp)

  // Build display list
  const displayItems: string[] = []
  const channelList: InboxChannelInfo[] = []
  const displayIndexToChannelIndex: Map<number, number> = new Map()
  let channelIndex = 0

  const isCollapsed = (section: SectionName) => collapsedSections.has(section)
  const collapseIndicator = (section: SectionName) => isCollapsed(section) ? '▶' : '▼'

  if (newMessageChannels.length > 0) {
    displayItems.push(`══════ ${collapseIndicator('new')} 🆕 NEW (${newMessageChannels.length}) ══════`)
    if (!isCollapsed('new')) {
      newMessageChannels.forEach(ch => {
        const badge = ch.newMessageCount ? ` [${ch.newMessageCount} new]` : ''
        displayItems.push(`${ch.name}${badge}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  if (followingChannels.length > 0) {
    displayItems.push(`══════ ${collapseIndicator('following')} ★ FOLLOWING (${followingChannels.length}) ══════`)
    if (!isCollapsed('following')) {
      followingChannels.forEach(ch => {
        displayItems.push(ch.name)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  if (unfollowedChannels.length > 0) {
    displayItems.push(`══════ ${collapseIndicator('unfollowed')} ○ UNFOLLOWED (${unfollowedChannels.length}) ══════`)
    if (!isCollapsed('unfollowed')) {
      unfollowedChannels.forEach(ch => {
        const badge = ch.newMessageCount ? ` [${ch.newMessageCount} new]` : ''
        displayItems.push(`${ch.name}${badge}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  return { channels: channelList, displayItems, displayIndexToChannelIndex }
}

// Process a single channel for inbox grouping
async function processChannelForInbox(
  channel: TextChannel | ThreadChannel,
  guildName: string,
  botUserId: string,
  visitData: Record<string, any>
): Promise<InboxChannelInfo | null> {
  const channelInfo: InboxChannelInfo = {
    id: channel.id,
    name: channel.name,
    type: channel.isThread() ? 'thread' : 'text',
    guildName,
    group: 'following',
  }

  // Check visit data with platform prefix, fallback to unprefixed
  const visitKey = `discord:${channel.id}`
  const channelVisit = visitData[visitKey] || visitData[channel.id]

  // Skip message fetching for unfollowed channels
  if (!channelVisit) {
    channelInfo.group = 'unfollowed'
    return channelInfo
  }

  try {
    // Check cache first for fast inbox refresh
    const cached = getCachedMessages('discord', channel.id)

    if (cached && cached.messages.length > 0) {
      const newestMsg = cached.messages[cached.messages.length - 1]
      channelInfo.lastMessageTimestamp = newestMsg.date

      const cacheAgeMs = Date.now() - cached.fetchedAt
      if (cacheAgeMs < 300_000) { // 5 min cache for inbox
        const lastVisitDate = new Date(channelVisit.lastVisited)
        const newMessages = cached.messages.filter(msg =>
          msg.date > lastVisitDate && msg.authorId !== botUserId
        )
        if (newMessages.length > 0) {
          channelInfo.group = 'new'
          channelInfo.newMessageCount = newMessages.length
        } else {
          channelInfo.group = 'following'
        }
        return channelInfo
      }
    }

    // Cache miss or stale - fetch from Discord (only 5 messages for speed)
    const messages = await channel.messages.fetch({ limit: 5 })
    const messagesArray = Array.from(messages.values())

    if (messagesArray.length > 0) {
      channelInfo.lastMessageTimestamp = new Date(messagesArray[0].createdTimestamp)
    }

    const lastVisitDate = new Date(channelVisit.lastVisited)
    const newMessages = messagesArray.filter(msg =>
      new Date(msg.createdTimestamp) > lastVisitDate && msg.author.id !== botUserId
    )

    if (newMessages.length > 0) {
      channelInfo.group = 'new'
      channelInfo.newMessageCount = newMessages.length
    } else {
      channelInfo.group = 'following'
    }
    return channelInfo
  } catch (err) {
    return channelInfo
  }
}

// Build channel list and display items (reusable for refresh)
async function buildInboxChannels(
  client: Client,
  collapsedSections: Set<SectionName> = new Set()
): Promise<{
  channels: InboxChannelInfo[]
  displayItems: string[]
  displayIndexToChannelIndex: Map<number, number>
}> {
  const visitData = loadVisitData()
  const botUserId = client.user?.id || ''

  const newMessageChannels: InboxChannelInfo[] = []
  const followingChannels: InboxChannelInfo[] = []
  const unfollowedChannels: InboxChannelInfo[] = []

  // Collect all channels to process
  const channelsToProcess: Array<{ channel: TextChannel | ThreadChannel; guildName: string }> = []

  for (const [guildId, guild] of client.guilds.cache) {
    for (const [channelId, channel] of guild.channels.cache) {
      if (channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
        const permissions = channel.permissionsFor(guild.members.me!)
        if (!permissions?.has('ViewChannel') || !permissions?.has('SendMessages')) {
          continue
        }
        channelsToProcess.push({ channel, guildName: guild.name })
      }
    }
  }

  // Process channels in parallel batches (10 concurrent)
  const BATCH_SIZE = 10
  for (let i = 0; i < channelsToProcess.length; i += BATCH_SIZE) {
    const batch = channelsToProcess.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(({ channel, guildName }) =>
        processChannelForInbox(channel, guildName, botUserId, visitData)
      )
    )

    for (const channelInfo of results) {
      if (!channelInfo) continue
      switch (channelInfo.group) {
        case 'new': newMessageChannels.push(channelInfo); break
        case 'following': followingChannels.push(channelInfo); break
        case 'unfollowed': unfollowedChannels.push(channelInfo); break
      }
    }
  }

  const sortByTimestamp = (a: InboxChannelInfo, b: InboxChannelInfo) => {
    if (!a.lastMessageTimestamp && !b.lastMessageTimestamp) return 0
    if (!a.lastMessageTimestamp) return 1
    if (!b.lastMessageTimestamp) return -1
    return b.lastMessageTimestamp.getTime() - a.lastMessageTimestamp.getTime()
  }

  newMessageChannels.sort(sortByTimestamp)
  followingChannels.sort(sortByTimestamp)
  unfollowedChannels.sort(sortByTimestamp)

  const displayItems: string[] = []
  const channelList: InboxChannelInfo[] = []
  const displayIndexToChannelIndex: Map<number, number> = new Map()
  let channelIndex = 0

  const isCollapsed = (section: SectionName) => collapsedSections.has(section)
  const collapseIndicator = (section: SectionName) => isCollapsed(section) ? '▶' : '▼'
  
  if (newMessageChannels.length > 0) {
    displayItems.push(`══════ ${collapseIndicator('new')} 🆕 NEW (${newMessageChannels.length}) ══════`)
    if (!isCollapsed('new')) {
      newMessageChannels.forEach(ch => {
        const badge = ch.newMessageCount ? ` [${ch.newMessageCount} new]` : ''
        displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}${badge}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }
  
  if (followingChannels.length > 0) {
    displayItems.push(`══════ ${collapseIndicator('following')} ★ FOLLOWING (${followingChannels.length}) ══════`)
    if (!isCollapsed('following')) {
      followingChannels.forEach(ch => {
        displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }
  
  if (unfollowedChannels.length > 0) {
    displayItems.push(`══════ ${collapseIndicator('unfollowed')} ○ UNFOLLOWED (${unfollowedChannels.length}) ══════`)
    if (!isCollapsed('unfollowed')) {
      unfollowedChannels.forEach(ch => {
        displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
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

    // Track collapsed sections - "unfollowed" collapsed by default
    const collapsedSections = new Set<SectionName>(['unfollowed'])

    // Build initial channel list based on platform
    let inboxData: {
      channels: InboxChannelInfo[]
      displayItems: string[]
      displayIndexToChannelIndex: Map<number, number>
    }

    if (selectedPlatform === 'discord') {
      // Get native Discord client for inbox scanning (temporary - will be refactored)
      const client = platformClient.getNativeClient() as Client
      inboxData = await buildInboxChannels(client, collapsedSections)
    } else {
      // For WhatsApp, build grouped inbox
      inboxData = await buildWhatsAppInbox(platformClient, collapsedSections)
    }
    
    if (inboxData.channels.length === 0 && inboxData.displayItems.length === 0) {
      console.log('❌ No accessible channels found')
      await platformClient.disconnect()
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
        inboxData = await buildInboxChannels(client, collapsedSections)
      } else {
        inboxData = await buildWhatsAppInbox(platformClient, collapsedSections)
      }
      return { channels: inboxData.channels, displayItems: inboxData.displayItems }
    }

    // Toggle section collapse callback
    const onToggleSection = async (section: SectionName) => {
      if (collapsedSections.has(section)) {
        collapsedSections.delete(section)
      } else {
        collapsedSections.add(section)
      }
      if (selectedPlatform === 'discord') {
        const client = platformClient.getNativeClient() as Client
        inboxData = await buildInboxChannels(client, collapsedSections)
      } else {
        inboxData = await buildWhatsAppInbox(platformClient, collapsedSections)
      }
      return { channels: inboxData.channels, displayItems: inboxData.displayItems }
    }

    // Follow callback - adds visit data and rebuilds
    const onFollowChannel = async (channel: ChannelInfo) => {
      markChannelVisited(channel.id, undefined, selectedPlatform)
      if (selectedPlatform === 'discord') {
        const client = platformClient.getNativeClient() as Client
        inboxData = await buildInboxChannels(client, collapsedSections)
      } else {
        inboxData = await buildWhatsAppInbox(platformClient, collapsedSections)
      }
      return { channels: inboxData.channels, displayItems: inboxData.displayItems }
    }

    // Unfollow callback - removes visit data and rebuilds
    const onUnfollowChannel = async (channel: ChannelInfo) => {
      removeChannelVisit(channel.id, selectedPlatform)
      if (selectedPlatform === 'discord') {
        const client = platformClient.getNativeClient() as Client
        inboxData = await buildInboxChannels(client, collapsedSections)
      } else {
        inboxData = await buildWhatsAppInbox(platformClient, collapsedSections)
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
      onFollowChannel,
      onUnfollowChannel,
      onToggleSection,
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
