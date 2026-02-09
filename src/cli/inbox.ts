/**
 * CLI tool to show inbox-style channel grouping.
 * Composes data from 'realtime' and 'archive' databases.
 */

import { Client as LibsqlClient } from '@libsql/client'
import {
  ChannelInfo,
  loadVisitData,
  removeChannelVisit,
  markChannelVisited,
  MessageInfo,
} from './shared'
import { renderApp } from './ui/App'
import { showPlatformSelector } from './ui/showPlatformSelector'
import { IPlatformClient } from '@/platforms/types'
import { createPlatformClient } from '@/platforms/factory'
import {
  initDB,
  getClient,
  closeAllDBs,
  getChannels,
  getMessagesSince,
  getMessages,
  getMessagesBefore,
  rowToMessageRecord,
  ChannelRecord,
  MessageRecord,
} from './db'

interface InboxChannelInfo extends ChannelInfo {
  group: 'new' | 'following' | 'unfollowed'
  newMessageCount?: number
  lastMessageTimestamp?: Date
}

export type SectionName = 'new' | 'following' | 'unfollowed_new' | 'unfollowed'

// Lookup maps for resolving Discord mentions in stored content
let userNameMap = new Map<string, string>()
let channelNameMap = new Map<string, string>()

function resolveMentions(content: string): string {
  return content
    .replace(/<@!?(\d+)>/g, (_, id) => `@${userNameMap.get(id) ?? 'unknown-user'}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${channelNameMap.get(id) ?? 'unknown-channel'}`)
}

async function buildMentionMaps(realtimeDb: LibsqlClient, archiveDb: LibsqlClient): Promise<void> {
  const channels = [
    ...await getChannels(realtimeDb),
    ...await getChannels(archiveDb),
  ]
  for (const ch of channels) channelNameMap.set(ch.id, ch.name)

  for (const db of [realtimeDb, archiveDb]) {
    const result = await db.execute('SELECT DISTINCT author_id, author_name FROM messages')
    for (const row of result.rows) {
      const id = String(row.author_id)
      if (!userNameMap.has(id)) userNameMap.set(id, String(row.author_name))
    }
  }
}

// Helper to convert DB MessageRecord to UI MessageInfo
const dbRecordToMessageInfo = (record: MessageRecord): MessageInfo => ({
  id: record.id,
  author: record.authorName,
  authorId: record.authorId,
  content: resolveMentions(record.content),
  timestamp: record.timestamp,
  date: new Date(record.timestamp),
  isBot: record.isBot,
  hasAttachments: (record.attachments?.length || 0) > 0,
  attachmentCount: record.attachments?.length || 0,
  attachments: record.attachments || [],
  reactions: record.reactions || [],
  replyTo: record.replyToId ? { author: '', content: `(reply to ${record.replyToId})` } : undefined,
})

async function buildInbox(
  realtimeDb: LibsqlClient,
  archiveDb: LibsqlClient,
  collapsedSections: Set<SectionName> = new Set(),
  botUserId?: string
): Promise<{
  channels: InboxChannelInfo[]
  displayItems: string[]
  displayIndexToChannelIndex: Map<number, number>
  channelsWithNewMessages: InboxChannelInfo[] // Added to return new message channels
}> {
  const visitData = loadVisitData()

  const realtimeChannels = await getChannels(realtimeDb)
  const archiveChannels = await getChannels(archiveDb)

  const channelMap = new Map<string, ChannelRecord>()
  archiveChannels.forEach(ch => channelMap.set(ch.id, ch))
  realtimeChannels.forEach(ch => channelMap.set(ch.id, ch))
  const allChannels = Array.from(channelMap.values())

  const newMessageChannels: InboxChannelInfo[] = []
  const followingChannels: InboxChannelInfo[] = []
  const unfollowedNewChannels: InboxChannelInfo[] = []
  const unfollowedChannels: InboxChannelInfo[] = []

  for (const channel of allChannels) {
    const channelInfo: InboxChannelInfo = {
      id: channel.id,
      name: channel.name,
      type: (channel.type as 'text' | 'thread' | 'dm') || 'text',
      guildName: channel.guildName,
      group: 'following',
    }
    
    const visitKey = `discord:${channel.id}`
    const channelVisit = visitData[visitKey] ?? visitData[channel.id]

    if (!channelVisit) {
      let realtimeLatest = await getMessages(realtimeDb, channel.id, 1)
      let archiveLatest = realtimeLatest.length > 0 ? [] : await getMessages(archiveDb, channel.id, 1)
      const latest = realtimeLatest.length > 0 ? realtimeLatest : archiveLatest
      if (latest.length > 0) {
        channelInfo.lastMessageTimestamp = new Date(latest[0].timestamp)
        channelInfo.group = 'unfollowed_new' as any
        unfollowedNewChannels.push(channelInfo)
      } else {
        channelInfo.group = 'unfollowed'
        unfollowedChannels.push(channelInfo)
      }
      continue
    }

    const lastVisitTimestamp = channelVisit.lastVisited
    const newMessages = await getMessagesSince(realtimeDb, channel.id, lastVisitTimestamp, botUserId)

    const latestMessages = await getMessages(realtimeDb, channel.id, 1)
    if (latestMessages.length > 0) {
      channelInfo.lastMessageTimestamp = new Date(latestMessages[0].timestamp)
    }

    if (newMessages.length > 0) {
      channelInfo.group = 'new'
      channelInfo.newMessageCount = newMessages.length
      newMessageChannels.push(channelInfo)
    } else {
      channelInfo.group = 'following'
      followingChannels.push(channelInfo)
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
  unfollowedNewChannels.sort(sortByTimestamp)
  unfollowedChannels.sort((a,b) => a.name.localeCompare(b.name))

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
        const badge = ch.newMessageCount ? ` [${ch.newMessageCount}]` : ''
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
      followingChannels.forEach((ch) => {
        displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  if (unfollowedNewChannels.length > 0) {
    displayItems.push(`══════ ${collapseIndicator('unfollowed_new')} 📬 UNFOLLOWED NEW (${unfollowedNewChannels.length}) ══════`)
    if (!isCollapsed('unfollowed_new')) {
      unfollowedNewChannels.forEach((ch) => {
        const badge = ch.newMessageCount ? ` [${ch.newMessageCount}]` : ''
        displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}${badge}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  if (unfollowedChannels.length > 0) {
    displayItems.push(`══════ ${collapseIndicator('unfollowed')} ○ UNFOLLOWED (${unfollowedChannels.length}) ══════`)
    if (!isCollapsed('unfollowed')) {
      unfollowedChannels.forEach((ch) => {
        displayItems.push(`${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}`)
        displayIndexToChannelIndex.set(displayItems.length - 1, channelIndex)
        channelList.push(ch)
        channelIndex++
      })
    }
  }

  return { channels: channelList, displayItems, displayIndexToChannelIndex, channelsWithNewMessages: newMessageChannels }
}

async function getMessagesForChannel(channel: ChannelInfo, limit: number, realtimeDb: LibsqlClient, archiveDb: LibsqlClient): Promise<MessageInfo[]> {
  const allMessagesMap = new Map<string, MessageInfo>();

  const realtimeMessages = await getMessages(realtimeDb, channel.id, limit);
  realtimeMessages.forEach(msg => allMessagesMap.set(msg.id, dbRecordToMessageInfo(msg)));

  if (allMessagesMap.size < limit) {
    const archiveMessages = await getMessages(archiveDb, channel.id, limit);
    archiveMessages.forEach(msg => {
      if (!allMessagesMap.has(msg.id)) {
        allMessagesMap.set(msg.id, dbRecordToMessageInfo(msg));
      }
    });
  }

  return Array.from(allMessagesMap.values())
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

async function getOlderMessagesForChannel(channel: ChannelInfo, oldestMessageId: string, limit: number, realtimeDb: LibsqlClient, archiveDb: LibsqlClient): Promise<{ messages: MessageInfo[]; newCount: number; hasMore: boolean }> {
  const allMessagesMap = new Map<string, MessageRecord>(); // Changed to MessageRecord
  
  const realtimeRecords = await getMessagesBefore(realtimeDb, channel.id, oldestMessageId, limit);
  realtimeRecords.forEach(rec => allMessagesMap.set(rec.id, rec));

  if (allMessagesMap.size < limit) {
    const archiveRecords = await getMessagesBefore(archiveDb, channel.id, oldestMessageId, limit - allMessagesMap.size);
    archiveRecords.forEach(rec => {
      if (!allMessagesMap.has(rec.id)) {
        allMessagesMap.set(rec.id, rec);
      }
    });
  }
  const messages = Array.from(allMessagesMap.values()) // Changed to use allMessagesMap
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .map(dbRecordToMessageInfo);
  
  const checkMoreSql = `SELECT 1 FROM messages WHERE channel_id = ? AND id < ? LIMIT 1`;
  const hasMoreRealtime = (await realtimeDb.execute({ sql: checkMoreSql, args: [channel.id, oldestMessageId] })).rows.length > 0;
  const hasMoreArchive = (await archiveDb.execute({ sql: checkMoreSql, args: [channel.id, oldestMessageId] })).rows.length > 0;
  
  return {
    messages,
    newCount: messages.length,
    hasMore: hasMoreRealtime || hasMoreArchive,
  };
}


async function main() {
  try {
    const selectedPlatform = await showPlatformSelector()
    if (!selectedPlatform || selectedPlatform !== 'discord') {
      console.log('❌ This tool currently only supports Discord.')
      process.exit(0)
    }

    const collapsedSections = new Set<SectionName>(['unfollowed_new', 'unfollowed'])
    
    const realtimeDb = getClient('realtime', 'local')
    const archiveDb = getClient('archive', 'local')

    await initDB(realtimeDb)
    await initDB(archiveDb)
    
    console.log(`🔌 Connecting to ${selectedPlatform}...`)
    const platformClient = await createPlatformClient(selectedPlatform)
    await platformClient.connect()
    console.log('✅ Connected!')
    const botUserId = platformClient.getCurrentUser()?.id
    
    console.log('📥 Loading inbox...')
    await buildMentionMaps(realtimeDb, archiveDb)
    let inboxData = await buildInbox(realtimeDb, archiveDb, collapsedSections, botUserId)

    if (inboxData.channels.length === 0) {
        console.log('No channels found. Ensure your services are running.')
        await platformClient.disconnect();
        closeAllDBs();
        process.exit(0);
    }
    
    console.log(`Found ${inboxData.channels.length} channels`)
    console.log('Starting UI...\n')

    const onRefreshChannels = async () => {
      inboxData = await buildInbox(realtimeDb, archiveDb, collapsedSections, botUserId)
      return { channels: inboxData.channels, displayItems: inboxData.displayItems }
    }

    const onToggleSection = async (section: SectionName) => {
      if (collapsedSections.has(section)) collapsedSections.delete(section)
      else collapsedSections.add(section)
      return onRefreshChannels()
    }
    const onFollowChannel = async (channel: ChannelInfo) => {
      markChannelVisited(channel.id, undefined, 'discord')
      return onRefreshChannels()
    }
    const onUnfollowChannel = async (channel: ChannelInfo) => {
      removeChannelVisit(channel.id, 'discord')
      return onRefreshChannels()
    }
    const getChannelFromDisplayIndex = (displayIndex: number): ChannelInfo | null => {
        const channelIdx = inboxData.displayIndexToChannelIndex.get(displayIndex)
        return channelIdx !== undefined ? inboxData.channels[channelIdx] : null
    }

    renderApp({
      client: platformClient,
      initialChannels: inboxData.channels,
      initialDisplayItems: inboxData.displayItems,
      title: `Discord Inbox`,
      getMessagesForChannel: (channel, limit) => getMessagesForChannel(channel, limit, realtimeDb, archiveDb),
      getOlderMessagesForChannel: (channel, oldestMessageId, limit) => getOlderMessagesForChannel(channel, oldestMessageId, limit, realtimeDb, archiveDb),
      channelsWithNewMessages: inboxData.channelsWithNewMessages, // Pass new messages to App for auto-expand
      getChannelFromDisplayIndex,
      onRefreshChannels,
      onFollowChannel,
      onUnfollowChannel,
      onToggleSection,
      onExit: async () => {
        await platformClient.disconnect()
        closeAllDBs()
      },
    })

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
}

main()