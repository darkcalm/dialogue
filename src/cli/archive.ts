/**
 * Frontfill archive service for Discord messages.
 * Fetches all historical messages from recent to old, writing to a local DB first.
 * Once complete, it batch-syncs the local data to a remote Turso DB.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { DiscordPlatformClient } from '@/platforms/discord/client'
import { IPlatformMessage, IPlatformChannel } from '@/platforms/types'
import { Client } from '@libsql/client'
import {
  initDB,
  closeAllDBs,
  getClient,
  saveChannels,
  saveMessages,
  recordMessageEvent,
  getOldestMessageId,
  getChannelStats,
  messageExists,
  updateChannelOldestFetched,
  getChannelBackfillStatus,
  rowToChannelRecord,
  rowToMessageRecord,
  ChannelRecord,
  MessageRecord,
} from './db'

// Configuration
const FETCH_BATCH_SIZE = 100
const FRONTFILL_BATCH_SIZE = 10

// State
let isRunning = true
let discordClient: DiscordPlatformClient | null = null
let localDb: Client | null = null
let remoteDb: Client | null = null

const ARCHIVE_LOCK_FILE = path.join(os.homedir(), '.dialogue-archive.lock')
const ARCHIVE_LOG_FILE = path.join(os.homedir(), '.dialogue-archive.log')

function writeLockFile(): void { fs.writeFileSync(ARCHIVE_LOCK_FILE, process.pid.toString(), 'utf-8') }
function removeLockFile(): void { try { if (fs.existsSync(ARCHIVE_LOCK_FILE)) fs.unlinkSync(ARCHIVE_LOCK_FILE) } catch {} }
function isArchiveRunning(): boolean {
  try {
    if (!fs.existsSync(ARCHIVE_LOCK_FILE)) return false
    const pid = parseInt(fs.readFileSync(ARCHIVE_LOCK_FILE, 'utf-8').trim(), 10)
    process.kill(pid, 0)
    return true
  } catch {
    if (fs.existsSync(ARCHIVE_LOCK_FILE)) fs.unlinkSync(ARCHIVE_LOCK_FILE)
    return false
  }
}
function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString()
  const logLine = `[${timestamp}] ${message}`
  console.log(logLine)
  try { fs.appendFileSync(ARCHIVE_LOG_FILE, logLine + '\n') } catch {}
}
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

function messageToRecord(msg: IPlatformMessage): MessageRecord {
  return {
    id: msg.id, channelId: msg.channelId, authorId: msg.authorId, authorName: msg.author,
    content: msg.content, timestamp: msg.timestamp, editedTimestamp: msg.editedTimestamp,
    isBot: msg.isBot, messageType: msg.messageType, pinned: msg.pinned,
    attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
    embeds: msg.embeds.length > 0 ? msg.embeds : undefined,
    stickers: msg.stickers.length > 0 ? msg.stickers : undefined,
    reactions: msg.reactions.length > 0 ? msg.reactions : undefined,
    replyToId: msg.replyTo?.messageId, threadId: msg.threadId,
  }
}
function channelToRecord(ch: IPlatformChannel): ChannelRecord {
  return {
    id: ch.id, name: ch.name, guildId: ch.metadata?.guildId, guildName: ch.parentName,
    parentId: ch.parentId, topic: ch.topic, type: ch.type,
  }
}

function snowflakeToTimestamp(snowflake: string): number {
  const DISCORD_EPOCH = 1420070400000n
  return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH)
}

async function runFrontfillLoop(discordClient: DiscordPlatformClient, localDb: Client, channels: IPlatformChannel[]): Promise<void> {
  const backfillStatuses = await Promise.all(
    channels.map(ch => getChannelBackfillStatus(localDb, ch.id))
  )
  const incompleteChannels = channels.filter((ch, i) =>
    backfillStatuses[i]?.oldestFetchedId !== 'COMPLETE'
  )

  const completedSet = new Set<string>()
  const channelMap = new Map(channels.map((ch) => [ch.id, ch]))
  // Track the frontier: for unfetched channels this is lastMessageId,
  // after a fetch it becomes the oldest fetched message ID (the next unfetched is just before it)
  const frontierMap = new Map<string, string | null>(
    incompleteChannels.map(ch => [ch.id, ch.metadata?.lastMessageId ?? null])
  )

  const threadCount = incompleteChannels.filter(ch => ch.type === 'thread').length
  const textCount = incompleteChannels.length - threadCount
  log(`Starting prioritized frontfill for ${textCount} channels + ${threadCount} threads (${channels.length - incompleteChannels.length} already complete)...`)

  let consecutiveNoProgress = 0
  const maxConsecutiveNoProgress = 3

  while (isRunning) {
    // Re-sort each round by frontier (most recent unfetched first)
    const remaining = incompleteChannels.filter(ch => !completedSet.has(ch.id))
    if (remaining.length === 0) break

    remaining.sort((a, b) => {
      const aFrontier = frontierMap.get(a.id)
      const bFrontier = frontierMap.get(b.id)
      if (!aFrontier && bFrontier) return 1
      if (aFrontier && !bFrontier) return -1
      if (!aFrontier && !bFrontier) return 0
      return snowflakeToTimestamp(bFrontier!) - snowflakeToTimestamp(aFrontier!)
    })

    const batch = remaining.slice(0, FRONTFILL_BATCH_SIZE)

    const batchThreads = batch.filter(ch => ch.type === 'thread').length
    const batchTexts = batch.length - batchThreads
    log(`Frontfilling ${batchTexts} channels + ${batchThreads} threads (${remaining.length} remaining)...`)

    const fetchResults = await Promise.allSettled(
      batch.map(async (channel) => {
        const status = await getChannelBackfillStatus(localDb, channel.id)
        if (status?.oldestFetchedId === 'COMPLETE') return { channelId: channel.id, messages: [] as IPlatformMessage[], hasMore: false }
        
        const oldestId = await getOldestMessageId(localDb, channel.id)
        
        try {
          const messages = oldestId
            ? await discordClient.getMessagesBefore(channel.id, oldestId, FETCH_BATCH_SIZE)
            : await discordClient.getMessages(channel.id, FETCH_BATCH_SIZE)
          
          if (messages.length === 0) {
            await updateChannelOldestFetched(localDb, channel.id, 'COMPLETE')
            log(`  ✓ #${channel.name}: Frontfill complete`)
            return { channelId: channel.id, messages: [] as IPlatformMessage[], hasMore: false }
          }
          
          const existenceChecks = await Promise.all(messages.map(msg => messageExists(localDb, msg.id)))
          if (existenceChecks.every(exists => exists)) {
            await updateChannelOldestFetched(localDb, channel.id, 'COMPLETE')
            log(`  ✓ #${channel.name}: Frontfill complete (caught up to existing messages)`)
            return { channelId: channel.id, messages: [] as IPlatformMessage[], hasMore: false }
          }

          return { channelId: channel.id, messages, hasMore: messages.length === FETCH_BATCH_SIZE }
        } catch (error) {
          log(`  ✗ #${channel.name}: ${error instanceof Error ? error.message : 'Unknown'}`)
          return { channelId: channel.id, messages: [] as IPlatformMessage[], hasMore: false }
        }
      })
    )
    
    let batchMadeProgress = false
    let channelsCompleted = 0

    for (const result of fetchResults) {
        if (result.status === 'fulfilled' && result.value) {
            const { channelId, messages, hasMore } = result.value
            if (!hasMore) {
              completedSet.add(channelId)
              channelsCompleted++
            }
            if (messages.length > 0) {
                batchMadeProgress = true
                await saveMessages(localDb, messages.map(messageToRecord))
                // Update frontier to the oldest message we just fetched
                const oldestMsg = messages.reduce((oldest, msg) =>
                  BigInt(msg.id) < BigInt(oldest.id) ? msg : oldest
                )
                frontierMap.set(channelId, oldestMsg.id)
                log(`  💾 Saved ${messages.length} messages for #${channelMap.get(channelId)?.name ?? channelId}`)
            }
        }
    }

    if (!batchMadeProgress && channelsCompleted === 0) {
      consecutiveNoProgress++
      if (consecutiveNoProgress >= maxConsecutiveNoProgress) {
        log(`⚠️  No progress for ${maxConsecutiveNoProgress} iterations. Stopping frontfill.`)
        break
      }
    } else {
      consecutiveNoProgress = 0
    }
    
    if (isRunning && remaining.length > batch.length) await sleep(2000)
  }
}

async function syncToRemote(localDb: Client, remoteDb: Client) {
    log('🚀 Starting incremental sync from local archive to remote Turso archive...')

    // Ensure remote schema exists (idempotent - won't recreate if exists)
    log('Ensuring remote schema exists...')
    await initDB(remoteDb)

    const channels = (await localDb.execute("SELECT * FROM channels")).rows
    const messages = (await localDb.execute("SELECT * FROM messages")).rows

    log(`Syncing ${channels.length} channels and ${messages.length} messages...`)

    // Use existing upsert functions - they only write when data changes
    if (channels.length > 0) {
        await saveChannels(remoteDb, channels.map(rowToChannelRecord))
        log(`  ✓ Synced ${channels.length} channels`)
    }

    if (messages.length > 0) {
        const chunkSize = 500
        const allRecords = messages.map(rowToMessageRecord)
        for (let i = 0; i < allRecords.length; i += chunkSize) {
            const chunk = allRecords.slice(i, i + chunkSize)
            await saveMessages(remoteDb, chunk)
            log(`  Synced ${i + chunk.length} of ${allRecords.length} messages...`)
        }
    }

    log('✅ Incremental sync complete.')
}

// Helper functions for dual-write to local and remote archive DBs
async function dualWriteSaveMessages(records: MessageRecord[]) {
  if (localDb) await saveMessages(localDb, records).catch(err => log(`⚠️ Local archive DB save failed: ${err.message}`))
  if (remoteDb) await saveMessages(remoteDb, records).catch(err => log(`⚠️ Remote archive DB save failed: ${err.message}`))
}

async function dualWriteSaveChannels(records: ChannelRecord[]) {
  if (localDb) await saveChannels(localDb, records).catch(err => log(`⚠️ Local archive DB channel save failed: ${err.message}`))
  if (remoteDb) await saveChannels(remoteDb, records).catch(err => log(`⚠️ Remote archive DB channel save failed: ${err.message}`))
}

async function dualWriteRecordDeleteEvent(messageId: string) {
  if (localDb) await recordMessageEvent(localDb, messageId, 'delete').catch(err => log(`⚠️ Local archive DB record delete event failed: ${err.message}`))
  if (remoteDb) await recordMessageEvent(remoteDb, messageId, 'delete').catch(err => log(`⚠️ Remote archive DB record delete event failed: ${err.message}`))
}

async function channelExists(channelId: string): Promise<boolean> {
  const db = localDb || remoteDb
  if (!db) return false
  const result = await db.execute({ sql: `SELECT 1 FROM channels WHERE id = ? LIMIT 1`, args: [channelId] })
  return result.rows.length > 0
}

/**
 * Set up event listeners for ongoing archive updates
 */
function setupArchiveEventHandlers(client: DiscordPlatformClient): void {
  client.onMessage(async (message: IPlatformMessage) => {
    try {
      if (!(await channelExists(message.channelId))) {
        const channelInfo = await client.getChannel(message.channelId)
        if (channelInfo) {
          await dualWriteSaveChannels([channelToRecord(channelInfo)])
          log(`Discovered new channel #${channelInfo.name}`)
        }
      }
      await dualWriteSaveMessages([messageToRecord(message)])
      log(`Archived new message from ${message.author} in channel ${message.channelId}`)
    } catch (error) {
      log(`Failed to archive message ${message.id}: ${error instanceof Error ? error.message : 'Unknown'}`)
    }
  })

  client.onMessageUpdate(async (message: IPlatformMessage) => {
    try {
      if (!(await channelExists(message.channelId))) {
        const channelInfo = await client.getChannel(message.channelId)
        if (channelInfo) {
          await dualWriteSaveChannels([channelToRecord(channelInfo)])
        }
      }
      await dualWriteSaveMessages([messageToRecord(message)])
      log(`Archived message update ${message.id}`)
    } catch (error) {
      log(`Failed to archive message update ${message.id}: ${error instanceof Error ? error.message : 'Unknown'}`)
    }
  })

  client.onMessageDelete(async (channelId: string, messageId: string) => {
    try {
      await dualWriteRecordDeleteEvent(messageId)
      log(`Recorded delete event for message ${messageId} in archive`)
    } catch (error) {
      log(`Failed to record delete event for message ${messageId}: ${error instanceof Error ? error.message : 'Unknown'}`)
    }
  })
}


async function main(): Promise<void> {
  log('\nDiscord Archive Service - Frontfill\n')
  if (isArchiveRunning()) {
    log('Archive service is already running.')
    process.exit(0)
  }
  writeLockFile()

  localDb = getClient('archive', 'local')
  remoteDb = getClient('archive', 'remote')

  log('Clearing local archive database for fresh frontfill...')
  await localDb.execute('DROP TABLE IF EXISTS message_events')
  await localDb.execute('DROP TABLE IF EXISTS messages')
  await localDb.execute('DROP TABLE IF EXISTS channel_events')
  await localDb.execute('DROP TABLE IF EXISTS channels')

  log('Initializing local archive database...')
  await initDB(localDb)
  
  log('Connecting to Discord...')
  discordClient = new DiscordPlatformClient()

  const shutdown = async () => {
    log('Shutting down...')
    isRunning = false
    removeLockFile()
    if (discordClient) await discordClient.disconnect()
    closeAllDBs()
    log('Database connections closed.')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  
  try {
    await discordClient.connect()
    log('Connected to Discord!')

    log('Fetching channels & threads...')
    const channels = await discordClient.getChannels()
    await saveChannels(localDb, channels.map(channelToRecord))
    
    await runFrontfillLoop(discordClient, localDb, channels)

    if (isRunning) {
        await syncToRemote(localDb, remoteDb)
    }

    log('Frontfill and sync process complete.')
    log('Setting up real-time archive event handlers...')
    setupArchiveEventHandlers(discordClient)
    log('Archive service now listening for real-time updates...')
    log('Press Ctrl+C to stop.')

    // Keep the service running
    await new Promise(() => {})

  } catch (error) {
    console.error('Fatal error:', error instanceof Error ? error.message : 'Unknown error')
    shutdown()
    process.exit(1)
  }
}

main()