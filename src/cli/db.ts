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
      guild_name TEXT,
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
      is_bot INTEGER NOT NULL DEFAULT 0,
      attachments TEXT,
      reactions TEXT,
      reply_to_id TEXT,
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );

    -- Indexes for efficient querying
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp ON messages(channel_id, timestamp);
  `)

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
  guildName?: string
  type?: string
}

/**
 * Save or update a channel in the database
 */
export function saveChannel(channel: ChannelRecord): void {
  const database = getDB()
  const stmt = database.prepare(`
    INSERT INTO channels (id, name, guild_name, type, first_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      guild_name = excluded.guild_name,
      type = excluded.type
  `)
  stmt.run(
    channel.id,
    channel.name,
    channel.guildName || null,
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
  isBot: boolean
  attachments?: Array<{ id: string; name: string; url: string; size: number }>
  reactions?: Array<{ emoji: string; count: number; name: string; users: string[] }>
  replyToId?: string
}

/**
 * Save or update a message in the database
 */
export function saveMessage(msg: MessageRecord): void {
  const database = getDB()
  const stmt = database.prepare(`
    INSERT INTO messages (id, channel_id, author_id, author_name, content, timestamp, is_bot, attachments, reactions, reply_to_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      reactions = excluded.reactions
  `)
  stmt.run(
    msg.id,
    msg.channelId,
    msg.authorId,
    msg.authorName,
    msg.content,
    msg.timestamp,
    msg.isBot ? 1 : 0,
    msg.attachments ? JSON.stringify(msg.attachments) : null,
    msg.reactions ? JSON.stringify(msg.reactions) : null,
    msg.replyToId || null
  )
}

/**
 * Save multiple messages in a single transaction
 */
export function saveMessages(messages: MessageRecord[]): void {
  const database = getDB()
  const stmt = database.prepare(`
    INSERT INTO messages (id, channel_id, author_id, author_name, content, timestamp, is_bot, attachments, reactions, reply_to_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
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
        msg.isBot ? 1 : 0,
        msg.attachments ? JSON.stringify(msg.attachments) : null,
        msg.reactions ? JSON.stringify(msg.reactions) : null,
        msg.replyToId || null
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
