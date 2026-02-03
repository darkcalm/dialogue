/**
 * Background archive service for Discord messages
 * Gradually fetches message history and subscribes to real-time updates
 */

import { DiscordPlatformClient } from '@/platforms/discord/client'
import { IPlatformMessage, IPlatformChannel } from '@/platforms/types'
import {
  initDB,
  closeDB,
  saveChannel,
  saveMessage,
  saveMessages,
  getOldestMessageId,
  getNewestMessageId,
  getChannelsWithMessages,
  updateChannelOldestFetched,
  getChannelBackfillStatus,
  getTotalStats,
  messageExists,
  ensureChannelExists,
  MessageRecord,
  ChannelRecord,
} from './db'

// Configuration
const FETCH_BATCH_SIZE = 100 // Discord API limit
const MIN_DELAY_MS = 3000 // 3 seconds minimum between fetches
const MAX_DELAY_MS = 8000 // 8 seconds maximum between fetches

// State
let isRunning = true
let client: DiscordPlatformClient | null = null

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
  return new Promise(resolve => setTimeout(resolve, ms))
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
    isBot: msg.isBot,
    attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
    reactions: msg.reactions.length > 0 ? msg.reactions : undefined,
    replyToId: msg.replyTo?.messageId,
  }
}

/**
 * Convert platform channel to database channel record
 */
function channelToRecord(ch: IPlatformChannel): ChannelRecord {
  return {
    id: ch.id,
    name: ch.name,
    guildName: ch.parentName,
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
async function backfillChannel(
  client: DiscordPlatformClient,
  channel: IPlatformChannel
): Promise<boolean> {
  // Get the oldest message we have for this channel
  const oldestId = getOldestMessageId(channel.id)

  // Check if backfill is already complete
  const status = getChannelBackfillStatus(channel.id)
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
      updateChannelOldestFetched(channel.id, 'COMPLETE')
      log(`  Backfill complete for #${channel.name}`)
      return false
    }

    // Save messages
    const records = messages.map(messageToRecord)
    saveMessages(records)

    log(`  Saved ${messages.length} messages from #${channel.name}`)

    // If we got fewer than the batch size, we've reached the beginning
    if (messages.length < FETCH_BATCH_SIZE) {
      updateChannelOldestFetched(channel.id, 'COMPLETE')
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
async function catchUpMissedMessages(
  client: DiscordPlatformClient,
  channels: IPlatformChannel[]
): Promise<void> {
  const channelsWithMessages = getChannelsWithMessages()

  if (channelsWithMessages.length === 0) {
    log('No existing messages - skipping catch-up phase')
    return
  }

  log(`Catching up on ${channelsWithMessages.length} channels...`)

  const channelMap = new Map(channels.map(ch => [ch.id, ch]))
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
      const newMessages = recentMessages.filter(msg => !messageExists(msg.id))

      if (newMessages.length > 0) {
        const records = newMessages.map(messageToRecord)
        saveMessages(records)
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
async function runBackfillLoop(
  client: DiscordPlatformClient,
  channels: IPlatformChannel[]
): Promise<void> {
  // Track which channels still have more history to fetch
  const activeChannels = new Set(channels.map(ch => ch.id))
  const channelMap = new Map(channels.map(ch => [ch.id, ch]))

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
      const stats = getTotalStats()
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
  client.onMessage((message: IPlatformMessage) => {
    try {
      // Ensure channel exists before saving (satisfies foreign key constraint)
      ensureChannelExists(message.channelId)
      // Save the message
      const record = messageToRecord(message)
      saveMessage(record)
      log(`Real-time: Saved message from ${message.author} in channel ${message.channelId}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Real-time: Failed to save message ${message.id}: ${errorMessage}`)
    }
  })

  client.onMessageUpdate((message: IPlatformMessage) => {
    try {
      // Ensure channel exists before saving (satisfies foreign key constraint)
      ensureChannelExists(message.channelId)
      // Update the message
      const record = messageToRecord(message)
      saveMessage(record)
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
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('\nDiscord Message Archive Service\n')

  // Initialize database
  log('Initializing database...')
  initDB()

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
      saveChannel(channelToRecord(channel))
    }

    // Set up real-time message handling
    log('Setting up real-time message handlers...')
    setupRealtimeHandlers(client)

    // Show current stats
    const stats = getTotalStats()
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
