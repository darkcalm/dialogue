/**
 * Background service for real-time Discord message events.
 * This service ONLY listens for new messages, edits, and deletions.
 * It dual-writes to a local SQLite DB and a remote Turso DB for resilience.
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
  // These will need to be re-implemented with dual-write logic
  // deleteMessage,
  // channelExists,
  // ensureChannelExists,
  ChannelRecord,
  MessageRecord,
} from './db'

// Lock file to indicate realtime service is running
const REALTIME_LOCK_FILE = path.join(os.homedir(), '.dialogue-realtime.lock')
const REALTIME_LOG_FILE = path.join(os.homedir(), '.dialogue-realtime.log')

// State
let isRunning = true
let discordClient: DiscordPlatformClient | null = null
let localDb: Client | null = null
let remoteDb: Client | null = null

/**
 * Write lock file with current PID
 */
function writeLockFile(): void {
  fs.writeFileSync(REALTIME_LOCK_FILE, process.pid.toString(), 'utf-8')
}

/**
 * Remove lock file
 */
function removeLockFile(): void {
  try {
    if (fs.existsSync(REALTIME_LOCK_FILE)) {
      fs.unlinkSync(REALTIME_LOCK_FILE)
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Check if another realtime instance is already running
 */
function isRealtimeRunning(): boolean {
  try {
    if (!fs.existsSync(REALTIME_LOCK_FILE)) return false
    const pid = parseInt(fs.readFileSync(REALTIME_LOCK_FILE, 'utf-8').trim(), 10)
    process.kill(pid, 0)
    return true
  } catch {
    if (fs.existsSync(REALTIME_LOCK_FILE)) {
      fs.unlinkSync(REALTIME_LOCK_FILE)
    }
    return false
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
    fs.appendFileSync(REALTIME_LOG_FILE, logLine + '\n')
  } catch {}
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

// Dual-write implementations
async function dualWriteSaveMessages(records: MessageRecord[]) {
  if (localDb) await saveMessages(localDb, records).catch(err => log(`⚠️ Local DB save failed: ${err.message}`))
  if (remoteDb) await saveMessages(remoteDb, records).catch(err => log(`⚠️ Remote DB save failed: ${err.message}`))
}

async function dualWriteSaveChannels(records: ChannelRecord[]) {
  if (localDb) await saveChannels(localDb, records).catch(err => log(`⚠️ Local DB channel save failed: ${err.message}`))
  if (remoteDb) await saveChannels(remoteDb, records).catch(err => log(`⚠️ Remote DB channel save failed: ${err.message}`))
}

async function dualWriteDeleteMessage(messageId: string) {
  const statement = { sql: `DELETE FROM messages WHERE id = ?`, args: [messageId] }
  if (localDb) await localDb.execute(statement).catch(err => log(`⚠️ Local DB delete failed: ${err.message}`))
  if (remoteDb) await remoteDb.execute(statement).catch(err => log(`⚠️ Remote DB delete failed: ${err.message}`))
}

async function channelExists(channelId: string): Promise<boolean> {
  // Check local first, it's faster
  const db = localDb || remoteDb
  if (!db) return false
  const result = await db.execute({ sql: `SELECT 1 FROM channels WHERE id = ? LIMIT 1`, args: [channelId] })
  return result.rows.length > 0
}

/**
 * Handle real-time message events
 */
function setupRealtimeHandlers(client: DiscordPlatformClient): void {
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
      log(`Saved message from ${message.author} in channel ${message.channelId}`)
    } catch (error) {
      log(`Failed to save message ${message.id}: ${error instanceof Error ? error.message : 'Unknown'}`)
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
      log(`Updated message ${message.id}`)
    } catch (error) {
      log(`Failed to update message ${message.id}: ${error instanceof Error ? error.message : 'Unknown'}`)
    }
  })

  client.onMessageDelete(async (channelId: string, messageId: string) => {
    try {
      await dualWriteDeleteMessage(messageId)
      log(`Deleted message ${messageId} from channel ${channelId}`)
    } catch (error) {
      log(`Failed to delete message ${messageId}: ${error instanceof Error ? error.message : 'Unknown'}`)
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
    removeLockFile()
    if (discordClient) {
      await discordClient.disconnect()
      log('Disconnected from Discord.')
    }
    closeAllDBs()
    log('Database connections closed.')
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
  console.log('\nDiscord Real-time Event Service\n')

  if (isRealtimeRunning()) {
    console.log('Real-time service is already running.')
    process.exit(0)
  }

  writeLockFile()

  try {
    fs.writeFileSync(REALTIME_LOG_FILE, '')
  } catch {}

  log('Initializing databases (clean start)...')
  localDb = getClient('realtime', 'local')
  remoteDb = getClient('realtime', 'remote')
  for (const db of [localDb, remoteDb]) {
    if (!db) continue
    await db.execute('DROP TABLE IF EXISTS messages')
    await db.execute('DROP TABLE IF EXISTS channel_events')
    await db.execute('DROP TABLE IF EXISTS channels')
  }
  await initDB(localDb)
  await initDB(remoteDb)
  log('Databases initialized.')

  setupShutdownHandlers()

  log('Connecting to Discord...')
  discordClient = new DiscordPlatformClient()

  try {
    await discordClient.connect()
    log('Connected to Discord!')

    log('Setting up real-time message handlers...')
    setupRealtimeHandlers(discordClient)
    log('Real-time handlers active')

    const user = discordClient.getCurrentUser()
    if (user) {
      log(`Logged in as ${user.username}`)
    }

    log('Listening for real-time updates...')
    log('Press Ctrl+C to stop.')

    await new Promise(() => {})
  } catch (error) {
    console.error('Fatal error:', error instanceof Error ? error.message : 'Unknown error')
    closeAllDBs()
    process.exit(1)
  }
}

main()