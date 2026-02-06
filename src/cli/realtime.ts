/**
 * Background service for real-time Discord message events.
 * This service ONLY listens for new messages, edits, and deletions.
 * It does not perform any historical backfill.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { DiscordPlatformClient } from '@/platforms/discord/client'
import { IPlatformMessage } from '@/platforms/types'
import {
  initDB,
  closeDB,
  saveChannel,
  saveMessage,
  deleteMessage,
  channelExists,
  ensureChannelExists,
  ChannelRecord,
  MessageRecord,
  enableDualWriteMode,
} from './db'
import { initDBWithCache, hasLocalCache } from './local-cache'

// Lock file to indicate realtime service is running
const REALTIME_LOCK_FILE = path.join(os.homedir(), '.dialogue-realtime.lock')
const REALTIME_LOG_FILE = path.join(os.homedir(), '.dialogue-realtime.log')

// State
let isRunning = true
let client: DiscordPlatformClient | null = null

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
    fs.appendFileSync(REALTIME_LOG_FILE, logLine + '
')
  } catch {
    // Ignore file write errors
  }
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
function channelToRecord(ch: any): ChannelRecord {
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
 * Handle real-time message events
 */
function setupRealtimeHandlers(client: DiscordPlatformClient): void {
  client.onMessage(async (message: IPlatformMessage) => {
    try {
      if (!(await channelExists(message.channelId))) {
        const channelInfo = await client.getChannel(message.channelId)
        if (channelInfo) {
          await saveChannel(channelToRecord(channelInfo))
          log(`Discovered new channel #${channelInfo.name}`)
        } else {
          await ensureChannelExists(message.channelId)
        }
      }
      const record = messageToRecord(message)
      await saveMessage(record)
      log(`Saved message from ${message.author} in channel ${message.channelId}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Failed to save message ${message.id}: ${errorMessage}`)
    }
  })

  client.onMessageUpdate(async (message: IPlatformMessage) => {
    try {
      if (!(await channelExists(message.channelId))) {
        const channelInfo = await client.getChannel(message.channelId)
        if (channelInfo) {
          await saveChannel(channelToRecord(channelInfo))
        } else {
          await ensureChannelExists(message.channelId)
        }
      }
      const record = messageToRecord(message)
      await saveMessage(record)
      log(`Updated message ${message.id}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Failed to update message ${message.id}: ${errorMessage}`)
    }
  })

  client.onMessageDelete(async (channelId: string, messageId: string) => {
    try {
      const deleted = await deleteMessage(messageId)
      if (deleted) {
        log(`Deleted message ${messageId} from channel ${channelId}`)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Failed to delete message ${messageId}: ${errorMessage}`)
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
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('
Discord Real-time Event Service
')

  if (isRealtimeRunning()) {
    console.log('Real-time service is already running.')
    process.exit(0)
  }

  writeLockFile()

  try {
    fs.writeFileSync(REALTIME_LOG_FILE, '')
  } catch {
    // Ignore errors
  }

  log('Initializing database...')
  await initDB()

  log('Initializing local cache for dual-write...')
  if (!hasLocalCache()) {
    await initDBWithCache({ forceSync: true })
  } else {
    await initDBWithCache()
  }
  enableDualWriteMode()
  log('Dual-write enabled.')

  setupShutdownHandlers()

  log('Connecting to Discord...')
  client = new DiscordPlatformClient()

  try {
    await client.connect()
    log('Connected to Discord!')

    log('Setting up real-time message handlers...')
    setupRealtimeHandlers(client)
    log('Real-time handlers active')

    const user = client.getCurrentUser()
    if (user) {
      log(`Logged in as ${user.username}`)
    }

    log('Listening for real-time updates...')
    log('Press Ctrl+C to stop.')

    await new Promise(() => {})
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('Fatal error:', errorMessage)
    closeDB()
    process.exit(1)
  }
}

main()
