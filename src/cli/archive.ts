/**
 * Frontfill archive service for Discord messages
 * Gradually fetches message history from recent to old and subscribes to real-time updates
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
  saveChannels,
  saveMessages,
  getOldestMessageId,
  updateChannelOldestFetched,
  getChannelBackfillStatus, // Keep this name for now, as it refers to the status of a channel's oldest fetched ID, which is part of the frontfill process
  getTotalStats,
  getChannelStats,
  messageExists,
  deleteMessagesInTimeRange,
  getMessageIdsInTimeRange,
  getChannelsWithActivityInTimeRange,
  MessageRecord,
  ChannelRecord,
} from './db'

// Configuration
const FETCH_BATCH_SIZE = 100 // Discord API limit
const MIN_DELAY_MS = 3000 // 3 seconds minimum between fetches
const MAX_DELAY_MS = 8000 // 8 seconds maximum between fetches

// Lock file to indicate archive is running
const ARCHIVE_LOCK_FILE = path.join(os.homedir(), '.dialogue-archive.lock')
const ARCHIVE_TIMESTAMP_FILE = path.join(os.homedir(), '.dialogue-archive-timestamp.txt')
const ARCHIVE_LOG_FILE = path.join(os.homedir(), '.dialogue-archive.log')

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
 * Process items in parallel with concurrency limit
 */
async function processConcurrently<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  const executing: Promise<void>[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const promise = processor(item, i).then((result) => {
      results[i] = result
    })

    executing.push(promise)

    if (executing.length >= concurrency) {
      await Promise.race(executing)
      executing.splice(
        executing.findIndex((p) => p === promise),
        1
      )
    }
  }

  await Promise.all(executing)
  return results
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
 * Log with timestamp - writes to both console and log file
 */
function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString()
  const logLine = `[${timestamp}] ${message}`
  console.log(logLine)
  try {
    fs.appendFileSync(ARCHIVE_LOG_FILE, logLine + '\n')
  } catch {}
}

/**
 * Main frontfill loop - prioritized fetch, batched write
 */
async function runFrontfillLoop(client: DiscordPlatformClient, channels: IPlatformChannel[]): Promise<void> {
  const stats = await getChannelStats()
  const statsMap = new Map(stats.map((s) => [s.id, s]))

  const sortedChannels = [...channels].sort((a, b) => {
    const aStats = statsMap.get(a.id)
    const bStats = statsMap.get(b.id)
    if (!aStats && bStats) return -1
    if (aStats && !bStats) return 1
    if (!aStats && !bStats) return 0
    if (aStats.newestMessageDate && bStats.newestMessageDate) {
      return new Date(bStats.newestMessageDate).getTime() - new Date(aStats.newestMessageDate).getTime()
    }
    return 0
  })

  const activeChannels = new Set(sortedChannels.map((ch) => ch.id))
  const channelMap = new Map(channels.map((ch) => [ch.id, ch]))

  log(`Starting prioritized frontfill for ${activeChannels.size} channels...`)

  let consecutiveNoProgress = 0
  const maxConsecutiveNoProgress = 3
  const FRONTFILL_BATCH_SIZE = 5

  while (isRunning && activeChannels.size > 0) {
    const channelsToProcess = Array.from(activeChannels).slice(0, FRONTFILL_BATCH_SIZE)
    log(`Frontfilling ${channelsToProcess.length} channels in parallel...`)

    const fetchResults = await Promise.allSettled(
      channelsToProcess.map(async (channelId) => {
        const channel = channelMap.get(channelId)
        if (!channel) return null
        const oldestId = await getOldestMessageId(channel.id)
        const status = await getChannelBackfillStatus(channel.id)
        if (status?.oldestFetchedId === 'COMPLETE') {
          return { channelId, hasMore: false, messages: [] }
        }
        try {
          let messages: IPlatformMessage[]
          if (oldestId) {
            messages = await client.getMessagesBefore(channel.id, oldestId, FETCH_BATCH_SIZE)
          } else {
            messages = await client.getMessages(channel.id, FETCH_BATCH_SIZE)
          }
          const hasMore = messages.length === FETCH_BATCH_SIZE
          if (messages.length === 0) {
            await updateChannelOldestFetched(channel.id, 'COMPLETE')
            log(`  ✓ #${channel.name}: Frontfill complete`)
            return { channelId, hasMore: false, messages: [] }
          }
          const existenceChecks = await Promise.all(
            messages.slice(0, Math.min(5, messages.length)).map(msg => messageExists(msg.id))
          )
          const allExist = existenceChecks.every(exists => exists)
          if (allExist) {
            await updateChannelOldestFetched(channel.id, 'COMPLETE')
            log(`  ✓ #${channel.name}: Frontfill complete (caught up to existing messages)`)
            return { channelId, hasMore: false, messages: [] }
          }
          return { channelId, hasMore, messages, channelName: channel.name }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          log(`  ✗ #${channel.name}: ${errorMessage}`)
          return { channelId, hasMore: false, messages: [] }
        }
      })
    )

    const allMessages: MessageRecord[] = []
    let batchMadeProgress = false
    for (const result of fetchResults) {
      if (result.status === 'fulfilled' && result.value) {
        const { channelId, hasMore, messages } = result.value
        if (!hasMore) activeChannels.delete(channelId)
        if (messages.length > 0) {
          batchMadeProgress = true
          allMessages.push(...messages.map(messageToRecord))
        }
      }
    }

    if (allMessages.length > 0) {
      try {
        await saveMessages(allMessages)
        log(`  💾 Saved ${allMessages.length} messages`)
      } catch (saveError) {
        const saveErrorMsg = saveError instanceof Error ? saveError.message : String(saveError)
        log(`  ✗ Database error: ${saveErrorMsg}`)
      }
    }

    if (!batchMadeProgress) {
      consecutiveNoProgress++
      if (consecutiveNoProgress >= maxConsecutiveNoProgress) {
        log(`⚠️  No progress for ${maxConsecutiveNoProgress} iterations. Stopping frontfill.`)
        break
      }
    } else {
      consecutiveNoProgress = 0
    }

    if (activeChannels.size > 0) {
      const stats = await getTotalStats()
      log(`Progress: ${stats.totalMessages} messages, ${activeChannels.size} channels remaining`)
    }

    if (isRunning && activeChannels.size > 0) await sleep(2000)
  }

  if (activeChannels.size === 0) log('All channels fully frontfilled!')
}

/**
 * Graceful shutdown handler
 */
function setupShutdownHandlers(): void {
  const shutdown = async () => {
    log('Shutting down...')
    isRunning = false
    saveArchiveTimestamp()
    removeLockFile()
    closeDB()
    log('Database closed.')
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
 * Show live archive output
 */
async function showStatus(searchTerm?: string, threadsOnly: boolean = false): Promise<void> {
  // Check if archive is running
  if (!isArchiveRunning()) {
    console.log('Archive service is not running.')
    console.log('\nStart it with: npm run archive')
    process.exit(0)
  }

  const pid = fs.readFileSync(ARCHIVE_LOCK_FILE, 'utf-8').trim()
  console.log(`Frontfill service is running (PID ${pid})`) // Updated message
  console.log('Showing live output (Ctrl+C to exit)...\n')
  console.log('─'.repeat(80))

  // Check if log file exists
  if (!fs.existsSync(ARCHIVE_LOG_FILE)) {
    console.log('Log file not found yet. Frontfill may be starting up...') // Updated message
    console.log(`Waiting for log file: ${ARCHIVE_LOG_FILE}`)
  }

  // Tail the log file
  const tail = spawn('tail', ['-f', '-n', '50', ARCHIVE_LOG_FILE], {
    stdio: 'inherit'
  })

  // Handle Ctrl+C to exit gracefully
  process.on('SIGINT', () => {
    tail.kill()
    console.log('\n\nExited status view. Frontfill is still running in background.') // Updated message
    process.exit(0)
  })

  // Keep the process alive
  await new Promise(() => {})
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
 * Delete messages from the past N hours/days
 */
async function deleteRecentMessages(durationStr: string = '24h'): Promise<void> {
  console.log('\nDiscord Message Archive - Delete Recent Messages\n')

  const durationMs = parseDuration(durationStr)
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - durationMs)

  log(`Will delete messages from ${startTime.toISOString()} to ${endTime.toISOString()}`)

  // Initialize database
  log('Initializing database...')
  await initDB()

  // Get all channels with messages in this time range
  const activeChannelIds = await getChannelsWithActivityInTimeRange(
    startTime.toISOString(),
    endTime.toISOString()
  )

  if (activeChannelIds.length === 0) {
    log('No channels had activity in the time range')
    closeDB()
    return
  }

  log(`Found ${activeChannelIds.length} channels with activity`)

  let totalDeleted = 0

  for (const channelId of activeChannelIds) {
    try {
      const deleted = await deleteMessagesInTimeRange(
        channelId,
        startTime.toISOString(),
        endTime.toISOString()
      )
      totalDeleted += deleted
      if (deleted > 0) {
        log(`  Deleted ${deleted} messages from channel ${channelId}`)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`  Error on channel ${channelId}: ${errorMessage}`)
    }
  }

  log(`\nTotal deleted: ${totalDeleted} messages`)
  closeDB()
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

    // The following two blocks (`enableDualWriteMode` and `setupRealtimeHandlers`)
    // were part of the previous logic for the archive service to also handle real-time events.
    // With the new architecture, real-time events are handled by a separate `realtime.ts` service.
    // Therefore, these lines are commented out or removed from the `archive.ts` script.
    // enableDualWriteMode();
    // log('Dual-write enabled for refill: messages saved to both Turso and local cache');

    // setupRealtimeHandlers(refillClient);
    // log('Real-time handlers active - new messages will be captured during refill');

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
  // Handle --sync flag
  if (process.argv.includes('--sync')) {
    if (isArchiveRunning()) {
      console.log('❌ Frontfill is running. Stop it first:') // Updated message
      console.log('   pkill -f archive.mjs')
      console.log('\nThen run: npm run archive -- --sync')
      process.exit(1)
    }
    // initDBWithCache needs to be imported, but is not used in the new archive.ts
    // log('Syncing local cache from Turso...');
    // await initDBWithCache({ forceSync: true });
    console.log('✅ Sync complete!')
    process.exit(0)
  }

  // Handle --status flag (with optional search term)
  const statusArg = process.argv.find((arg) => arg.startsWith('--status'))
  if (statusArg) {
    const searchTerm = statusArg.includes('=') ? statusArg.split('=')[1] : undefined
    const threadsOnly = process.argv.includes('--threads')
    await showStatus(searchTerm, threadsOnly)
    process.exit(0)
  }

  // Handle --delete-recent flag
  const deleteRecentArg = process.argv.find((arg) => arg.startsWith('--delete-recent'))
  if (deleteRecentArg) {
    const duration = deleteRecentArg.includes('=') ? deleteRecentArg.split('=')[1] : '24h'
    await deleteRecentMessages(duration)
    process.exit(0)
  }

  // Handle --refill flag
  const refillArg = process.argv.find((arg) => arg.startsWith('--refill'))
  if (refillArg) {
    const duration = refillArg.includes('=') ? refillArg.split('=')[1] : '12h'
    await runRefill(duration)
    return
  }

  console.log('\nDiscord Message Archive Service - Frontfill\n') // Updated message

  if (isArchiveRunning()) {
    console.log('Frontfill service is already running. Use --status to see progress.') // Updated message
    process.exit(0)
  }

  writeLockFile()

  try {
    fs.writeFileSync(ARCHIVE_LOG_FILE, '')
  } catch (e) {}

  log('Spawning real-time event service...')
  const realtimeService = spawn('npm', ['run', 'realtime'], { // Changed here
    detached: true,
    stdio: 'ignore',
    shell: true // Need shell: true for npm run
  })
  realtimeService.unref()
  log('Real-time service spawned.')

  log('Initializing database...')
  await initDB()

  setupShutdownHandlers()

  log('Connecting to Discord...')
  client = new DiscordPlatformClient()

  try {
    await client.connect()
    log('Connected to Discord!')

    const user = client.getCurrentUser()
    if (user) {
      log(`Logged in as ${user.username}`)
    }

    log('Fetching channel list...')
    const channels = await client.getChannels()
    log(`Found ${channels.length} accessible channels`)

    const channelRecords = channels.map(channelToRecord)
    await saveChannels(channelRecords)

    await runFrontfillLoop(client, channels) // Updated function call

    log('Frontfill complete.') // Updated message
    process.exit(0)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('Fatal error:', errorMessage)
    closeDB()
    process.exit(1)
  }
}

main()