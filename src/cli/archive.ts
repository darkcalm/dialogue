/**
 * Background archive service for Discord messages
 * Gradually fetches message history and subscribes to real-time updates
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
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
  getChannelsWithMessagesAfter,
  updateChannelOldestFetched,
  getChannelBackfillStatus,
  getTotalStats,
  getChannelStats,
  messageExists,
  channelExists,
  ensureChannelExists,
  deleteMessage,
  deleteMessagesInTimeRange,
  getMessageIdsInTimeRange,
  getChannelsWithActivityInTimeRange,
  MessageRecord,
  ChannelRecord,
  enableDualWriteMode,
} from './db'
import { initDBWithCache, hasLocalCache } from './local-cache'

// Configuration
const FETCH_BATCH_SIZE = 100 // Discord API limit
const MIN_DELAY_MS = 3000 // 3 seconds minimum between fetches
const MAX_DELAY_MS = 8000 // 8 seconds maximum between fetches

// Lock file to indicate archive is running
const ARCHIVE_LOCK_FILE = path.join(os.homedir(), '.dialogue-archive.lock')
const ARCHIVE_TIMESTAMP_FILE = path.join(os.homedir(), '.dialogue-archive-timestamp.txt')

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
 * Get last archive shutdown timestamp
 */
function getLastArchiveTimestamp(): Date | null {
  try {
    if (!fs.existsSync(ARCHIVE_TIMESTAMP_FILE)) return null
    const timestamp = fs.readFileSync(ARCHIVE_TIMESTAMP_FILE, 'utf-8').trim()
    return new Date(timestamp)
  } catch {
    return null
  }
}

/**
 * Save current timestamp (called on shutdown)
 */
function saveArchiveTimestamp(): void {
  try {
    fs.writeFileSync(ARCHIVE_TIMESTAMP_FILE, new Date().toISOString())
  } catch {
    // Ignore errors
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
  // Try to get last archive timestamp for efficient catch-up
  const lastTimestamp = getLastArchiveTimestamp()
  let channelsWithMessages: string[]

  if (lastTimestamp) {
    // Efficient path: only catch up on channels with activity since last run
    const hoursSinceLastRun = (Date.now() - lastTimestamp.getTime()) / (1000 * 60 * 60)
    log(`Last archive run: ${lastTimestamp.toISOString()} (${hoursSinceLastRun.toFixed(1)}h ago)`)

    channelsWithMessages = await getChannelsWithMessagesAfter(lastTimestamp.toISOString())
    log(`Found ${channelsWithMessages.length} channels with recent activity`)
  } else {
    // Fallback: catch up on all channels with messages
    channelsWithMessages = await getChannelsWithMessages()
    log(`No last run timestamp - catching up on all ${channelsWithMessages.length} channels`)
  }

  if (channelsWithMessages.length === 0) {
    log('No channels need catch-up - skipping catch-up phase')
    return
  }

  const channelMap = new Map(channels.map((ch) => [ch.id, ch]))
  let totalNewMessages = 0
  let processedChannels = 0

  for (const channelId of channelsWithMessages) {
    if (!isRunning) break

    processedChannels++
    const channel = channelMap.get(channelId)
    if (!channel) continue

    // Log each channel being processed
    log(`  [${processedChannels}/${channelsWithMessages.length}] Catching up #${channel.name}...`)

    try {
      const startTime = Date.now()
      // Fetch the most recent messages from Discord
      const recentMessages = await client.getMessages(channelId, FETCH_BATCH_SIZE)
      const fetchTime = Date.now() - startTime

      if (recentMessages.length === 0) {
        log(`    → 0 messages (${fetchTime}ms)`)
        continue
      }

      // Filter to only messages we don't have yet - use saveMessages with ON CONFLICT
      // to avoid individual messageExists checks
      const records = recentMessages.map(messageToRecord)
      const saveStart = Date.now()
      await saveMessages(records)
      const saveTime = Date.now() - saveStart
      
      log(`    → ${recentMessages.length} messages fetched (${fetchTime}ms fetch, ${saveTime}ms save)`)
      
      // Count actual new messages by checking what was inserted vs updated
      // For now, just log that we processed the channel
      const newCount = recentMessages.length
      if (newCount > 0) {
        totalNewMessages += newCount
      }

      // Small delay between channels
      await sleep(500)
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

  client.onMessageDelete(async (channelId: string, messageId: string) => {
    try {
      const deleted = await deleteMessage(messageId)
      if (deleted) {
        log(`Real-time: Deleted message ${messageId} from channel ${channelId}`)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Real-time: Failed to delete message ${messageId}: ${errorMessage}`)
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

    // Save timestamp for efficient catch-up on next run
    saveArchiveTimestamp()

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
 * Refill messages for a channel within a time range
 * Deletes existing messages in the range and refetches from Discord
 */
export async function refillTimeRange(
  client: DiscordPlatformClient,
  channelId: string,
  startTime: string,
  endTime: string
): Promise<{ deleted: number; fetched: number }> {
  log(`Refill: Starting for channel ${channelId} from ${startTime} to ${endTime}`)

  // Get channel info for logging
  const channelInfo = await client.getChannel(channelId)
  const channelName = channelInfo?.name || channelId

  // Get info about what we're deleting
  const rangeInfo = await getMessageIdsInTimeRange(channelId, startTime, endTime)
  log(`Refill: Found ${rangeInfo.count} messages to flush in #${channelName}`)

  // Delete messages in the time range
  const deleted = await deleteMessagesInTimeRange(channelId, startTime, endTime)
  log(`Refill: Deleted ${deleted} messages from #${channelName}`)

  // Fetch fresh messages from Discord
  // We need to fetch all messages in the time range, which may require multiple API calls
  let fetched = 0
  let lastMessageId: string | undefined
  const startDate = new Date(startTime)
  const endDate = new Date(endTime)

  // First, get the most recent messages and work backwards
  let messages = await client.getMessages(channelId, FETCH_BATCH_SIZE)

  while (messages.length > 0 && isRunning) {
    // Filter to only messages within our time range
    const inRangeMessages = messages.filter((msg) => {
      const msgDate = new Date(msg.timestamp)
      return msgDate >= startDate && msgDate <= endDate
    })

    if (inRangeMessages.length > 0) {
      const records = inRangeMessages.map(messageToRecord)
      await saveMessages(records)
      fetched += inRangeMessages.length
      log(`Refill: Saved ${inRangeMessages.length} messages in #${channelName}`)
    }

    // Check if we've gone past our time range
    const oldestInBatch = messages[messages.length - 1]
    const oldestDate = new Date(oldestInBatch.timestamp)

    if (oldestDate < startDate) {
      // We've gone past the start of our range, stop
      break
    }

    // Get the next batch
    lastMessageId = oldestInBatch.id
    await sleep(randomDelay())
    messages = await client.getMessagesBefore(channelId, lastMessageId, FETCH_BATCH_SIZE)
  }

  log(`Refill: Complete for #${channelName}. Deleted ${deleted}, fetched ${fetched}`)
  return { deleted, fetched }
}

/**
 * Show archive status and exit
 */
async function showStatus(searchTerm?: string, threadsOnly: boolean = false): Promise<void> {
  await initDB()
  const stats = await getTotalStats()
  let channelStats = await getChannelStats()

  // Filter by search term if provided
  if (searchTerm) {
    const lowerSearch = searchTerm.toLowerCase()
    channelStats = channelStats.filter(ch =>
      ch.name.toLowerCase().includes(lowerSearch)
    )
  }

  // Filter to threads only if requested
  if (threadsOnly) {
    channelStats = channelStats.filter(ch =>
      ch.type && (ch.type.includes('THREAD') || ch.type.includes('Thread'))
    )
  }

  console.log('\nArchive Status\n')
  console.log(`Total messages: ${stats.totalMessages.toLocaleString()}`)
  console.log(`Total channels: ${stats.totalChannels}`)
  console.log(`Backfill: ${stats.channelsComplete} complete, ${stats.channelsInProgress} in progress`)
  console.log(`Running: ${isArchiveRunning() ? 'yes (PID ' + fs.readFileSync(ARCHIVE_LOCK_FILE, 'utf-8').trim() + ')' : 'no'}`)

  if (channelStats.length > 0) {
    const displayLimit = searchTerm ? channelStats.length : 20
    const title = searchTerm
      ? `\nChannels matching "${searchTerm}" (${channelStats.length} found):`
      : '\nChannels:'
    console.log(title)

    for (const ch of channelStats.slice(0, displayLimit)) {
      const status = ch.backfillComplete ? '✓' : '…'
      const isThread = ch.type && (ch.type.includes('THREAD') || ch.type.includes('Thread'))
      const prefix = isThread ? '🧵' : '#'
      console.log(`  ${status} ${prefix}${ch.name}: ${ch.messageCount.toLocaleString()} messages`)
    }

    if (!searchTerm && channelStats.length > 20) {
      console.log(`  ... and ${channelStats.length - 20} more`)
      console.log(`\nTip: Use --status=<search> to filter channels (e.g., --status=crypto)`)
    }
  } else if (searchTerm) {
    console.log(`\nNo channels found matching "${searchTerm}"`)
  }

  closeDB()
}

/**
 * Parse duration string (e.g., "12h", "24h", "7d") to milliseconds
 */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(h|d)$/)
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use format like "12h" or "7d"`)
  }
  const value = parseInt(match[1], 10)
  const unit = match[2]
  if (unit === 'h') return value * 60 * 60 * 1000
  if (unit === 'd') return value * 24 * 60 * 60 * 1000
  throw new Error(`Unknown unit: ${unit}`)
}

/**
 * Run refill for all channels for a given duration
 */
async function runRefill(durationStr: string = '12h'): Promise<void> {
  console.log('\nDiscord Message Archive - Refill Mode\n')

  // Check if archive is running
  if (isArchiveRunning()) {
    console.log('Error: Archive service is currently running.')
    console.log('Please stop it first (Ctrl+C or kill the process), then run --refill.')
    process.exit(1)
  }

  const durationMs = parseDuration(durationStr)
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - durationMs)

  log(`Refill: Will flush and refetch messages from ${startTime.toISOString()} to ${endTime.toISOString()}`)

  // Initialize database
  log('Initializing database...')
  await initDB()

  // Connect to Discord
  log('Connecting to Discord...')
  const refillClient = new DiscordPlatformClient()

  try {
    await refillClient.connect()
    log('Connected to Discord!')

    // Enable dual-write mode for real-time event handling
    enableDualWriteMode()

    // Set up real-time handlers to capture new messages during refill
    log('Setting up real-time message handlers...')
    setupRealtimeHandlers(refillClient)
    log('Real-time handlers active - new messages will be captured during refill')

    // Get channels with activity in the time range (using event log for efficiency)
    log('Querying for channels with activity in time range...')
    const activeChannelIds = await getChannelsWithActivityInTimeRange(
      startTime.toISOString(),
      endTime.toISOString()
    )

    if (activeChannelIds.length === 0) {
      log('No channels had activity in the time range - refill complete!')
      await refillClient.disconnect()
      closeDB()
      return
    }

    log(`Found ${activeChannelIds.length} channels with activity (skipping ${(await refillClient.getChannels()).length - activeChannelIds.length} inactive channels)`)

    // Get channel details for logging
    const allChannels = await refillClient.getChannels()
    const channelMap = new Map(allChannels.map(ch => [ch.id, ch]))

    let totalDeleted = 0
    let totalFetched = 0
    let processedCount = 0

    for (const channelId of activeChannelIds) {
      if (!isRunning) break

      processedCount++
      const channel = channelMap.get(channelId)
      const channelName = channel?.name || channelId

      try {
        const result = await refillTimeRange(
          refillClient,
          channelId,
          startTime.toISOString(),
          endTime.toISOString()
        )
        totalDeleted += result.deleted
        totalFetched += result.fetched

        if (processedCount % 10 === 0) {
          log(`Progress: ${processedCount}/${activeChannelIds.length} channels processed`)
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log(`Refill: Error on #${channelName}: ${errorMessage}`)
      }

      // Small delay between channels
      await sleep(1000)
    }

    log(`\nRefill complete!`)
    log(`Total deleted: ${totalDeleted}`)
    log(`Total fetched: ${totalFetched}`)

    await refillClient.disconnect()
    closeDB()

    // Auto-start the archive service after successful refill
    log('\nStarting archive service...')
    try {
      const archiveProcess = spawn('npm', ['run', 'archive'], {
        detached: true,
        stdio: 'ignore',
        shell: true
      })
      archiveProcess.unref()
      log('Archive service started successfully')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Warning: Could not auto-start archive service: ${errorMessage}`)
      log('Please start it manually with: npm run archive')
    }

    process.exit(0)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('Fatal error:', errorMessage)
    closeDB()
    process.exit(1)
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Handle --status flag (with optional search term)
  const statusArg = process.argv.find((arg) => arg.startsWith('--status'))
  if (statusArg) {
    // Parse optional search: --status or --status=crypto
    const searchTerm = statusArg.includes('=') ? statusArg.split('=')[1] : undefined
    const threadsOnly = process.argv.includes('--threads')
    await showStatus(searchTerm, threadsOnly)
    process.exit(0)
  }

  // Handle --refill flag
  const refillArg = process.argv.find((arg) => arg.startsWith('--refill'))
  if (refillArg) {
    // Parse optional duration: --refill or --refill=24h
    const duration = refillArg.includes('=') ? refillArg.split('=')[1] : '12h'
    await runRefill(duration)
    return
  }

  console.log('\nDiscord Message Archive Service\n')

  // Check if already running
  if (isArchiveRunning()) {
    console.log('Archive service is already running. Use --status to see progress.')
    process.exit(0)
  }

  // Write lock file
  writeLockFile()

  // Initialize database
  log('Initializing database...')
  await initDB()

  // Initialize local cache for dual-write mode
  log('Initializing local cache for dual-write...')
  if (!hasLocalCache()) {
    await initDBWithCache({ forceSync: true })
  } else {
    await initDBWithCache() // Sync if stale
  }

  // Enable dual-write: writes go to both Turso and local cache
  enableDualWriteMode()
  log('Dual-write enabled: messages saved to both Turso and local cache')

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
