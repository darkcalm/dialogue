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
const clients: Record<string, Client> = {}

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
    clients[key]?.close()
    delete clients[key]
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

  await db.execute(`
    CREATE TABLE IF NOT EXISTS message_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    )
  `)

  // Create indexes
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_message_events_message ON message_events(message_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_message_events_type ON message_events(event_type)`)
}

// Data record types
export interface ChannelRecord {
  id: string
  name: string
  guildId?: string
  guildName?: string
  parentId?: string
  topic?: string
  type?: string
}

function parseJson<T>(value: unknown): T | undefined {
  if (!value) return undefined
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

export function rowToChannelRecord(row: any): ChannelRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    guildId: row.guildId ?? row.guild_id ?? undefined,
    guildName: row.guildName ?? row.guild_name ?? undefined,
    parentId: row.parentId ?? row.parent_id ?? undefined,
    topic: row.topic ?? undefined,
    type: row.type ?? undefined,
  }
}

export function rowToMessageRecord(row: any): MessageRecord {
  return {
    id: String(row.id),
    channelId: String(row.channelId ?? row.channel_id),
    authorId: String(row.authorId ?? row.author_id),
    authorName: String(row.authorName ?? row.author_name),
    content: (row.content as string) ?? '',
    timestamp: String(row.timestamp),
    editedTimestamp: row.editedTimestamp ?? row.edited_timestamp ?? undefined,
    isBot: row.isBot === true || row.is_bot === 1 || row.is_bot === true,
    messageType: row.messageType ?? row.message_type ?? undefined,
    pinned: row.pinned === 1 || row.pinned === true,
    attachments: parseJson<any[]>(row.attachments),
    embeds: parseJson<any[]>(row.embeds),
    stickers: parseJson<any[]>(row.stickers),
    reactions: parseJson<any[]>(row.reactions),
    replyToId: row.replyToId ?? row.reply_to_id ?? undefined,
    threadId: row.threadId ?? row.thread_id ?? undefined,
  }
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
    SELECT id, name, guild_id, guild_name, parent_id, topic, type
    FROM channels
  `)
  return result.rows.map(rowToChannelRecord)
}

export async function getMessages(db: Client, channelId: string, limit: number): Promise<MessageRecord[]> {
  const result = await db.execute({
    sql: `
      SELECT m.* FROM messages m
      WHERE m.channel_id = ?
        AND m.id NOT IN (SELECT message_id FROM message_events WHERE event_type = 'delete')
      ORDER BY m.timestamp DESC
      LIMIT ?
    `,
    args: [channelId, limit],
  })
  return result.rows.map(rowToMessageRecord)
}

export async function getMessagesSince(db: Client, channelId: string, timestamp: string, excludeAuthorId?: string): Promise<MessageRecord[]> {
    let sql = `
      SELECT m.* FROM messages m
      WHERE m.channel_id = ?
        AND m.timestamp > ?
        AND m.id NOT IN (SELECT message_id FROM message_events WHERE event_type = 'delete')
    `
    const args: (string | number)[] = [channelId, timestamp]

    if (excludeAuthorId) {
        sql += ` AND m.author_id != ?`
        args.push(excludeAuthorId)
    }

    sql += ` ORDER BY m.timestamp DESC`

    const result = await db.execute({ sql, args })
    return result.rows.map(rowToMessageRecord)
}

export async function getMessagesBefore(db: Client, channelId: string, beforeId: string, limit: number): Promise<MessageRecord[]> {
  const result = await db.execute({
    sql: `
      SELECT m.* FROM messages m
      WHERE m.channel_id = ?
        AND m.id < ?
        AND m.id NOT IN (SELECT message_id FROM message_events WHERE event_type = 'delete')
      ORDER BY m.timestamp DESC
      LIMIT ?
    `,
    args: [channelId, beforeId, limit],
  })
  return result.rows.map(rowToMessageRecord)
}

export async function getNewestMessageTimestamp(db: Client, channelId: string): Promise<string | null> {
  const result = await db.execute({
    sql: `SELECT timestamp FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT 1`,
    args: [channelId],
  })
  return (result.rows[0]?.timestamp as string) || null
}

/**
 * Record a message event (delete, edit, etc.)
 * @param db The libSQL client to use.
 * @param messageId The ID of the message.
 * @param eventType The type of event (e.g., 'delete', 'edit').
 */
export async function recordMessageEvent(db: Client, messageId: string, eventType: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO message_events (message_id, event_type, timestamp) VALUES (?, ?, ?)`,
    args: [messageId, eventType, new Date().toISOString()],
  })
}

/**
 * Check if a message has been deleted
 * @param db The libSQL client to use.
 * @param messageId The ID of the message.
 * @returns True if the message has a delete event.
 */
export async function isMessageDeleted(db: Client, messageId: string): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT 1 FROM message_events WHERE message_id = ? AND event_type = 'delete' LIMIT 1`,
    args: [messageId],
  })
  return result.rows.length > 0
}

/**
 * Get all deleted message IDs for a channel
 * @param db The libSQL client to use.
 * @param channelId The ID of the channel.
 * @returns Set of deleted message IDs.
 */
export async function getDeletedMessageIds(db: Client, channelId: string): Promise<Set<string>> {
  const result = await db.execute({
    sql: `
      SELECT DISTINCT me.message_id
      FROM message_events me
      JOIN messages m ON me.message_id = m.id
      WHERE m.channel_id = ? AND me.event_type = 'delete'
    `,
    args: [channelId],
  })
  return new Set(result.rows.map(row => String(row.message_id)))
}
