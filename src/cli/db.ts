/**
 * SQLite database module for message archival
 * Stores Discord messages persistently on disk
 */

import Database from 'better-sqlite3'
import * as path from 'path'
import * as os from 'os'

// Database path in user's home directory
const DB_PATH = path.join(os.homedir(), '.dialogue-messages.db')

let db: Database.Database | null = null

/**
 * Initialize the database connection and create tables if they don't exist
 */
export function initDB(): Database.Database {
  if (db) return db

  db = new Database(DB_PATH)

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL')

  // Create tables
  db.exec(`
    -- Channels table
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
    );

    -- Messages table
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
    );

    -- Indexes for efficient querying
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp ON messages(channel_id, timestamp);
  `)

  // Migration: add new columns if they don't exist (for existing databases)
  const addColumnIfNotExists = (table: string, column: string, type: string) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    } catch {
      // Column already exists, ignore
    }
  }

  // Channel migrations
  addColumnIfNotExists('channels', 'guild_id', 'TEXT')
  addColumnIfNotExists('channels', 'parent_id', 'TEXT')
  addColumnIfNotExists('channels', 'topic', 'TEXT')

  // Message migrations
  addColumnIfNotExists('messages', 'edited_timestamp', 'TEXT')
  addColumnIfNotExists('messages', 'message_type', 'TEXT')
  addColumnIfNotExists('messages', 'pinned', 'INTEGER DEFAULT 0')
  addColumnIfNotExists('messages', 'embeds', 'TEXT')
  addColumnIfNotExists('messages', 'stickers', 'TEXT')
  addColumnIfNotExists('messages', 'thread_id', 'TEXT')

  return db
}

/**
 * Get the database instance
 */
export function getDB(): Database.Database {
  if (!db) {
    return initDB()
  }
  return db
}

/**
 * Close the database connection
 */
export function closeDB(): void {
  if (db) {
    db.close()
    db = null
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
export function saveChannel(channel: ChannelRecord): void {
  const database = getDB()
  const stmt = database.prepare(`
    INSERT INTO channels (id, name, guild_id, guild_name, parent_id, topic, type, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      guild_id = COALESCE(excluded.guild_id, guild_id),
      guild_name = COALESCE(excluded.guild_name, guild_name),
      parent_id = COALESCE(excluded.parent_id, parent_id),
      topic = COALESCE(excluded.topic, topic),
      type = COALESCE(excluded.type, type)
  `)
  stmt.run(
    channel.id,
    channel.name,
    channel.guildId || null,
    channel.guildName || null,
    channel.parentId || null,
    channel.topic || null,
    channel.type || null,
    new Date().toISOString()
  )
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
  embeds?: Array<{ type?: string; title?: string; description?: string; url?: string; color?: number; timestamp?: string; footer?: { text: string }; image?: { url: string }; thumbnail?: { url: string }; author?: { name: string; url?: string }; fields?: Array<{ name: string; value: string; inline?: boolean }> }>
  stickers?: Array<{ id: string; name: string; formatType: number }>
  reactions?: Array<{ emoji: string; count: number; name: string; users: string[] }>
  replyToId?: string
  threadId?: string
}

/**
 * Save or update a message in the database
 */
export function saveMessage(msg: MessageRecord): void {
  const database = getDB()
  const stmt = database.prepare(`
    INSERT INTO messages (id, channel_id, author_id, author_name, content, timestamp, edited_timestamp, is_bot, message_type, pinned, attachments, embeds, stickers, reactions, reply_to_id, thread_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      edited_timestamp = excluded.edited_timestamp,
      pinned = excluded.pinned,
      embeds = excluded.embeds,
      reactions = excluded.reactions
  `)
  stmt.run(
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
    msg.threadId || null
  )
}

/**
 * Save multiple messages in a single transaction
 */
export function saveMessages(messages: MessageRecord[]): void {
  const database = getDB()
  const stmt = database.prepare(`
    INSERT INTO messages (id, channel_id, author_id, author_name, content, timestamp, edited_timestamp, is_bot, message_type, pinned, attachments, embeds, stickers, reactions, reply_to_id, thread_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      edited_timestamp = excluded.edited_timestamp,
      pinned = excluded.pinned,
      embeds = excluded.embeds,
      reactions = excluded.reactions
  `)

  const transaction = database.transaction((msgs: MessageRecord[]) => {
    for (const msg of msgs) {
      stmt.run(
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
        msg.threadId || null
      )
    }
  })

  transaction(messages)
}

/**
 * Get the oldest message ID for a channel (for backfill pagination)
 */
export function getOldestMessageId(channelId: string): string | null {
  const database = getDB()
  const stmt = database.prepare(`
    SELECT id FROM messages
    WHERE channel_id = ?
    ORDER BY timestamp ASC
    LIMIT 1
  `)
  const row = stmt.get(channelId) as { id: string } | undefined
  return row?.id || null
}

/**
 * Get the newest message ID for a channel (for catch-up on restart)
 */
export function getNewestMessageId(channelId: string): string | null {
  const database = getDB()
  const stmt = database.prepare(`
    SELECT id FROM messages
    WHERE channel_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `)
  const row = stmt.get(channelId) as { id: string } | undefined
  return row?.id || null
}

/**
 * Get channels that have messages (for catch-up on restart)
 */
export function getChannelsWithMessages(): string[] {
  const database = getDB()
  const stmt = database.prepare(`
    SELECT DISTINCT channel_id FROM messages
  `)
  const rows = stmt.all() as Array<{ channel_id: string }>
  return rows.map(r => r.channel_id)
}

/**
 * Update the oldest fetched message ID for a channel
 */
export function updateChannelOldestFetched(channelId: string, messageId: string | null): void {
  const database = getDB()
  const stmt = database.prepare(`
    UPDATE channels
    SET oldest_fetched_id = ?
    WHERE id = ?
  `)
  stmt.run(messageId, channelId)
}

/**
 * Get channel backfill status
 */
export function getChannelBackfillStatus(channelId: string): { oldestFetchedId: string | null } | null {
  const database = getDB()
  const stmt = database.prepare(`
    SELECT oldest_fetched_id
    FROM channels
    WHERE id = ?
  `)
  const row = stmt.get(channelId) as { oldest_fetched_id: string | null } | undefined
  if (!row) return null
  return { oldestFetchedId: row.oldest_fetched_id }
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
}

/**
 * Get message statistics per channel
 */
export function getChannelStats(): ChannelStats[] {
  const database = getDB()
  const stmt = database.prepare(`
    SELECT
      c.id,
      c.name,
      c.guild_name as guildName,
      c.oldest_fetched_id,
      COUNT(m.id) as messageCount,
      MIN(m.timestamp) as oldestMessageDate,
      MAX(m.timestamp) as newestMessageDate
    FROM channels c
    LEFT JOIN messages m ON c.id = m.channel_id
    GROUP BY c.id
    ORDER BY messageCount DESC
  `)

  const rows = stmt.all() as Array<{
    id: string
    name: string
    guildName: string | null
    oldest_fetched_id: string | null
    messageCount: number
    oldestMessageDate: string | null
    newestMessageDate: string | null
  }>

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    guildName: row.guildName,
    messageCount: row.messageCount,
    oldestMessageDate: row.oldestMessageDate,
    newestMessageDate: row.newestMessageDate,
    // Backfill is complete when oldest_fetched_id is 'COMPLETE'
    backfillComplete: row.oldest_fetched_id === 'COMPLETE',
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
export function getTotalStats(): TotalStats {
  const database = getDB()

  const msgStats = database.prepare(`
    SELECT
      COUNT(*) as totalMessages,
      MIN(timestamp) as oldestMessageDate,
      MAX(timestamp) as newestMessageDate
    FROM messages
  `).get() as {
    totalMessages: number
    oldestMessageDate: string | null
    newestMessageDate: string | null
  }

  const channelStats = database.prepare(`
    SELECT
      COUNT(*) as totalChannels,
      SUM(CASE WHEN oldest_fetched_id = 'COMPLETE' THEN 1 ELSE 0 END) as channelsComplete
    FROM channels
  `).get() as {
    totalChannels: number
    channelsComplete: number
  }

  return {
    totalMessages: msgStats.totalMessages,
    totalChannels: channelStats.totalChannels,
    oldestMessageDate: msgStats.oldestMessageDate,
    newestMessageDate: msgStats.newestMessageDate,
    channelsComplete: channelStats.channelsComplete,
    channelsInProgress: channelStats.totalChannels - channelStats.channelsComplete,
  }
}

/**
 * Check if a message exists in the database
 */
export function messageExists(messageId: string): boolean {
  const database = getDB()
  const stmt = database.prepare(`SELECT 1 FROM messages WHERE id = ? LIMIT 1`)
  return stmt.get(messageId) !== undefined
}

/**
 * Check if a channel exists in the database
 */
export function channelExists(channelId: string): boolean {
  const database = getDB()
  const stmt = database.prepare(`SELECT 1 FROM channels WHERE id = ? LIMIT 1`)
  return stmt.get(channelId) !== undefined
}

/**
 * Ensure a channel exists in the database (creates a minimal record if missing)
 * Used before saving real-time messages to satisfy foreign key constraint
 */
export function ensureChannelExists(channelId: string, channelName?: string): void {
  const database = getDB()
  const stmt = database.prepare(`
    INSERT INTO channels (id, name, first_seen)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  stmt.run(channelId, channelName || `channel-${channelId}`, new Date().toISOString())
}

/**
 * Get database file path (for display purposes)
 */
export function getDBPath(): string {
  return DB_PATH
}

/**
 * Get recent messages for a channel from the archive
 */
export function getMessagesFromArchive(
  channelId: string,
  limit = 20
): MessageRecord[] {
  const database = getDB()
  const stmt = database.prepare(`
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
  `)
  const rows = stmt.all(channelId, limit) as Array<{
    id: string
    channelId: string
    authorId: string
    authorName: string
    content: string
    timestamp: string
    isBot: number
    attachments: string | null
    reactions: string | null
    replyToId: string | null
  }>

  return rows.map(row => ({
    id: row.id,
    channelId: row.channelId,
    authorId: row.authorId,
    authorName: row.authorName,
    content: row.content,
    timestamp: row.timestamp,
    isBot: row.isBot === 1,
    attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
    reactions: row.reactions ? JSON.parse(row.reactions) : undefined,
    replyToId: row.replyToId || undefined,
  }))
}

/**
 * Get messages after a specific timestamp (for detecting new messages)
 */
export function getMessagesSinceTimestamp(
  channelId: string,
  sinceTimestamp: string,
  excludeAuthorId?: string
): MessageRecord[] {
  const database = getDB()
  let query = `
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
  const params: (string | number)[] = [channelId, sinceTimestamp]

  if (excludeAuthorId) {
    query += ` AND author_id != ?`
    params.push(excludeAuthorId)
  }

  query += ` ORDER BY timestamp DESC`

  const stmt = database.prepare(query)
  const rows = stmt.all(...params) as Array<{
    id: string
    channelId: string
    authorId: string
    authorName: string
    content: string
    timestamp: string
    isBot: number
    attachments: string | null
    reactions: string | null
    replyToId: string | null
  }>

  return rows.map(row => ({
    id: row.id,
    channelId: row.channelId,
    authorId: row.authorId,
    authorName: row.authorName,
    content: row.content,
    timestamp: row.timestamp,
    isBot: row.isBot === 1,
    attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
    reactions: row.reactions ? JSON.parse(row.reactions) : undefined,
    replyToId: row.replyToId || undefined,
  }))
}

/**
 * Get the newest message timestamp for a channel
 */
export function getNewestMessageTimestamp(channelId: string): string | null {
  const database = getDB()
  const stmt = database.prepare(`
    SELECT timestamp FROM messages
    WHERE channel_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `)
  const row = stmt.get(channelId) as { timestamp: string } | undefined
  return row?.timestamp || null
}

/**
 * Get all archived channels
 */
export function getArchivedChannels(): ChannelRecord[] {
  const database = getDB()
  const stmt = database.prepare(`
    SELECT id, name, guild_id as guildId, guild_name as guildName, parent_id as parentId, topic, type
    FROM channels
  `)
  return stmt.all() as ChannelRecord[]
}

/**
 * Check if archive database exists and has data
 */
export function hasArchiveData(): boolean {
  try {
    const database = getDB()
    const row = database.prepare(`SELECT COUNT(*) as count FROM messages`).get() as { count: number }
    return row.count > 0
  } catch {
    return false
  }
}

/**
 * Get Discord URL for a channel
 */
export function getChannelUrl(channelId: string): string | null {
  const database = getDB()
  const stmt = database.prepare(`
    SELECT id, guild_id, type
    FROM channels
    WHERE id = ?
  `)
  const row = stmt.get(channelId) as { id: string; guild_id: string | null; type: string | null } | undefined
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
export function getMessageUrl(messageId: string): string | null {
  const database = getDB()
  const stmt = database.prepare(`
    SELECT m.id, m.channel_id, c.guild_id, c.type
    FROM messages m
    JOIN channels c ON m.channel_id = c.id
    WHERE m.id = ?
  `)
  const row = stmt.get(messageId) as { id: string; channel_id: string; guild_id: string | null; type: string | null } | undefined
  if (!row) return null

  if (row.type === 'dm') {
    return `https://discord.com/channels/@me/${row.channel_id}/${row.id}`
  }

  if (row.guild_id) {
    return `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.id}`
  }

  return null
}
