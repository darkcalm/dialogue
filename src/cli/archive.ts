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
const FRONTFILL_BATCH_SIZE = 5

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

async function runFrontfillLoop(discordClient: DiscordPlatformClient, localDb: Client, channels: IPlatformChannel[]): Promise<void> {
  const stats = await getChannelStats(localDb)
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

  while (isRunning && activeChannels.size > 0) {
    const channelsToProcess = Array.from(activeChannels).slice(0, FRONTFILL_BATCH_SIZE)
    log(`Frontfilling ${channelsToProcess.length} channels...`)

    const fetchResults = await Promise.allSettled(
      channelsToProcess.map(async (channelId) => {
        const channel = channelMap.get(channelId)
        if (!channel) return { channelId, messages: [], hasMore: false }
        
        const status = await getChannelBackfillStatus(localDb, channel.id)
        if (status?.oldestFetchedId === 'COMPLETE') return { channelId, messages: [], hasMore: false }
        
        const oldestId = await getOldestMessageId(localDb, channel.id)
        
        try {
          const messages = oldestId
            ? await discordClient.getMessagesBefore(channel.id, oldestId, FETCH_BATCH_SIZE)
            : await discordClient.getMessages(channel.id, FETCH_BATCH_SIZE)
          
          if (messages.length === 0) {
            await updateChannelOldestFetched(localDb, channel.id, 'COMPLETE')
            log(`  ✓ #${channel.name}: Frontfill complete`)
            return { channelId, messages: [], hasMore: false }
          }
          
          const existenceChecks = await Promise.all(messages.map(msg => messageExists(localDb, msg.id)))
          if (existenceChecks.every(exists => exists)) {
            await updateChannelOldestFetched(localDb, channel.id, 'COMPLETE')
            log(`  ✓ #${channel.name}: Frontfill complete (caught up to existing messages)`)
            return { channelId, messages: [], hasMore: false }
          }

          return { channelId, messages, hasMore: messages.length === FETCH_BATCH_SIZE }
        } catch (error) {
          log(`  ✗ #${channel.name}: ${error instanceof Error ? error.message : 'Unknown'}`)
          return { channelId, messages: [], hasMore: false }
        }
      })
    )
    
    let batchMadeProgress = false
    for (const result of fetchResults) {
        if (result.status === 'fulfilled' && result.value) {
            const { channelId, messages, hasMore } = result.value
            if (!hasMore) activeChannels.delete(channelId)
            if (messages.length > 0) {
                batchMadeProgress = true
                await saveMessages(localDb, messages.map(messageToRecord))
                log(`  💾 Saved ${messages.length} messages for channel ${channelId}`)
            }
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
        // This function would need to be added to db.ts
        // const currentStats = await getTotalStats(localDb)
        // log(`Progress: ${currentStats.totalMessages} messages, ${activeChannels.size} channels remaining`)
    }
    
    if (isRunning && activeChannels.size > 0) await sleep(2000)
  }
}

async function syncToRemote(localDb: Client, remoteDb: Client) {
    log('🚀 Starting batch sync from local archive to remote Turso archive...')
    
    await initDB(remoteDb)
    
    const channels = (await localDb.execute("SELECT * FROM channels")).rows
    const messages = (await localDb.execute("SELECT * FROM messages")).rows

    log(`Syncing ${channels.length} channels and ${messages.length} messages...`)
    
    if (channels.length > 0) {
        await saveChannels(remoteDb, channels.map(rowToChannelRecord))
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

    log('✅ Batch sync complete.')
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

    log('Fetching channel list...')
    const channels = await discordClient.getChannels()
    await saveChannels(localDb, channels.map(channelToRecord))
    
    await runFrontfillLoop(discordClient, localDb, channels)

    if (isRunning) {
        await syncToRemote(localDb, remoteDb)
    }

    log('Frontfill and sync process complete.')
    shutdown()

  } catch (error) {
    console.error('Fatal error:', error instanceof Error ? error.message : 'Unknown error')
    shutdown()
    process.exit(1)
  }
}

main()