/**
 * Links Database - A derived local database that extracts and stores links from messages
 * Syncs with the local 'realtime' and 'archive' databases, transforming messages into link-based rows
 */

import { createClient, Client } from '@libsql/client'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { MessageRecord, ChannelRecord } from './db' // Assuming these are still valid

const CACHE_DIR = path.join(os.homedir(), '.dialogue-cache')
const LINKS_DB_PATH = path.join(CACHE_DIR, 'links.db')
const LINKS_SYNC_FILE = path.join(CACHE_DIR, 'links-last-sync.txt')

let linksClient: Client | null = null

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
  }
}

function getLinksClient(): Client {
  if (linksClient) return linksClient
  ensureCacheDir()
  linksClient = createClient({ url: `file:${LINKS_DB_PATH}` })
  return linksClient
}

export async function initLinksDB(): Promise<void> {
  const db = getLinksClient()
  await db.execute(`
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      message_id TEXT NOT NULL,
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
      channel_name TEXT,
      guild_id TEXT,
      guild_name TEXT,
      extracted_at TEXT NOT NULL,
      UNIQUE(url, message_id)
    )
  `)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_links_url ON links(url)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_links_message_id ON links(message_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_links_channel_id ON links(channel_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_links_timestamp ON links(timestamp)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_links_author_id ON links(author_id)`)
}

function getLastLinksSyncTime(): Date | null {
  try {
    if (fs.existsSync(LINKS_SYNC_FILE)) {
      const timestamp = fs.readFileSync(LINKS_SYNC_FILE, 'utf-8').trim()
      return new Date(timestamp)
    }
  } catch {}
  return null
}

function saveLastLinksSyncTime(): void {
  try {
    ensureCacheDir()
    fs.writeFileSync(LINKS_SYNC_FILE, new Date().toISOString())
  } catch {}
}

export function extractUrls(content: string): string[] {
  if (!content) return []
  const matches = content.match(URL_REGEX)
  if (!matches) return []
  const cleaned = matches.map((url) => url.replace(/[.,;:!?)]+$/, ''))
  return [...new Set(cleaned)]
}

export interface LinkRecord {
  id?: number
  url: string
  messageId: string
  channelId: string
  authorId: string
  authorName: string
  content: string
  timestamp: string
  editedTimestamp?: string
  isBot: boolean
  messageType?: string
  pinned?: boolean
  attachments?: string
  embeds?: string
  stickers?: string
  reactions?: string
  replyToId?: string
  threadId?: string
  channelName?: string
  guildId?: string
  guildName?: string
  extractedAt: string
}

export async function syncLinksFromCache(realtimeDb: Client, archiveDb: Client): Promise<{ added: number; total: number }> {
  await initLinksDB()
  const linksDb = getLinksClient()
  const lastSync = getLastLinksSyncTime()
  const linkCountResult = await linksDb.execute(`SELECT COUNT(*) as count FROM links`)
  const hasExistingLinks = Number(linkCountResult.rows[0].count) > 0
  const lastSyncISO = (lastSync && hasExistingLinks) ? lastSync.toISOString() : '1970-01-01T00:00:00.000Z'

  console.log(lastSync && hasExistingLinks ? `🔄 Syncing links since ${lastSync.toISOString()}...` : '📥 Initial links extraction...')

  // Fetch messages from both realtime and archive databases
  // This assumes the tables 'messages' and 'channels' are consistent across both
  const [realtimeMessagesResult, archiveMessagesResult] = await Promise.all([
    realtimeDb.execute({
      sql: `
        SELECT m.*, c.name as channel_name, c.guild_id, c.guild_name FROM messages m
        LEFT JOIN channels c ON m.channel_id = c.id
        WHERE m.content LIKE '%http%' AND m.timestamp > ?
      `,
      args: [lastSyncISO],
    }),
    archiveDb.execute({
      sql: `
        SELECT m.*, c.name as channel_name, c.guild_id, c.guild_name FROM messages m
        LEFT JOIN channels c ON m.channel_id = c.id
        WHERE m.content LIKE '%http%' AND m.timestamp > ?
      `,
      args: [lastSyncISO],
    }),
  ])

  // Merge messages, prioritizing realtime
  const allMessagesMap = new Map<string, any>()
  archiveMessagesResult.rows.forEach(row => allMessagesMap.set(row.id as string, row))
  realtimeMessagesResult.rows.forEach(row => allMessagesMap.set(row.id as string, row))
  const allMessagesWithLinks = Array.from(allMessagesMap.values())

  console.log(`📊 Found ${allMessagesWithLinks.length} new messages with links since last sync.`)

  let addedCount = 0
  const now = new Date().toISOString()

  for (const row of allMessagesWithLinks) {
    const content = row.content as string
    const urls = extractUrls(content)

    for (const url of urls) {
      try {
        await linksDb.execute({
          sql: `
            INSERT INTO links (
              url, message_id, channel_id, author_id, author_name, content,
              timestamp, edited_timestamp, is_bot, message_type, pinned,
              attachments, embeds, stickers, reactions, reply_to_id, thread_id,
              channel_name, guild_id, guild_name, extracted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url, message_id) DO UPDATE SET
              content = excluded.content,
              edited_timestamp = excluded.edited_timestamp,
              reactions = excluded.reactions,
              timestamp = excluded.timestamp, -- Ensure timestamp is updated
              extracted_at = excluded.extracted_at -- Ensure extracted_at is updated
          `,
          args: [
            url, row.id as string, row.channel_id as string, row.author_id as string,
            row.author_name as string, content, row.timestamp as string,
            (row.edited_timestamp as string) || null, row.is_bot as number,
            (row.message_type as string) || null, row.pinned as number,
            (row.attachments as string) || null, (row.embeds as string) || null,
            (row.stickers as string) || null, (row.reactions as string) || null,
            (row.reply_to_id as string) || null, (row.thread_id as string) || null,
            (row.channel_name as string) || null, (row.guild_id as string) || null,
            (row.guild_name as string) || null, now,
          ],
        })
        addedCount++
      } catch (err) {
        // Ignore duplicate errors, etc.
      }
    }
  }

  saveLastLinksSyncTime()
  const countResult = await linksDb.execute(`SELECT COUNT(*) as count FROM links`)
  const total = Number(countResult.rows[0].count)
  return { added: addedCount, total }
}

export async function getLinks(db: Client, options?: {
  limit?: number
  offset?: number
  authorId?: string
  channelId?: string
  channelPattern?: string
  urlPattern?: string
  since?: string
}): Promise<LinkRecord[]> {
  const linksDb = db // getLinksClient() should be called outside if this function is general
  let sql = `SELECT * FROM links WHERE 1=1`
  const args: (string | number)[] = []
  if (options?.authorId) { sql += ` AND author_id = ?`; args.push(options.authorId) }
  if (options?.channelId) { sql += ` AND channel_id = ?`; args.push(options.channelId) }
  if (options?.channelPattern) { sql += ` AND channel_name LIKE ?`; args.push(`%${options.channelPattern}%`) }
  if (options?.urlPattern) { sql += ` AND url LIKE ?`; args.push(`%${options.urlPattern}%`) }
  if (options?.since) { sql += ` AND timestamp > ?`; args.push(options.since) }
  sql += ` ORDER BY timestamp DESC`
  if (options?.limit) { sql += ` LIMIT ?`; args.push(options.limit) }
  if (options?.offset) { sql += ` OFFSET ?`; args.push(options.offset) }
  const result = await linksDb.execute({ sql, args })
  return result.rows.map((row) => ({
    id: row.id as number, url: row.url as string, messageId: row.message_id as string,
    channelId: row.channel_id as string, authorId: row.author_id as string,
    authorName: row.author_name as string, content: row.content as string,
    timestamp: row.timestamp as string, editedTimestamp: (row.edited_timestamp as string) || undefined,
    isBot: row.is_bot === 1, messageType: (row.message_type as string) || undefined,
    pinned: row.pinned === 1, attachments: (row.attachments as string) || undefined,
    embeds: (row.embeds as string) || undefined, stickers: (row.stickers as string) || undefined,
    reactions: (row.reactions as string) || undefined, replyToId: (row.reply_to_id as string) || undefined,
    threadId: (row.thread_id as string) || undefined, channelName: (row.channel_name as string) || undefined,
    guildId: (row.guild_id as string) || undefined, guildName: (row.guild_name as string) || undefined,
    extractedAt: row.extracted_at as string,
  }))
}

export async function getUniqueUrls(db: Client, options?: {
  limit?: number
  urlPattern?: string
}): Promise<{ url: string; count: number; firstSeen: string; lastSeen: string }[]> {
  const linksDb = db
  let sql = `SELECT url, COUNT(*) as count, MIN(timestamp) as first_seen, MAX(timestamp) as last_seen FROM links`
  const args: (string | number)[] = []
  if (options?.urlPattern) { sql += ` WHERE url LIKE ?`; args.push(`%${options.urlPattern}%`) }
  sql += ` GROUP BY url ORDER BY count DESC`
  if (options?.limit) { sql += ` LIMIT ?`; args.push(options.limit) }
  const result = await linksDb.execute({ sql, args })
  return result.rows.map((row) => ({
    url: row.url as string, count: row.count as number,
    firstSeen: row.first_seen as string, lastSeen: row.last_seen as string,
  }))
}

export async function getLinksStats(db: Client): Promise<{
  totalLinks: number; uniqueUrls: number; uniqueMessages: number; uniqueAuthors: number;
  oldestLink: string | null; newestLink: string | null;
}> {
  const linksDb = db
  const [totalResult, uniqueUrlsResult, uniqueMessagesResult, uniqueAuthorsResult, rangeResult] = await Promise.all([
    linksDb.execute(`SELECT COUNT(*) as count FROM links`),
    linksDb.execute(`SELECT COUNT(DISTINCT url) as count FROM links`),
    linksDb.execute(`SELECT COUNT(DISTINCT message_id) as count FROM links`),
    linksDb.execute(`SELECT COUNT(DISTINCT author_id) as count FROM links`),
    linksDb.execute(`SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM links`),
  ])
  return {
    totalLinks: Number(totalResult.rows[0].count), uniqueUrls: Number(uniqueUrlsResult.rows[0].count),
    uniqueMessages: Number(uniqueMessagesResult.rows[0].count), uniqueAuthors: Number(uniqueAuthorsResult.rows[0].count),
    oldestLink: (rangeResult.rows[0].oldest as string) || null, newestLink: (rangeResult.rows[0].newest as string) || null,
  }
}

export function hasLinksDB(): boolean {
  return fs.existsSync(LINKS_DB_PATH)
}

export function getLinksDBInfo(): { path: string; lastSync: Date | null; exists: boolean } {
  return {
    path: LINKS_DB_PATH,
    lastSync: getLastLinksSyncTime(),
    exists: hasLinksDB(),
  }
}

export function closeLinksDB(): void {
  if (linksClient) {
    linksClient.close()
    linksClient = null
  }
}