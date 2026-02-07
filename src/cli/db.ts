/**
 * Database module for message archival, supporting separate realtime and archive databases.
 * Each database can have a local (SQLite file) and remote (Turso) instance.
 */

import { createClient, Client } from '@libsql/client'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

const CACHE_DIR = path.join(os.homedir(), '.dialogue-cache')

// Type definitions
export type DbName = 'realtime' | 'archive'
export type DbType = 'local' | 'remote'

// Keep a cache of client instances
const clients: Partial<Record<`${DbName}-${DbType}`, Client>> = {}

/**
 * Ensure the cache directory for local databases exists.
 */
function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
  }
}

/**
 * Get a database client for a specific database name and type.
 * @param dbName The name of the database ('realtime' or 'archive').
 * @param type The type of the database ('local' or 'remote').
 * @returns A libSQL client instance.
 */
export function getClient(dbName: DbName, type: DbType): Client {
  const clientKey = `${dbName}-${type}`
  if (clients[clientKey]) {
    return clients[clientKey]!
  }

  let url: string
  let authToken: string | undefined

  if (type === 'local') {
    ensureCacheDir()
    const dbPath = path.join(CACHE_DIR, `${dbName}.db`)
    url = `file:${dbPath}`
  } else { // remote
    const urlVar = `${dbName.toUpperCase()}_TURSO_DB_URL`
    const tokenVar = `${dbName.toUpperCase()}_TURSO_AUTH_TOKEN`
    url = process.env[urlVar] || ''
    authToken = process.env[tokenVar]
    if (!url) {
      throw new Error(`${urlVar} environment variable is required for remote database.`)
    }
  }

  const client = createClient({ url, authToken })
  clients[clientKey] = client
  return client
}

/**
 * Close all active database connections.
 */
export function closeAllDBs(): void {
  for (const key in clients) {
    clients[key as keyof typeof clients]?.close()
    delete clients[key as keyof typeof clients]
  }
}

/**
 * Initialize the database schema for a given client.
 * @param db The libSQL client to initialize.
 */
export async function initDB(db: Client): Promise<void> {
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
  
  await db.execute(`
    CREATE TABLE IF NOT EXISTS channel_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `)

  // Create indexes
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`)
}

// Data record types (interfaces remain the same)
export interface ChannelRecord {
  id: string
  name: string
  guildId?: string
  guildName?: string
  parentId?: string
  topic?: string
  type?: string
}

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
  attachments?: any[]
  embeds?: any[]
  stickers?: any[]
  reactions?: any[]
  replyToId?: string
  threadId?: string
}

/**
 * Save multiple channels in a batch to a specific database.
 * @param db The libSQL client to use.
 * @param channels The channel records to save.
 */
export async function saveChannels(db: Client, channels: ChannelRecord[]): Promise<void> {
  if (channels.length === 0) return

  const statements = channels.map((channel) => ({
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
  }))

  await db.batch(statements, 'write')
}

/**
 * Save multiple messages in a batch to a specific database.
 * @param db The libSQL client to use.
 * @param messages The message records to save.
 */
export async function saveMessages(db: Client, messages: MessageRecord[]): Promise<void> {
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
  
  await db.batch(statements, 'write')
}

/**
 * Gets the oldest message ID for a channel from a specific database.
 * @param db The libSQL client to use.
 * @param channelId The ID of the channel.
 * @returns The oldest message ID, or null if not found.
 */
export async function getOldestMessageId(db: Client, channelId: string): Promise<string | null> {
  const result = await db.execute({
    sql: `SELECT id FROM messages WHERE channel_id = ? ORDER BY timestamp ASC LIMIT 1`,
    args: [channelId],
  })
  return (result.rows[0]?.id as string) || null
}

/**
 * Gets channel statistics from a specific database.
 * @param db The libSQL client to use.
 * @returns An array of channel statistics.
 */
export async function getChannelStats(db: Client): Promise<any[]> {
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
  return result.rows
}

/**
 * Check if a message exists in the database.
 * @param db The libSQL client to use.
 * @param messageId The ID of the message to check.
 * @returns True if the message exists, false otherwise.
 */
export async function messageExists(db: Client, messageId: string): Promise<boolean> {
    const result = await db.execute({
        sql: `SELECT 1 FROM messages WHERE id = ? LIMIT 1`,
        args: [messageId],
    });
    return result.rows.length > 0;
}

/**
 * Update the oldest fetched message ID for a channel.
 * @param db The libSQL client to use.
 * @param channelId The ID of the channel.
 * @param messageId The ID of the oldest message fetched, or 'COMPLETE'.
 */
export async function updateChannelOldestFetched(db: Client, channelId: string, messageId: string | null): Promise<void> {
    await db.execute({
        sql: `UPDATE channels SET oldest_fetched_id = ? WHERE id = ?`,
        args: [messageId, channelId],
    });
}

/**
 * Get channel frontfill status.
 * @param db The libSQL client to use.
 * @param channelId The ID of the channel.
 * @returns The frontfill status, or null if channel not found.
 */
export async function getChannelBackfillStatus(db: Client, channelId: string): Promise<{ oldestFetchedId: string | null } | null> {
    const result = await db.execute({
        sql: `SELECT oldest_fetched_id FROM channels WHERE id = ?`,
        args: [channelId],
    });
    if (!result.rows[0]) return null;
    return { oldestFetchedId: result.rows[0].oldest_fetched_id as string | null };
}

export async function getChannels(db: Client): Promise<ChannelRecord[]> {
  const result = await db.execute(`
    SELECT id, name, guild_id as guildId, guild_name as guildName, parent_id as parentId, topic, type
    FROM channels
  `)
  return result.rows as ChannelRecord[]
}

export async function getMessages(db: Client, channelId: string, limit: number): Promise<MessageRecord[]> {
  const result = await db.execute({
    sql: `SELECT * FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?`,
    args: [channelId, limit],
  })
  return result.rows as MessageRecord[]
}

export async function getMessagesSince(db: Client, channelId: string, timestamp: string, excludeAuthorId?: string): Promise<MessageRecord[]> {
    let sql = `SELECT * FROM messages WHERE channel_id = ? AND timestamp > ?`
    const args: (string | number)[] = [channelId, timestamp]

    if (excludeAuthorId) {
        sql += ` AND author_id != ?`
        args.push(excludeAuthorId)
    }

    sql += ` ORDER BY timestamp DESC`

    const result = await db.execute({ sql, args })
    return result.rows as MessageRecord[]
}

export async function getNewestMessageTimestamp(db: Client, channelId: string): Promise<string | null> {
  const result = await db.execute({
    sql: `SELECT timestamp FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT 1`,
    args: [channelId],
  })
  return (result.rows[0]?.timestamp as string) || null
}
