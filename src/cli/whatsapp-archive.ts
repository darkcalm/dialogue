/**
 * WhatsApp archive service
 * Saves messages from WhatsApp history sync and real-time events to ephemeral database
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { WhatsAppPlatformClient } from '@/platforms/whatsapp/client'
import { IPlatformMessage, IPlatformChannel } from '@/platforms/types'
import {
  initEphemeralDB,
  closeEphemeralDB,
  saveEphemeralChannel,
  saveEphemeralMessage,
  saveEphemeralMessages,
  deleteEphemeralMessage,
  ephemeralChannelExists,
  ensureEphemeralChannelExists,
  getEphemeralStats,
  EphemeralMessageRecord,
  EphemeralChannelRecord,
} from './ephemeral-db'

// Lock file to indicate archive is running
const ARCHIVE_LOCK_FILE = path.join(os.homedir(), '.dialogue-whatsapp-archive.lock')

// State
let isRunning = true
let client: WhatsAppPlatformClient | null = null

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
 * Log with timestamp
 */
function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString()
  console.log(`[${timestamp}] ${message}`)
}

/**
 * Convert platform message to ephemeral message record
 */
function messageToRecord(msg: IPlatformMessage): EphemeralMessageRecord {
  return {
    id: msg.id,
    platform: 'whatsapp',
    channelId: msg.channelId,
    authorId: msg.authorId,
    authorName: msg.author,
    content: msg.content,
    timestamp: msg.timestamp,
    editedTimestamp: msg.editedTimestamp,
    isBot: msg.isBot,
    messageType: msg.messageType,
    attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
    reactions: msg.reactions.length > 0 ? msg.reactions : undefined,
    replyToId: msg.replyTo?.messageId,
    replyToContent: msg.replyTo?.content,
    replyToAuthor: msg.replyTo?.author,
    metadata: msg.metadata,
  }
}

/**
 * Convert platform channel to ephemeral channel record
 */
function channelToRecord(ch: IPlatformChannel): EphemeralChannelRecord {
  return {
    id: ch.id,
    platform: 'whatsapp',
    name: ch.name,
    parentId: ch.parentId,
    parentName: ch.parentName,
    topic: ch.topic,
    type: ch.type,
    metadata: ch.metadata,
  }
}

/**
 * Set up real-time message handlers
 */
function setupRealtimeHandlers(client: WhatsAppPlatformClient): void {
  client.onMessage(async (message: IPlatformMessage) => {
    try {
      // Ensure channel exists
      if (!(await ephemeralChannelExists('whatsapp', message.channelId))) {
        await ensureEphemeralChannelExists('whatsapp', message.channelId, message.channelId)
        log(`Real-time: Created channel record for ${message.channelId}`)
      }

      // Save the message
      const record = messageToRecord(message)
      await saveEphemeralMessage(record)
      log(`Real-time: Saved message from ${message.author} in ${message.channelId}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Real-time: Failed to save message ${message.id}: ${errorMessage}`)
    }
  })

  client.onMessageUpdate(async (message: IPlatformMessage) => {
    try {
      // Ensure channel exists
      if (!(await ephemeralChannelExists('whatsapp', message.channelId))) {
        await ensureEphemeralChannelExists('whatsapp', message.channelId, message.channelId)
      }

      // Update the message
      const record = messageToRecord(message)
      await saveEphemeralMessage(record)
      log(`Real-time: Updated message ${message.id}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Real-time: Failed to update message ${message.id}: ${errorMessage}`)
    }
  })

  client.onMessageDelete(async (channelId: string, messageId: string) => {
    try {
      const deleted = await deleteEphemeralMessage('whatsapp', messageId)
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
 * Save initial channels from WhatsApp
 */
async function saveInitialChannels(client: WhatsAppPlatformClient): Promise<void> {
  log('Fetching channels from WhatsApp...')

  try {
    const channels = await client.getChannels()
    log(`Found ${channels.length} channels`)

    for (const channel of channels) {
      await saveEphemeralChannel(channelToRecord(channel))
    }

    log(`Saved ${channels.length} channels to database`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log(`Error fetching channels: ${errorMessage}`)
  }
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
    closeEphemeralDB()
    log('Database closed.')

    // Disconnect from WhatsApp
    if (client) {
      await client.disconnect()
      log('Disconnected from WhatsApp.')
    }

    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('exit', removeLockFile)
}

/**
 * Show archive status and exit
 */
async function showStatus(): Promise<void> {
  await initEphemeralDB()
  const stats = await getEphemeralStats('whatsapp')

  console.log('\nWhatsApp Archive Status\n')
  console.log(`Total messages: ${stats.totalMessages.toLocaleString()}`)
  console.log(`Total channels: ${stats.totalChannels}`)
  if (stats.oldestMessageDate) {
    console.log(`Oldest message: ${new Date(stats.oldestMessageDate).toLocaleString()}`)
  }
  if (stats.newestMessageDate) {
    console.log(`Newest message: ${new Date(stats.newestMessageDate).toLocaleString()}`)
  }
  console.log(`Running: ${isArchiveRunning() ? 'yes (PID ' + fs.readFileSync(ARCHIVE_LOCK_FILE, 'utf-8').trim() + ')' : 'no'}`)

  closeEphemeralDB()
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Handle --status flag
  if (process.argv.includes('--status')) {
    await showStatus()
    process.exit(0)
  }

  console.log('\nWhatsApp Message Archive Service\n')

  // Check if already running
  if (isArchiveRunning()) {
    console.log('WhatsApp archive service is already running. Use --status to see progress.')
    process.exit(0)
  }

  // Write lock file
  writeLockFile()

  // Initialize database
  log('Initializing ephemeral database...')
  await initEphemeralDB()

  // Set up shutdown handlers
  setupShutdownHandlers()

  // Create and connect WhatsApp client
  log('Connecting to WhatsApp...')
  log('You may need to scan a QR code if this is a new session.')
  client = new WhatsAppPlatformClient()

  try {
    await client.connect()
    log('Connected to WhatsApp!')

    const user = client.getCurrentUser()
    if (user) {
      log(`Logged in as ${user.username}`)
    }

    // Save initial channels
    await saveInitialChannels(client)

    // Set up real-time message handling
    log('Setting up real-time message handlers...')
    setupRealtimeHandlers(client)

    // Show current stats
    const stats = await getEphemeralStats('whatsapp')
    log(`Current archive: ${stats.totalMessages} messages in ${stats.totalChannels} channels`)

    // Keep running for real-time updates
    log('Listening for real-time messages...')
    log('Press Ctrl+C to stop.')

    // Keep the process alive
    await new Promise(() => {})
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('Fatal error:', errorMessage)
    closeEphemeralDB()
    process.exit(1)
  }
}

main()
