/**
 * Ephemeral database module for multi-platform message archival
 * Stores messages from WhatsApp and other messaging platforms in Turso
 * Separate from the Discord archive database
 */

import { createClient, Client } from '@libsql/client'

// Database client (lazy initialized)
let client: Client | null = null

/**
 * Supported platforms for ephemeral storage
 */
export type EphemeralPlatform = 'whatsapp' | 'telegram' | 'signal' | 'slack' | 'other'

/**
 * Get or create the database client
 */
function getClient(): Client {
  if (client) return client

  const url = process.env.TURSO_EPHEMERAL_DB_URL
  const authToken = process.env.TURSO_EPHEMERAL_AUTH_TOKEN

  if (!url) {
    throw new Error('TURSO_EPHEMERAL_DB_URL environment variable is required')
  }

  client = createClient({
    url,
    authToken,
  })

  return client
}

/**
 * Initialize the database connection and create tables if they don't exist
 */
export async function initEphemeralDB(): Promise<void> {
  const db = getClient()

  // Create channels table with platform support
  await db.execute(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT NOT NULL,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_id TEXT,
      parent_name TEXT,
      topic TEXT,
      type TEXT,
      first_seen TEXT NOT NULL,
      metadata TEXT,
      PRIMARY KEY (id, platform)
    )
  `)

  // Create messages table with platform support
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT NOT NULL,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT,
      timestamp TEXT NOT NULL,
      edited_timestamp TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      message_type TEXT,
      attachments TEXT,
      reactions TEXT,
      reply_to_id TEXT,
      reply_to_content TEXT,
      reply_to_author TEXT,
      metadata TEXT,
      PRIMARY KEY (id, platform)
    )
  `)

  // Create indexes
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_platform ON messages(platform)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(platform, channel_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(platform, timestamp)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp ON messages(platform, channel_id, timestamp)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_channels_platform ON channels(platform)`)
}

/**
 * Close the database connection
 */
export function closeEphemeralDB(): void {
  if (client) {
    client.close()
    client = null
  }
}

/**
 * Channel data for saving
 */
export interface EphemeralChannelRecord {
  id: string
  platform: EphemeralPlatform
  name: string
  parentId?: string
  parentName?: string
  topic?: string
  type?: string
  metadata?: Record<string, any>
}

/**
 * Message data for saving
 */
export interface EphemeralMessageRecord {
  id: string
  platform: EphemeralPlatform
  channelId: string
  authorId: string
  authorName: string
  content: string
  timestamp: string
  editedTimestamp?: string
  isBot: boolean
  messageType?: string
  attachments?: Array<{ id: string; name: string; url: string; size?: number; contentType?: string }>
  reactions?: Array<{ emoji: string; count: number; name?: string }>
  replyToId?: string
  replyToContent?: string
  replyToAuthor?: string
  metadata?: Record<string, any>
}

/**
 * Save or update a channel in the database
 */
export async function saveEphemeralChannel(channel: EphemeralChannelRecord): Promise<void> {
  const db = getClient()
  await db.execute({
    sql: `
      INSERT INTO channels (id, platform, name, parent_id, parent_name, topic, type, first_seen, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, platform) DO UPDATE SET
        name = excluded.name,
        parent_id = COALESCE(excluded.parent_id, parent_id),
        parent_name = COALESCE(excluded.parent_name, parent_name),
        topic = COALESCE(excluded.topic, topic),
        type = COALESCE(excluded.type, type),
        metadata = COALESCE(excluded.metadata, metadata)
    `,
    args: [
      channel.id,
      channel.platform,
      channel.name,
      channel.parentId || null,
      channel.parentName || null,
      channel.topic || null,
      channel.type || null,
      new Date().toISOString(),
      channel.metadata ? JSON.stringify(channel.metadata) : null,
    ],
  })
}

/**
 * Save or update a message in the database
 */
export async function saveEphemeralMessage(msg: EphemeralMessageRecord): Promise<void> {
  const db = getClient()
  await db.execute({
    sql: `
      INSERT INTO messages (id, platform, channel_id, author_id, author_name, content, timestamp, edited_timestamp, is_bot, message_type, attachments, reactions, reply_to_id, reply_to_content, reply_to_author, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, platform) DO UPDATE SET
        content = excluded.content,
        edited_timestamp = excluded.edited_timestamp,
        reactions = excluded.reactions,
        metadata = excluded.metadata
    `,
    args: [
      msg.id,
      msg.platform,
      msg.channelId,
      msg.authorId,
      msg.authorName,
      msg.content,
      msg.timestamp,
      msg.editedTimestamp || null,
      msg.isBot ? 1 : 0,
      msg.messageType || null,
      msg.attachments ? JSON.stringify(msg.attachments) : null,
      msg.reactions ? JSON.stringify(msg.reactions) : null,
      msg.replyToId || null,
      msg.replyToContent || null,
      msg.replyToAuthor || null,
      msg.metadata ? JSON.stringify(msg.metadata) : null,
    ],
  })
}

/**
 * Save multiple messages in a batch
 */
export async function saveEphemeralMessages(messages: EphemeralMessageRecord[]): Promise<void> {
  if (messages.length === 0) return

  const db = getClient()
  const statements = messages.map((msg) => ({
    sql: `
      INSERT INTO messages (id, platform, channel_id, author_id, author_name, content, timestamp, edited_timestamp, is_bot, message_type, attachments, reactions, reply_to_id, reply_to_content, reply_to_author, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, platform) DO UPDATE SET
        content = excluded.content,
        edited_timestamp = excluded.edited_timestamp,
        reactions = excluded.reactions,
        metadata = excluded.metadata
    `,
    args: [
      msg.id,
      msg.platform,
      msg.channelId,
      msg.authorId,
      msg.authorName,
      msg.content,
      msg.timestamp,
      msg.editedTimestamp || null,
      msg.isBot ? 1 : 0,
      msg.messageType || null,
      msg.attachments ? JSON.stringify(msg.attachments) : null,
      msg.reactions ? JSON.stringify(msg.reactions) : null,
      msg.replyToId || null,
      msg.replyToContent || null,
      msg.replyToAuthor || null,
      msg.metadata ? JSON.stringify(msg.metadata) : null,
    ],
  }))

  await db.batch(statements, 'write')
}

/**
 * Delete a message from the database
 */
export async function deleteEphemeralMessage(platform: EphemeralPlatform, messageId: string): Promise<boolean> {
  const db = getClient()
  const result = await db.execute({
    sql: `DELETE FROM messages WHERE platform = ? AND id = ?`,
    args: [platform, messageId],
  })
  return result.rowsAffected > 0
}

/**
 * Check if a message exists in the database
 */
export async function ephemeralMessageExists(platform: EphemeralPlatform, messageId: string): Promise<boolean> {
  const db = getClient()
  const result = await db.execute({
    sql: `SELECT 1 FROM messages WHERE platform = ? AND id = ? LIMIT 1`,
    args: [platform, messageId],
  })
  return result.rows.length > 0
}

/**
 * Check if a channel exists in the database
 */
export async function ephemeralChannelExists(platform: EphemeralPlatform, channelId: string): Promise<boolean> {
  const db = getClient()
  const result = await db.execute({
    sql: `SELECT 1 FROM channels WHERE platform = ? AND id = ? LIMIT 1`,
    args: [platform, channelId],
  })
  return result.rows.length > 0
}

/**
 * Ensure a channel exists in the database (creates a minimal record if missing)
 */
export async function ensureEphemeralChannelExists(
  platform: EphemeralPlatform,
  channelId: string,
  channelName?: string
): Promise<void> {
  const db = getClient()
  await db.execute({
    sql: `
      INSERT INTO channels (id, platform, name, first_seen)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id, platform) DO NOTHING
    `,
    args: [channelId, platform, channelName || `channel-${channelId}`, new Date().toISOString()],
  })
}

/**
 * Get recent messages for a channel from the database
 */
export async function getEphemeralMessages(
  platform: EphemeralPlatform,
  channelId: string,
  limit = 50
): Promise<EphemeralMessageRecord[]> {
  const db = getClient()
  const result = await db.execute({
    sql: `
      SELECT
        id, platform, channel_id as channelId, author_id as authorId, author_name as authorName,
        content, timestamp, edited_timestamp as editedTimestamp, is_bot as isBot,
        message_type as messageType, attachments, reactions,
        reply_to_id as replyToId, reply_to_content as replyToContent, reply_to_author as replyToAuthor,
        metadata
      FROM messages
      WHERE platform = ? AND channel_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `,
    args: [platform, channelId, limit],
  })

  return result.rows.map((row) => ({
    id: row.id as string,
    platform: row.platform as EphemeralPlatform,
    channelId: row.channelId as string,
    authorId: row.authorId as string,
    authorName: row.authorName as string,
    content: row.content as string,
    timestamp: row.timestamp as string,
    editedTimestamp: (row.editedTimestamp as string) || undefined,
    isBot: row.isBot === 1,
    messageType: (row.messageType as string) || undefined,
    attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
    reactions: row.reactions ? JSON.parse(row.reactions as string) : undefined,
    replyToId: (row.replyToId as string) || undefined,
    replyToContent: (row.replyToContent as string) || undefined,
    replyToAuthor: (row.replyToAuthor as string) || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  }))
}

/**
 * Get messages since a specific timestamp
 */
export async function getEphemeralMessagesSince(
  platform: EphemeralPlatform,
  channelId: string,
  sinceTimestamp: string,
  excludeAuthorId?: string
): Promise<EphemeralMessageRecord[]> {
  const db = getClient()
  let sql = `
    SELECT
      id, platform, channel_id as channelId, author_id as authorId, author_name as authorName,
      content, timestamp, edited_timestamp as editedTimestamp, is_bot as isBot,
      message_type as messageType, attachments, reactions,
      reply_to_id as replyToId, reply_to_content as replyToContent, reply_to_author as replyToAuthor,
      metadata
    FROM messages
    WHERE platform = ? AND channel_id = ? AND timestamp > ?
  `
  const args: (string | number)[] = [platform, channelId, sinceTimestamp]

  if (excludeAuthorId) {
    sql += ` AND author_id != ?`
    args.push(excludeAuthorId)
  }

  sql += ` ORDER BY timestamp ASC`

  const result = await db.execute({ sql, args })

  return result.rows.map((row) => ({
    id: row.id as string,
    platform: row.platform as EphemeralPlatform,
    channelId: row.channelId as string,
    authorId: row.authorId as string,
    authorName: row.authorName as string,
    content: row.content as string,
    timestamp: row.timestamp as string,
    editedTimestamp: (row.editedTimestamp as string) || undefined,
    isBot: row.isBot === 1,
    messageType: (row.messageType as string) || undefined,
    attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
    reactions: row.reactions ? JSON.parse(row.reactions as string) : undefined,
    replyToId: (row.replyToId as string) || undefined,
    replyToContent: (row.replyToContent as string) || undefined,
    replyToAuthor: (row.replyToAuthor as string) || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  }))
}

/**
 * Get total stats for a platform
 */
export async function getEphemeralStats(platform: EphemeralPlatform): Promise<{
  totalMessages: number
  totalChannels: number
  oldestMessageDate: string | null
  newestMessageDate: string | null
}> {
  const db = getClient()

  const msgResult = await db.execute({
    sql: `
      SELECT
        COUNT(*) as totalMessages,
        MIN(timestamp) as oldestMessageDate,
        MAX(timestamp) as newestMessageDate
      FROM messages
      WHERE platform = ?
    `,
    args: [platform],
  })

  const channelResult = await db.execute({
    sql: `SELECT COUNT(*) as totalChannels FROM channels WHERE platform = ?`,
    args: [platform],
  })

  const msgStats = msgResult.rows[0]
  const channelStats = channelResult.rows[0]

  return {
    totalMessages: Number(msgStats.totalMessages),
    totalChannels: Number(channelStats.totalChannels),
    oldestMessageDate: msgStats.oldestMessageDate as string | null,
    newestMessageDate: msgStats.newestMessageDate as string | null,
  }
}

/**
 * Get all channels for a platform
 */
export async function getEphemeralChannels(platform: EphemeralPlatform): Promise<EphemeralChannelRecord[]> {
  const db = getClient()
  const result = await db.execute({
    sql: `
      SELECT id, platform, name, parent_id as parentId, parent_name as parentName, topic, type, metadata
      FROM channels
      WHERE platform = ?
    `,
    args: [platform],
  })

  return result.rows.map((row) => ({
    id: row.id as string,
    platform: row.platform as EphemeralPlatform,
    name: row.name as string,
    parentId: (row.parentId as string) || undefined,
    parentName: (row.parentName as string) || undefined,
    topic: (row.topic as string) || undefined,
    type: (row.type as string) || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  }))
}

/**
 * Search messages by content
 */
export async function searchEphemeralMessages(
  platform: EphemeralPlatform,
  query: string,
  options: { channelId?: string; limit?: number } = {}
): Promise<EphemeralMessageRecord[]> {
  const db = getClient()
  const { channelId, limit = 50 } = options

  let sql = `
    SELECT
      id, platform, channel_id as channelId, author_id as authorId, author_name as authorName,
      content, timestamp, edited_timestamp as editedTimestamp, is_bot as isBot,
      message_type as messageType, attachments, reactions,
      reply_to_id as replyToId, reply_to_content as replyToContent, reply_to_author as replyToAuthor,
      metadata
    FROM messages
    WHERE platform = ? AND content LIKE ?
  `
  const args: (string | number)[] = [platform, `%${query}%`]

  if (channelId) {
    sql += ` AND channel_id = ?`
    args.push(channelId)
  }

  sql += ` ORDER BY timestamp DESC LIMIT ?`
  args.push(limit)

  const result = await db.execute({ sql, args })

  return result.rows.map((row) => ({
    id: row.id as string,
    platform: row.platform as EphemeralPlatform,
    channelId: row.channelId as string,
    authorId: row.authorId as string,
    authorName: row.authorName as string,
    content: row.content as string,
    timestamp: row.timestamp as string,
    editedTimestamp: (row.editedTimestamp as string) || undefined,
    isBot: row.isBot === 1,
    messageType: (row.messageType as string) || undefined,
    attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
    reactions: row.reactions ? JSON.parse(row.reactions as string) : undefined,
    replyToId: (row.replyToId as string) || undefined,
    replyToContent: (row.replyToContent as string) || undefined,
    replyToAuthor: (row.replyToAuthor as string) || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  }))
}

/**
 * Get database URL (for display purposes)
 */
export function getEphemeralDBPath(): string {
  return process.env.TURSO_EPHEMERAL_DB_URL || '(not configured)'
}
