/**
 * Background archive service for Discord messages
 * Gradually fetches message history and subscribes to real-time updates
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { DiscordPlatformClient } from '@/platforms/discord/client'
import { IPlatformMessage, IPlatformChannel } from '@/platforms/types'
import {
  initDB,
  closeDB,
  saveChannel,
  saveMessage,
  saveMessages,
  getOldestMessageId,
  getChannelsWithMessages,
  updateChannelOldestFetched,
  getChannelBackfillStatus,
  getTotalStats,
  messageExists,
  channelExists,
  ensureChannelExists,
  MessageRecord,
  ChannelRecord,
} from './db'

// Configuration
const FETCH_BATCH_SIZE = 100 // Discord API limit
const MIN_DELAY_MS = 3000 // 3 seconds minimum between fetches
const MAX_DELAY_MS = 8000 // 8 seconds maximum between fetches

// Lock file to indicate archive is running
const ARCHIVE_LOCK_FILE = path.join(os.homedir(), '.dialogue-archive.lock')

// State
let isRunning = true
let client: DiscordPlatformClient | null = null

/**
 * Write lock file with current PID
 */
function writeLockFile(): void {
  fs.writeFileSync(ARCHIVE_LOCK_FILE, process.pid.toString(), 'utf-8')
}

/**
 * Remove lock file
 */
function removeLockFile(): void {
  try {
    if (fs.existsSync(ARCHIVE_LOCK_FILE)) {
      fs.unlinkSync(ARCHIVE_LOCK_FILE)
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Check if another archive instance is already running
 */
function isArchiveRunning(): boolean {
  try {
    if (!fs.existsSync(ARCHIVE_LOCK_FILE)) return false
    const pid = parseInt(fs.readFileSync(ARCHIVE_LOCK_FILE, 'utf-8').trim(), 10)
    // Check if process exists (throws if not)
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

/**
 * Generate a random delay between min and max milliseconds
 */
function randomDelay(): number {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Convert platform message to database message record
 */
function messageToRecord(msg: IPlatformMessage): MessageRecord {
  return {
    id: msg.id,
    channelId: msg.channelId,
    authorId: msg.authorId,
    authorName: msg.author,
    content: msg.content,
    timestamp: msg.timestamp,
    editedTimestamp: msg.editedTimestamp,
    isBot: msg.isBot,
    messageType: msg.messageType,
    pinned: msg.pinned,
    attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
    embeds: msg.embeds.length > 0 ? msg.embeds : undefined,
    stickers: msg.stickers.length > 0 ? msg.stickers : undefined,
    reactions: msg.reactions.length > 0 ? msg.reactions : undefined,
    replyToId: msg.replyTo?.messageId,
    threadId: msg.threadId,
  }
}

/**
 * Convert platform channel to database channel record
 */
function channelToRecord(ch: IPlatformChannel): ChannelRecord {
  return {
    id: ch.id,
    name: ch.name,
    guildId: ch.metadata?.guildId,
    guildName: ch.parentName,
    parentId: ch.parentId,
    topic: ch.topic,
    type: ch.type,
  }
}

/**
 * Log with timestamp
 */
function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString()
  console.log(`[${timestamp}] ${message}`)
}

/**
 * Backfill history for a single channel
 * Returns true if more messages are available, false if backfill is complete
 */
async function backfillChannel(client: DiscordPlatformClient, channel: IPlatformChannel): Promise<boolean> {
  // Get the oldest message we have for this channel
  const oldestId = await getOldestMessageId(channel.id)

  // Check if backfill is already complete
  const status = await getChannelBackfillStatus(channel.id)
  if (status?.oldestFetchedId === 'COMPLETE') {
    return false
  }

  try {
    let messages: IPlatformMessage[]

    if (oldestId) {
      // Fetch messages before the oldest we have
      messages = await client.getMessagesBefore(channel.id, oldestId, FETCH_BATCH_SIZE)
    } else {
      // First fetch - get most recent messages
      messages = await client.getMessages(channel.id, FETCH_BATCH_SIZE)
    }

    if (messages.length === 0) {
      // No more messages - backfill complete
      await updateChannelOldestFetched(channel.id, 'COMPLETE')
      log(`  Backfill complete for #${channel.name}`)
      return false
    }

    // Save messages
    const records = messages.map(messageToRecord)
    await saveMessages(records)

    log(`  Saved ${messages.length} messages from #${channel.name}`)

    // If we got fewer than the batch size, we've reached the beginning
    if (messages.length < FETCH_BATCH_SIZE) {
      await updateChannelOldestFetched(channel.id, 'COMPLETE')
      log(`  Backfill complete for #${channel.name}`)
      return false
    }

    return true
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log(`  Error fetching from #${channel.name}: ${errorMessage}`)
    return false
  }
}

/**
 * Catch up on messages that arrived while the archiver was offline
 * For each channel with existing messages, fetch recent messages and save any new ones
 */
async function catchUpMissedMessages(client: DiscordPlatformClient, channels: IPlatformChannel[]): Promise<void> {
  const channelsWithMessages = await getChannelsWithMessages()

  if (channelsWithMessages.length === 0) {
    log('No existing messages - skipping catch-up phase')
    return
  }

  log(`Catching up on ${channelsWithMessages.length} channels...`)

  const channelMap = new Map(channels.map((ch) => [ch.id, ch]))
  let totalNewMessages = 0

  for (const channelId of channelsWithMessages) {
    if (!isRunning) break

    const channel = channelMap.get(channelId)
    if (!channel) continue

    try {
      // Fetch the most recent messages from Discord
      const recentMessages = await client.getMessages(channelId, FETCH_BATCH_SIZE)

      if (recentMessages.length === 0) continue

      // Filter to only messages we don't have yet
      const newMessages: IPlatformMessage[] = []
      for (const msg of recentMessages) {
        if (!(await messageExists(msg.id))) {
          newMessages.push(msg)
        }
      }

      if (newMessages.length > 0) {
        const records = newMessages.map(messageToRecord)
        await saveMessages(records)
        totalNewMessages += newMessages.length
        log(`  Caught up ${newMessages.length} new messages in #${channel.name}`)
      }

      // Small delay between channels
      await sleep(1000)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`  Error catching up #${channel.name}: ${errorMessage}`)
    }
  }

  if (totalNewMessages > 0) {
    log(`Catch-up complete: ${totalNewMessages} new messages saved`)
  } else {
    log('Catch-up complete: no missed messages')
  }
}

/**
 * Main backfill loop - round-robin through channels
 */
async function runBackfillLoop(client: DiscordPlatformClient, channels: IPlatformChannel[]): Promise<void> {
  // Track which channels still have more history to fetch
  const activeChannels = new Set(channels.map((ch) => ch.id))
  const channelMap = new Map(channels.map((ch) => [ch.id, ch]))

  log(`Starting backfill for ${activeChannels.size} channels...`)

  while (isRunning && activeChannels.size > 0) {
    for (const channelId of Array.from(activeChannels)) {
      if (!isRunning) break

      const channel = channelMap.get(channelId)
      if (!channel) continue

      const hasMore = await backfillChannel(client, channel)

      if (!hasMore) {
        activeChannels.delete(channelId)
      }

      // Random delay between fetches to avoid rate limits
      if (isRunning && activeChannels.size > 0) {
        const delay = randomDelay()
        await sleep(delay)
      }
    }

    // Show progress
    if (activeChannels.size > 0) {
      const stats = await getTotalStats()
      log(`Progress: ${stats.totalMessages} messages archived, ${activeChannels.size} channels remaining`)
    }
  }

  if (activeChannels.size === 0) {
    log('All channels fully archived!')
  }
}

/**
 * Handle real-time message events
 */
function setupRealtimeHandlers(client: DiscordPlatformClient): void {
  client.onMessage(async (message: IPlatformMessage) => {
    try {
      // If channel doesn't exist, fetch and save its info
      if (!(await channelExists(message.channelId))) {
        const channelInfo = await client.getChannel(message.channelId)
        if (channelInfo) {
          await saveChannel(channelToRecord(channelInfo))
          log(`Real-time: Discovered new channel #${channelInfo.name}`)
        } else {
          // Fallback if we can't fetch channel info
          await ensureChannelExists(message.channelId)
        }
      }
      // Save the message
      const record = messageToRecord(message)
      await saveMessage(record)
      log(`Real-time: Saved message from ${message.author} in channel ${message.channelId}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Real-time: Failed to save message ${message.id}: ${errorMessage}`)
    }
  })

  client.onMessageUpdate(async (message: IPlatformMessage) => {
    try {
      // If channel doesn't exist, fetch and save its info
      if (!(await channelExists(message.channelId))) {
        const channelInfo = await client.getChannel(message.channelId)
        if (channelInfo) {
          await saveChannel(channelToRecord(channelInfo))
        } else {
          await ensureChannelExists(message.channelId)
        }
      }
      // Update the message
      const record = messageToRecord(message)
      await saveMessage(record)
      log(`Real-time: Updated message ${message.id}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Real-time: Failed to update message ${message.id}: ${errorMessage}`)
    }
  })
}

/**
 * Graceful shutdown handler
 */
function setupShutdownHandlers(): void {
  const shutdown = async () => {
    log('Shutting down...')
    isRunning = false

    // Remove lock file
    removeLockFile()

    // Close database
    closeDB()
    log('Database closed.')

    // Disconnect from Discord
    if (client) {
      await client.disconnect()
      log('Disconnected from Discord.')
    }

    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('exit', removeLockFile)
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('\nDiscord Message Archive Service\n')

  // Check if already running
  if (isArchiveRunning()) {
    console.log('Archive service is already running. Exiting.')
    process.exit(0)
  }

  // Write lock file
  writeLockFile()

  // Initialize database
  log('Initializing database...')
  await initDB()

  // Set up shutdown handlers
  setupShutdownHandlers()

  // Create and connect Discord client
  log('Connecting to Discord...')
  client = new DiscordPlatformClient()

  try {
    await client.connect()
    log('Connected to Discord!')

    const user = client.getCurrentUser()
    if (user) {
      log(`Logged in as ${user.username}`)
    }

    // Get all accessible channels
    log('Fetching channel list...')
    const channels = await client.getChannels()
    log(`Found ${channels.length} accessible channels`)

    // Save all channels to database
    for (const channel of channels) {
      await saveChannel(channelToRecord(channel))
    }

    // Set up real-time message handling
    log('Setting up real-time message handlers...')
    setupRealtimeHandlers(client)

    // Show current stats
    const stats = await getTotalStats()
    log(`Current archive: ${stats.totalMessages} messages in ${stats.totalChannels} channels`)
    log(`Backfill status: ${stats.channelsComplete} complete, ${stats.channelsInProgress} in progress`)

    // Catch up on messages missed while offline
    await catchUpMissedMessages(client, channels)

    // Start the backfill loop
    await runBackfillLoop(client, channels)

    // Keep running for real-time updates after backfill completes
    log('Backfill complete. Listening for real-time updates...')
    log('Press Ctrl+C to stop.')

    // Keep the process alive
    await new Promise(() => {})
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('Fatal error:', errorMessage)
    closeDB()
    process.exit(1)
  }
}

main()
