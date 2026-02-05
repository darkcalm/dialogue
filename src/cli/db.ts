/**
 * Turso database module for message archival
 * Stores Discord messages in cloud SQLite (libSQL)
 *
 * Dual-write architecture for resilience:
 * - Archive service writes to BOTH Turso (remote) and local cache
 * - If one write fails, the other still succeeds (logged but not fatal)
 * - Bot service periodically syncs local cache from Turso as fallback
 * - Inbox reads from local cache for fast performance
 */

import { createClient, Client } from '@libsql/client'
import { getCacheClient, hasLocalCache } from './local-cache'

// Database clients (lazy initialized)
let client: Client | null = null // Turso remote client
let cacheClient: Client | null = null // Local cache client
let useLocalCache = false
let useDualWrite = false // Write to both Turso and local cache

/**
 * Get or create the database client
 */
function getClient(): Client {
  // If local cache mode is enabled and cache exists, use it
  if (useLocalCache && hasLocalCache()) {
    return getCacheClient()
  }

  if (client) return client

  const url = process.env.TURSO_DB_URL
  const authToken = process.env.TURSO_AUTH_TOKEN

  if (!url) {
    throw new Error('TURSO_DB_URL environment variable is required')
  }

  client = createClient({
    url,
    authToken,
  })

  return client
}

/**
 * Enable local cache mode for reads and writes
 * Writes go to local cache which syncs to Turso via embedded replica
 */
export function enableLocalCacheMode(): void {
  useLocalCache = true
}

/**
 * Disable local cache mode (use remote directly)
 */
export function disableLocalCacheMode(): void {
  useLocalCache = false
}

/**
 * Enable dual-write mode - writes go to both Turso and local cache
 * Provides resilience if one service is down
 */
export function enableDualWriteMode(): void {
  useDualWrite = true
  // Ensure both clients are available
  if (!client) {
    const url = process.env.TURSO_DB_URL
    const authToken = process.env.TURSO_AUTH_TOKEN
    if (url) {
      client = createClient({ url, authToken })
    }
  }
  if (!cacheClient && hasLocalCache()) {
    cacheClient = getCacheClient()
  }
}

/**
 * Execute a statement on both Turso and local cache (dual-write)
 * If one fails, still try the other and log error
 */
async function executeDualWrite(statement: any): Promise<void> {
  const errors: string[] = []

  // Try writing to Turso
  if (client) {
    try {
      await client.execute(statement)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      errors.push(`Turso write failed: ${msg}`)
      console.error(`⚠️  Turso write failed: ${msg}`)
    }
  }

  // Try writing to local cache
  if (cacheClient) {
    try {
      await cacheClient.execute(statement)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      errors.push(`Local cache write failed: ${msg}`)
      console.error(`⚠️  Local cache write failed: ${msg}`)
    }
  }

  // If both failed, throw error
  if (errors.length === 2) {
    throw new Error(`Dual write failed: ${errors.join('; ')}`)
  }
}

/**
 * Execute batch statements on both Turso and local cache (dual-write)
 */
async function executeBatchDualWrite(statements: any[]): Promise<void> {
  const errors: string[] = []

  // Try writing to Turso
  if (client) {
    try {
      await client.batch(statements)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      errors.push(`Turso batch write failed: ${msg}`)
      console.error(`⚠️  Turso batch write failed: ${msg}`)
    }
  }

  // Try writing to local cache
  if (cacheClient) {
    try {
      await cacheClient.batch(statements)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      errors.push(`Local cache batch write failed: ${msg}`)
      console.error(`⚠️  Local cache batch write failed: ${msg}`)
    }
  }

  // If both failed, throw error
  if (errors.length === 2) {
    throw new Error(`Dual batch write failed: ${errors.join('; ')}`)
  }
}

/**
 * Initialize the database connection and create tables if they don't exist
 */
export async function initDB(): Promise<void> {
  const db = getClient()

  // Create tables
  await db.execute(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      guild_id TEXT,
      guild_name TEXT,
      parent_id TEXT,
      topic TEXT,
      type TEXT,
      first_seen TEXT NOT NULL,
      oldest_fetched_id TEXT
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT,
      timestamp TEXT NOT NULL,
      edited_timestamp TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      message_type TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      attachments TEXT,
      embeds TEXT,
      stickers TEXT,
      reactions TEXT,
      reply_to_id TEXT,
      thread_id TEXT,
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    )
  `)

  // Create indexes
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp ON messages(channel_id, timestamp)`)
}

/**
 * Close the database connection
 */
export function closeDB(): void {
  if (client) {
    client.close()
    client = null
  }
}

/**
 * Channel data for saving
 */
export interface ChannelRecord {
  id: string
  name: string
  guildId?: string
  guildName?: string
  parentId?: string
  topic?: string
  type?: string
}

/**
 * Save or update a channel in the database
 */
export async function saveChannel(channel: ChannelRecord): Promise<void> {
  const statement = {
    sql: `
      INSERT INTO channels (id, name, guild_id, guild_name, parent_id, topic, type, first_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        guild_id = COALESCE(excluded.guild_id, guild_id),
        guild_name = COALESCE(excluded.guild_name, guild_name),
        parent_id = COALESCE(excluded.parent_id, parent_id),
        topic = COALESCE(excluded.topic, topic),
        type = COALESCE(excluded.type, type)
    `,
    args: [
      channel.id,
      channel.name,
      channel.guildId || null,
      channel.guildName || null,
      channel.parentId || null,
      channel.topic || null,
      channel.type || null,
      new Date().toISOString(),
    ],
  }

  if (useDualWrite) {
    await executeDualWrite(statement)
  } else {
    const db = getClient()
    await db.execute(statement)
  }
}

/**
 * Message data for saving
 */
export interface MessageRecord {
  id: string
  channelId: string
  authorId: string
  authorName: string
  content: string
  timestamp: string
  editedTimestamp?: string
  isBot: boolean
  messageType?: string
  pinned?: boolean
  attachments?: Array<{ id: string; name: string; url: string; size: number; contentType?: string }>
  embeds?: Array<{
    type?: string
    title?: string
    description?: string
    url?: string
    color?: number
    timestamp?: string
    footer?: { text: string }
    image?: { url: string }
    thumbnail?: { url: string }
    author?: { name: string; url?: string }
    fields?: Array<{ name: string; value: string; inline?: boolean }>
  }>
  stickers?: Array<{ id: string; name: string; formatType: number }>
  reactions?: Array<{ emoji: string; count: number; name: string; users: string[] }>
  replyToId?: string
  threadId?: string
}

/**
 * Save or update a message in the database
 */
export async function saveMessage(msg: MessageRecord): Promise<void> {
  const statement = {
    sql: `
      INSERT INTO messages (id, channel_id, author_id, author_name, content, timestamp, edited_timestamp, is_bot, message_type, pinned, attachments, embeds, stickers, reactions, reply_to_id, thread_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        edited_timestamp = excluded.edited_timestamp,
        pinned = excluded.pinned,
        embeds = excluded.embeds,
        reactions = excluded.reactions
    `,
    args: [
      msg.id,
      msg.channelId,
      msg.authorId,
      msg.authorName,
      msg.content,
      msg.timestamp,
      msg.editedTimestamp || null,
      msg.isBot ? 1 : 0,
      msg.messageType || null,
      msg.pinned ? 1 : 0,
      msg.attachments ? JSON.stringify(msg.attachments) : null,
      msg.embeds ? JSON.stringify(msg.embeds) : null,
      msg.stickers ? JSON.stringify(msg.stickers) : null,
      msg.reactions ? JSON.stringify(msg.reactions) : null,
      msg.replyToId || null,
      msg.threadId || null,
    ],
  }

  if (useDualWrite) {
    await executeDualWrite(statement)
  } else {
    const db = getClient()
    await db.execute(statement)
  }
}

/**
 * Save multiple messages in a batch
 */
export async function saveMessages(messages: MessageRecord[]): Promise<void> {
  if (messages.length === 0) return

  const statements = messages.map((msg) => ({
    sql: `
      INSERT INTO messages (id, channel_id, author_id, author_name, content, timestamp, edited_timestamp, is_bot, message_type, pinned, attachments, embeds, stickers, reactions, reply_to_id, thread_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        edited_timestamp = excluded.edited_timestamp,
        pinned = excluded.pinned,
        embeds = excluded.embeds,
        reactions = excluded.reactions
    `,
    args: [
      msg.id,
      msg.channelId,
      msg.authorId,
      msg.authorName,
      msg.content,
      msg.timestamp,
      msg.editedTimestamp || null,
      msg.isBot ? 1 : 0,
      msg.messageType || null,
      msg.pinned ? 1 : 0,
      msg.attachments ? JSON.stringify(msg.attachments) : null,
      msg.embeds ? JSON.stringify(msg.embeds) : null,
      msg.stickers ? JSON.stringify(msg.stickers) : null,
      msg.reactions ? JSON.stringify(msg.reactions) : null,
      msg.replyToId || null,
      msg.threadId || null,
    ],
  }))

  if (useDualWrite) {
    await executeBatchDualWrite(statements)
  } else {
    const db = getClient()
    await db.batch(statements, 'write')
  }
}

/**
 * Get the oldest message ID for a channel (for backfill pagination)
 */
export async function getOldestMessageId(channelId: string): Promise<string | null> {
  const db = getClient()
  const result = await db.execute({
    sql: `SELECT id FROM messages WHERE channel_id = ? ORDER BY timestamp ASC LIMIT 1`,
    args: [channelId],
  })
  return (result.rows[0]?.id as string) || null
}

/**
 * Get the newest message ID for a channel (for catch-up on restart)
 */
export async function getNewestMessageId(channelId: string): Promise<string | null> {
  const db = getClient()
  const result = await db.execute({
    sql: `SELECT id FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT 1`,
    args: [channelId],
  })
  return (result.rows[0]?.id as string) || null
}

/**
 * Get channels that have messages (for catch-up on restart)
 */
export async function getChannelsWithMessages(): Promise<string[]> {
  const db = getClient()
  const result = await db.execute(`SELECT DISTINCT channel_id FROM messages`)
  return result.rows.map((r) => r.channel_id as string)
}

/**
 * Update the oldest fetched message ID for a channel
 */
export async function updateChannelOldestFetched(channelId: string, messageId: string | null): Promise<void> {
  const db = getClient()
  await db.execute({
    sql: `UPDATE channels SET oldest_fetched_id = ? WHERE id = ?`,
    args: [messageId, channelId],
  })
}

/**
 * Get channel backfill status
 */
export async function getChannelBackfillStatus(
  channelId: string
): Promise<{ oldestFetchedId: string | null } | null> {
  const db = getClient()
  const result = await db.execute({
    sql: `SELECT oldest_fetched_id FROM channels WHERE id = ?`,
    args: [channelId],
  })
  if (!result.rows[0]) return null
  return { oldestFetchedId: result.rows[0].oldest_fetched_id as string | null }
}

/**
 * Statistics per channel
 */
export interface ChannelStats {
  id: string
  name: string
  guildName: string | null
  messageCount: number
  oldestMessageDate: string | null
  newestMessageDate: string | null
  backfillComplete: boolean
  type: string | null
  parentId: string | null
}

/**
 * Get message statistics per channel
 */
export async function getChannelStats(): Promise<ChannelStats[]> {
  const db = getClient()
  const result = await db.execute(`
    SELECT
      c.id,
      c.name,
      c.guild_name as guildName,
      c.oldest_fetched_id,
      c.type,
      c.parent_id as parentId,
      COUNT(m.id) as messageCount,
      MIN(m.timestamp) as oldestMessageDate,
      MAX(m.timestamp) as newestMessageDate
    FROM channels c
    LEFT JOIN messages m ON c.id = m.channel_id
    GROUP BY c.id
    ORDER BY messageCount DESC
  `)

  return result.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    guildName: row.guildName as string | null,
    messageCount: Number(row.messageCount),
    oldestMessageDate: row.oldestMessageDate as string | null,
    newestMessageDate: row.newestMessageDate as string | null,
    backfillComplete: row.oldest_fetched_id === 'COMPLETE',
    type: row.type as string | null,
    parentId: row.parentId as string | null,
  }))
}

/**
 * Overall statistics
 */
export interface TotalStats {
  totalMessages: number
  totalChannels: number
  oldestMessageDate: string | null
  newestMessageDate: string | null
  channelsComplete: number
  channelsInProgress: number
}

/**
 * Get overall statistics
 */
export async function getTotalStats(): Promise<TotalStats> {
  const db = getClient()

  const msgResult = await db.execute(`
    SELECT
      COUNT(*) as totalMessages,
      MIN(timestamp) as oldestMessageDate,
      MAX(timestamp) as newestMessageDate
    FROM messages
  `)

  const channelResult = await db.execute(`
    SELECT
      COUNT(*) as totalChannels,
      SUM(CASE WHEN oldest_fetched_id = 'COMPLETE' THEN 1 ELSE 0 END) as channelsComplete
    FROM channels
  `)

  const msgStats = msgResult.rows[0]
  const channelStats = channelResult.rows[0]

  return {
    totalMessages: Number(msgStats.totalMessages),
    totalChannels: Number(channelStats.totalChannels),
    oldestMessageDate: msgStats.oldestMessageDate as string | null,
    newestMessageDate: msgStats.newestMessageDate as string | null,
    channelsComplete: Number(channelStats.channelsComplete) || 0,
    channelsInProgress: Number(channelStats.totalChannels) - (Number(channelStats.channelsComplete) || 0),
  }
}

/**
 * Check if a message exists in the database
 */
export async function messageExists(messageId: string): Promise<boolean> {
  const db = getClient()
  const result = await db.execute({
    sql: `SELECT 1 FROM messages WHERE id = ? LIMIT 1`,
    args: [messageId],
  })
  return result.rows.length > 0
}

/**
 * Check if a channel exists in the database
 */
export async function channelExists(channelId: string): Promise<boolean> {
  const db = getClient()
  const result = await db.execute({
    sql: `SELECT 1 FROM channels WHERE id = ? LIMIT 1`,
    args: [channelId],
  })
  return result.rows.length > 0
}

/**
 * Ensure a channel exists in the database (creates a minimal record if missing)
 * Used before saving real-time messages to satisfy foreign key constraint
 */
export async function ensureChannelExists(channelId: string, channelName?: string): Promise<void> {
  const db = getClient()
  await db.execute({
    sql: `
      INSERT INTO channels (id, name, first_seen)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `,
    args: [channelId, channelName || `channel-${channelId}`, new Date().toISOString()],
  })
}

/**
 * Get database URL (for display purposes)
 */
export function getDBPath(): string {
  return process.env.TURSO_DB_URL || '(not configured)'
}

/**
 * Get recent messages for a channel from the archive
 */
export async function getMessagesFromArchive(channelId: string, limit = 20): Promise<MessageRecord[]> {
  const db = getClient()
  const result = await db.execute({
    sql: `
      SELECT
        id,
        channel_id as channelId,
        author_id as authorId,
        author_name as authorName,
        content,
        timestamp,
        is_bot as isBot,
        attachments,
        reactions,
        reply_to_id as replyToId
      FROM messages
      WHERE channel_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `,
    args: [channelId, limit],
  })

  return result.rows.map((row) => ({
    id: row.id as string,
    channelId: row.channelId as string,
    authorId: row.authorId as string,
    authorName: row.authorName as string,
    content: row.content as string,
    timestamp: row.timestamp as string,
    isBot: row.isBot === 1,
    attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
    reactions: row.reactions ? JSON.parse(row.reactions as string) : undefined,
    replyToId: (row.replyToId as string) || undefined,
  }))
}

/**
 * Get messages after a specific timestamp (for detecting new messages)
 */
export async function getMessagesSinceTimestamp(
  channelId: string,
  sinceTimestamp: string,
  excludeAuthorId?: string
): Promise<MessageRecord[]> {
  const db = getClient()
  let sql = `
    SELECT
      id,
      channel_id as channelId,
      author_id as authorId,
      author_name as authorName,
      content,
      timestamp,
      is_bot as isBot,
      attachments,
      reactions,
      reply_to_id as replyToId
    FROM messages
    WHERE channel_id = ? AND timestamp > ?
  `
  const args: (string | number)[] = [channelId, sinceTimestamp]

  if (excludeAuthorId) {
    sql += ` AND author_id != ?`
    args.push(excludeAuthorId)
  }

  sql += ` ORDER BY timestamp DESC`

  const result = await db.execute({ sql, args })

  return result.rows.map((row) => ({
    id: row.id as string,
    channelId: row.channelId as string,
    authorId: row.authorId as string,
    authorName: row.authorName as string,
    content: row.content as string,
    timestamp: row.timestamp as string,
    isBot: row.isBot === 1,
    attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
    reactions: row.reactions ? JSON.parse(row.reactions as string) : undefined,
    replyToId: (row.replyToId as string) || undefined,
  }))
}

/**
 * Get the newest message timestamp for a channel
 */
export async function getNewestMessageTimestamp(channelId: string): Promise<string | null> {
  const db = getClient()
  const result = await db.execute({
    sql: `SELECT timestamp FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT 1`,
    args: [channelId],
  })
  return (result.rows[0]?.timestamp as string) || null
}

/**
 * Get all archived channels
 */
export async function getArchivedChannels(): Promise<ChannelRecord[]> {
  const db = getClient()
  const result = await db.execute(`
    SELECT id, name, guild_id as guildId, guild_name as guildName, parent_id as parentId, topic, type
    FROM channels
  `)
  return result.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    guildId: row.guildId as string | undefined,
    guildName: row.guildName as string | undefined,
    parentId: row.parentId as string | undefined,
    topic: row.topic as string | undefined,
    type: row.type as string | undefined,
  }))
}

/**
 * Check if archive database exists and has data
 */
export async function hasArchiveData(): Promise<boolean> {
  try {
    const db = getClient()
    const result = await db.execute(`SELECT COUNT(*) as count FROM messages`)
    return Number(result.rows[0].count) > 0
  } catch {
    return false
  }
}

/**
 * Get Discord URL for a channel
 */
export async function getChannelUrl(channelId: string): Promise<string | null> {
  const db = getClient()
  const result = await db.execute({
    sql: `SELECT id, guild_id, type FROM channels WHERE id = ?`,
    args: [channelId],
  })
  const row = result.rows[0]
  if (!row) return null

  if (row.type === 'dm') {
    return `https://discord.com/channels/@me/${row.id}`
  }

  if (row.guild_id) {
    return `https://discord.com/channels/${row.guild_id}/${row.id}`
  }

  return null
}

/**
 * Get Discord URL for a message
 */
export async function getMessageUrl(messageId: string): Promise<string | null> {
  const db = getClient()
  const result = await db.execute({
    sql: `
      SELECT m.id, m.channel_id, c.guild_id, c.type
      FROM messages m
      JOIN channels c ON m.channel_id = c.id
      WHERE m.id = ?
    `,
    args: [messageId],
  })
  const row = result.rows[0]
  if (!row) return null

  if (row.type === 'dm') {
    return `https://discord.com/channels/@me/${row.channel_id}/${row.id}`
  }

  if (row.guild_id) {
    return `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.id}`
  }

  return null
}

/**
 * Delete a message from the database
 */
export async function deleteMessage(messageId: string): Promise<boolean> {
  const db = getClient()
  const result = await db.execute({
    sql: `DELETE FROM messages WHERE id = ?`,
    args: [messageId],
  })
  return result.rowsAffected > 0
}

/**
 * Delete messages in a time range for a channel
 * Returns the number of messages deleted
 */
export async function deleteMessagesInTimeRange(
  channelId: string,
  startTime: string,
  endTime: string
): Promise<number> {
  const db = getClient()
  const result = await db.execute({
    sql: `DELETE FROM messages WHERE channel_id = ? AND timestamp >= ? AND timestamp <= ?`,
    args: [channelId, startTime, endTime],
  })
  return result.rowsAffected
}

/**
 * Get message IDs in a time range for a channel (for refill boundary detection)
 */
export async function getMessageIdsInTimeRange(
  channelId: string,
  startTime: string,
  endTime: string
): Promise<{ oldest: string | null; newest: string | null; count: number }> {
  const db = getClient()
  const result = await db.execute({
    sql: `
      SELECT 
        MIN(id) as oldest,
        MAX(id) as newest,
        COUNT(*) as count
      FROM messages 
      WHERE channel_id = ? AND timestamp >= ? AND timestamp <= ?
    `,
    args: [channelId, startTime, endTime],
  })
  const row = result.rows[0]
  return {
    oldest: (row?.oldest as string) || null,
    newest: (row?.newest as string) || null,
    count: Number(row?.count) || 0,
  }
}
