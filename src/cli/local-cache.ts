/**
 * Local SQLite cache for Turso database
 * Uses libSQL embedded replica for fast local reads with remote sync
 */

import { createClient, Client } from '@libsql/client'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Local cache directory
const CACHE_DIR = path.join(os.homedir(), '.dialogue-cache')
const LOCAL_DB_PATH = path.join(CACHE_DIR, 'archive.db')
const SYNC_TIMESTAMP_FILE = path.join(CACHE_DIR, 'last-sync.txt')

// Database client (lazy initialized)
let client: Client | null = null
let syncPromise: Promise<void> | null = null

/**
 * Ensure cache directory exists
 */
function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
  }
}

/**
 * Get or create the database client with embedded replica
 */
function getClient(): Client {
  if (client) return client

  ensureCacheDir()

  const url = process.env.TURSO_DB_URL
  const authToken = process.env.TURSO_AUTH_TOKEN

  if (!url) {
    throw new Error('TURSO_DB_URL environment variable is required')
  }

  // Use embedded replica mode for fast local reads
  client = createClient({
    url: `file:${LOCAL_DB_PATH}`,
    syncUrl: url,
    authToken,
  })

  // Increase busy timeout to handle concurrent writes better
  // Default is 5 seconds, we increase to 30 seconds
  client.execute('PRAGMA busy_timeout = 30000').catch(() => {
    // Ignore errors - this is best-effort
  })

  return client
}

/**
 * Get last sync timestamp
 */
function getLastSyncTime(): Date | null {
  try {
    if (fs.existsSync(SYNC_TIMESTAMP_FILE)) {
      const timestamp = fs.readFileSync(SYNC_TIMESTAMP_FILE, 'utf-8').trim()
      return new Date(timestamp)
    }
  } catch {
    // Ignore errors
  }
  return null
}

/**
 * Save sync timestamp
 */
function saveLastSyncTime(): void {
  try {
    ensureCacheDir()
    fs.writeFileSync(SYNC_TIMESTAMP_FILE, new Date().toISOString())
  } catch {
    // Ignore errors
  }
}

/**
 * Check if local cache exists and has data
 */
export function hasLocalCache(): boolean {
  return fs.existsSync(LOCAL_DB_PATH)
}

/**
 * Get cache age in milliseconds
 */
export function getCacheAge(): number | null {
  const lastSync = getLastSyncTime()
  if (!lastSync) return null
  return Date.now() - lastSync.getTime()
}

/**
 * Initialize the database with embedded replica
 * Syncs from Turso if needed
 */
export async function initDBWithCache(options?: { forceSync?: boolean }): Promise<void> {
  const db = getClient()

  const cacheAge = getCacheAge()
  const hasCache = hasLocalCache()

  // Sync if:
  // - No local cache
  // - Force sync requested
  // - Cache is older than 1 minute (for startup refresh)
  const shouldSync = !hasCache || options?.forceSync || (cacheAge !== null && cacheAge > 60000)

  if (shouldSync) {
    console.log(hasCache ? '🔄 Syncing with Turso...' : '📥 Downloading from Turso (first time)...')
    const start = Date.now()
    try {
      await db.sync()
      const elapsed = Date.now() - start
      console.log(`✅ Synced in ${elapsed}ms`)
      saveLastSyncTime()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('database is locked')) {
        console.log('⚠️  Database is locked (another process using it), skipping sync')
        console.log('   Dual-write will keep both databases in sync')
      } else {
        throw error
      }
    }
  } else {
    console.log('💾 Using local cache (synced recently)')
  }
}

/**
 * Sync the local cache with remote (background-safe)
 */
export async function syncCache(): Promise<void> {
  // Avoid concurrent syncs
  if (syncPromise) {
    return syncPromise
  }

  syncPromise = (async () => {
    try {
      const db = getClient()
      await db.sync()
      saveLastSyncTime()
    } finally {
      syncPromise = null
    }
  })()

  return syncPromise
}

/**
 * Close the database connection
 */
export function closeDBCache(): void {
  if (client) {
    client.close()
    client = null
  }
}

/**
 * Get the database client for queries
 */
export function getCacheClient(): Client {
  return getClient()
}

/**
 * Get cache info for display
 */
export function getCacheInfo(): { path: string; lastSync: Date | null; exists: boolean } {
  return {
    path: LOCAL_DB_PATH,
    lastSync: getLastSyncTime(),
    exists: hasLocalCache(),
  }
}
