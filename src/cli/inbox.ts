/**
 * CLI tool to show inbox-style channel grouping
 * Groups channels by: @-mentions, new messages, never visited
 * Uses Ink for interactive terminal UI with 1-column layout
 *
 * For Discord: reads data from archive database, connects live for sending.
 * For WhatsApp: connects live for everything.
 */

import { Client, GatewayIntentBits, TextChannel, ThreadChannel, Message } from 'discord.js'
import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
import {
  ChannelInfo,
  loadVisitData,
  removeChannelVisit,
  markChannelVisited,
  platformMessageToMessageInfo,
  autoFollowNewChannels,
} from './shared'
import { renderApp } from './ui/App'
import { showPlatformSelector } from './ui/showPlatformSelector'
import { PlatformType, IPlatformClient } from '@/platforms/types'
import { createPlatformClient } from '@/platforms/factory'
import { getCachedMessages, setCachedMessages, createChannelKey } from './cache'
import {
  initDB,
  hasArchiveData,
  getArchivedChannels,
  getMessagesSinceTimestamp,
  getNewestMessageTimestamp,
  getMessagesFromArchive,
} from './db'
import config from '@/helpers/env'

// Lock file to detect if archive is running
const ARCHIVE_LOCK_FILE = path.join(os.homedir(), '.dialogue-archive.lock')

// Check if archive process is running
function isArchiveRunning(): boolean {
  try {
    if (!fs.existsSync(ARCHIVE_LOCK_FILE)) return false
    const pid = parseInt(fs.readFileSync(ARCHIVE_LOCK_FILE, 'utf-8').trim(), 10)
    // Check if process exists
    process.kill(pid, 0)
    return true
  } catch {
    // Process doesn't exist or lock file is invalid
    if (fs.existsSync(ARCHIVE_LOCK_FILE)) {
      fs.unlinkSync(ARCHIVE_LOCK_FILE)
    }
    return false
  }
}

// Spawn archive process in background
function spawnArchiveProcess(): ChildProcess {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const archivePath = path.join(__dirname, 'archive.mjs')
  const child = spawn('node', [archivePath], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return child
}

// Wait for archive to have data (with timeout)
async function waitForArchiveData(timeoutMs = 30000): Promise<boolean> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    if (await hasArchiveData()) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

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
      // Check if user is mentioned in recent messages
      const currentUser = platformClient.getCurrentUser()
      if (currentUser && unreadCount > 0) {
        try {
          const messages = await platformClient.getMessages(channel.id, 5)
          const hasMention = messages.some(
            (msg) =>
              msg.content.includes(`@${currentUser.username}`) || msg.content.includes(`@${currentUser.id}`)
          )
          if (hasMention) {
            markChannelVisited(channel.id, undefined, 'whatsapp')
            channelInfo.group = 'new'
            channelInfo.newMessageCount = unreadCount
            newMessageChannels.push(channelInfo)
            continue
          }
        } catch {
          // Ignore fetch errors
        }
      }
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
  const collapseIndicator = (section: SectionName) => (isCollapsed(section) ? '▶' : '▼')

  if (newMessageChannels.length > 0) {
    displayItems.push(`══════ ${collapseIndicator('new')} 🆕 NEW (${newMessageChannels.length}) ══════`)
    if (!isCollapsed('new')) {
      newMessageChannels.forEach((ch) => {
        const badge = ch.newMessageCount ? ` [${ch.newMessageCount} new]` : ''
        displayItems.push(`${ch.name}${badge}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  if (followingChannels.length > 0) {
    displayItems.push(
      `══════ ${collapseIndicator('following')} ★ FOLLOWING (${followingChannels.length}) ══════`
    )
    if (!isCollapsed('following')) {
      followingChannels.forEach((ch) => {
        displayItems.push(ch.name)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  if (unfollowedChannels.length > 0) {
    displayItems.push(
      `══════ ${collapseIndicator('unfollowed')} ○ UNFOLLOWED (${unfollowedChannels.length}) ══════`
    )
    if (!isCollapsed('unfollowed')) {
      unfollowedChannels.forEach((ch) => {
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

// Build inbox from archive database (fast, offline-capable)
async function buildInboxFromArchive(
  collapsedSections: Set<SectionName> = new Set(),
  botUserId?: string
): Promise<{
  channels: InboxChannelInfo[]
  displayItems: string[]
  displayIndexToChannelIndex: Map<number, number>
}> {
  const visitData = loadVisitData()
  const archivedChannels = await getArchivedChannels()

  const newMessageChannels: InboxChannelInfo[] = []
  const followingChannels: InboxChannelInfo[] = []
  const unfollowedChannels: InboxChannelInfo[] = []

  for (const channel of archivedChannels) {
    const newestTimestamp = await getNewestMessageTimestamp(channel.id)
    const lastMessageTimestamp = newestTimestamp ? new Date(newestTimestamp) : undefined

    const channelInfo: InboxChannelInfo = {
      id: channel.id,
      name: channel.name,
      type: (channel.type as 'text' | 'thread' | 'dm') || 'text',
      guildName: channel.guildName,
      group: 'following',
      lastMessageTimestamp,
    }

    // Check visit data with platform prefix, fallback to unprefixed
    const visitKey = `discord:${channel.id}`
    const channelVisit = visitData[visitKey] || visitData[channel.id]

    if (!channelVisit) {
      // Unfollowed channel - check for mentions in recent messages
      if (botUserId) {
        const recentMessages = await getMessagesFromArchive(channel.id, 5)
        const hasMention = recentMessages.some(
          (msg) => msg.content.includes(`<@${botUserId}>`) || msg.content.includes(`<@!${botUserId}>`)
        )
        if (hasMention) {
          markChannelVisited(channel.id, undefined, 'discord')
          channelInfo.group = 'new'
          channelInfo.newMessageCount = 1
          newMessageChannels.push(channelInfo)
          continue
        }
      }
      channelInfo.group = 'unfollowed'
      unfollowedChannels.push(channelInfo)
      continue
    }

    // Check for new messages since last visit
    const lastVisitTimestamp = channelVisit.lastVisited
    const newMessages = await getMessagesSinceTimestamp(channel.id, lastVisitTimestamp, botUserId)

    if (newMessages.length > 0) {
      channelInfo.group = 'new'
      channelInfo.newMessageCount = newMessages.length
      newMessageChannels.push(channelInfo)
    } else {
      channelInfo.group = 'following'
      followingChannels.push(channelInfo)
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
  const collapseIndicator = (section: SectionName) => (isCollapsed(section) ? '▶' : '▼')

  if (newMessageChannels.length > 0) {
    displayItems.push(`══════ ${collapseIndicator('new')} 🆕 NEW (${newMessageChannels.length}) ══════`)
    if (!isCollapsed('new')) {
      newMessageChannels.forEach((ch) => {
        const badge = ch.newMessageCount ? ` [${ch.newMessageCount} new]` : ''
        displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}${badge}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  if (followingChannels.length > 0) {
    displayItems.push(
      `══════ ${collapseIndicator('following')} ★ FOLLOWING (${followingChannels.length}) ══════`
    )
    if (!isCollapsed('following')) {
      followingChannels.forEach((ch) => {
        displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  if (unfollowedChannels.length > 0) {
    displayItems.push(
      `══════ ${collapseIndicator('unfollowed')} ○ UNFOLLOWED (${unfollowedChannels.length}) ══════`
    )
    if (!isCollapsed('unfollowed')) {
      unfollowedChannels.forEach((ch) => {
        displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}`)
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

  // For unfollowed channels, check if bot is mentioned
  if (!channelVisit) {
    try {
      const messages = await channel.messages.fetch({ limit: 5 })
      const hasMention = Array.from(messages.values()).some((msg) => msg.mentions.users.has(botUserId))
      if (hasMention) {
        // Auto-follow if mentioned
        markChannelVisited(channel.id, undefined, 'discord')
        channelInfo.group = 'new'
        channelInfo.newMessageCount = 1
        return channelInfo
      }
    } catch {
      // Ignore fetch errors
    }
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
      if (cacheAgeMs < 300_000) {
        // 5 min cache for inbox
        const lastVisitDate = new Date(channelVisit.lastVisited)
        const newMessages = cached.messages.filter(
          (msg) => msg.date > lastVisitDate && msg.authorId !== botUserId
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
    const newMessages = messagesArray.filter(
      (msg) => new Date(msg.createdTimestamp) > lastVisitDate && msg.author.id !== botUserId
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
      batch.map(({ channel, guildName }) => processChannelForInbox(channel, guildName, botUserId, visitData))
    )

    for (const channelInfo of results) {
      if (!channelInfo) continue
      switch (channelInfo.group) {
        case 'new':
          newMessageChannels.push(channelInfo)
          break
        case 'following':
          followingChannels.push(channelInfo)
          break
        case 'unfollowed':
          unfollowedChannels.push(channelInfo)
          break
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
  const collapseIndicator = (section: SectionName) => (isCollapsed(section) ? '▶' : '▼')

  if (newMessageChannels.length > 0) {
    displayItems.push(`══════ ${collapseIndicator('new')} 🆕 NEW (${newMessageChannels.length}) ══════`)
    if (!isCollapsed('new')) {
      newMessageChannels.forEach((ch) => {
        const badge = ch.newMessageCount ? ` [${ch.newMessageCount} new]` : ''
        displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}${badge}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  if (followingChannels.length > 0) {
    displayItems.push(
      `══════ ${collapseIndicator('following')} ★ FOLLOWING (${followingChannels.length}) ══════`
    )
    if (!isCollapsed('following')) {
      followingChannels.forEach((ch) => {
        displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  if (unfollowedChannels.length > 0) {
    displayItems.push(
      `══════ ${collapseIndicator('unfollowed')} ○ UNFOLLOWED (${unfollowedChannels.length}) ══════`
    )
    if (!isCollapsed('unfollowed')) {
      unfollowedChannels.forEach((ch) => {
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

    // Track collapsed sections - "unfollowed" collapsed by default
    const collapsedSections = new Set<SectionName>(['unfollowed'])

    // Build initial channel list based on platform
    let inboxData: {
      channels: InboxChannelInfo[]
      displayItems: string[]
      displayIndexToChannelIndex: Map<number, number>
    }

    let platformClient: IPlatformClient | null = null
    let botUserId: string | undefined

    if (selectedPlatform === 'discord') {
      // Discord: use archive for data, connect live for sending
      // Ensure archive process is running
      if (!isArchiveRunning()) {
        console.log('🚀 Starting archive service in background...')
        spawnArchiveProcess()

        // Wait for archive to start and have some data
        console.log('⏳ Waiting for archive to initialize...')
        await initDB()
        const hasData = await waitForArchiveData(60000) // Wait up to 60 seconds

        if (!hasData) {
          console.log('⚠️  Archive is starting but no data yet. Please wait and try again.')
          process.exit(1)
        }
      } else {
        console.log('📚 Archive service is running')
        await initDB()
      }

      // Connect to Discord for sending messages
      console.log(`🔌 Connecting to ${selectedPlatform}...`)
      platformClient = await createPlatformClient(selectedPlatform)
      await platformClient.connect()
      console.log('✅ Connected!')

      botUserId = platformClient.getCurrentUser()?.id

      // Build inbox from archive
      console.log('📥 Loading inbox from archive...')
      inboxData = await buildInboxFromArchive(collapsedSections, botUserId)
    } else {
      // WhatsApp: connect live for everything
      console.log(`🔌 Connecting to ${selectedPlatform}...`)
      platformClient = await createPlatformClient(selectedPlatform)
      await platformClient.connect()

      console.log('✅ Connected!')
      console.log('📥 Scanning channels for inbox...')

      // Auto-follow any new channels created while app was closed
      const allChannels = await platformClient.getChannels()
      const newlyFollowed = autoFollowNewChannels(
        allChannels.map((ch) => ({ id: ch.id, name: ch.name })),
        selectedPlatform
      )
      if (newlyFollowed.length > 0) {
        console.log(`📢 Auto-followed ${newlyFollowed.length} new channel(s)`)
      }

      inboxData = await buildWhatsAppInbox(platformClient, collapsedSections)
    }

    if (inboxData.channels.length === 0 && inboxData.displayItems.length === 0) {
      console.log('❌ No accessible channels found')
      if (platformClient) await platformClient.disconnect()
      process.exit(0)
    }

    console.log(`Found ${inboxData.channels.length} channels`)
    console.log('Starting UI...\n')

    // Auto-follow new channels when they are created
    if (platformClient?.onChannelCreate) {
      platformClient.onChannelCreate((channel) => {
        console.log(`📢 New channel detected: ${channel.name} - auto-following...`)
        markChannelVisited(channel.id, undefined, selectedPlatform)
      })
    }

    // Helper to get channel from display index (uses closure over current inboxData)
    const getChannelFromDisplayIndex = (displayIndex: number, channels: ChannelInfo[]): ChannelInfo | null => {
      const channelIdx = inboxData.displayIndexToChannelIndex.get(displayIndex)
      if (channelIdx === undefined) return null
      return inboxData.channels[channelIdx] || null
    }

    // Refresh callback - rebuilds channel list
    const onRefreshChannels = async () => {
      if (selectedPlatform === 'discord') {
        inboxData = await buildInboxFromArchive(collapsedSections, botUserId)
      } else if (platformClient) {
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
        inboxData = await buildInboxFromArchive(collapsedSections, botUserId)
      } else if (platformClient) {
        inboxData = await buildWhatsAppInbox(platformClient, collapsedSections)
      }
      return { channels: inboxData.channels, displayItems: inboxData.displayItems }
    }

    // Follow callback - adds visit data and rebuilds
    const onFollowChannel = async (channel: ChannelInfo) => {
      markChannelVisited(channel.id, undefined, selectedPlatform)
      if (selectedPlatform === 'discord') {
        inboxData = await buildInboxFromArchive(collapsedSections, botUserId)
      } else if (platformClient) {
        inboxData = await buildWhatsAppInbox(platformClient, collapsedSections)
      }
      return { channels: inboxData.channels, displayItems: inboxData.displayItems }
    }

    // Unfollow callback - removes visit data and rebuilds
    const onUnfollowChannel = async (channel: ChannelInfo) => {
      removeChannelVisit(channel.id, selectedPlatform)
      if (selectedPlatform === 'discord') {
        inboxData = await buildInboxFromArchive(collapsedSections, botUserId)
      } else if (platformClient) {
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
      useArchiveForMessages: selectedPlatform === 'discord',
      getChannelFromDisplayIndex,
      onRefreshChannels,
      onFollowChannel,
      onUnfollowChannel,
      onToggleSection,
      onExit: async () => {
        if (platformClient) await platformClient.disconnect()
      },
    })

    await waitUntilExit()
    if (platformClient) await platformClient.disconnect()
    process.exit(0)
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
}

// Run main
void main()
