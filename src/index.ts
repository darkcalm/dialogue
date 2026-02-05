import 'dotenv/config'

import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
import { startBot } from '@/helpers/bot'
import deployCommands from '@/helpers/deployCommands'
import { initDBWithCache, hasLocalCache, syncCache } from '@/cli/local-cache'
import { enableLocalCacheMode, hasArchiveData } from '@/cli/db'
import { syncLinksFromCache } from '@/cli/links-db'

const ARCHIVE_LOCK_FILE = path.join(os.homedir(), '.dialogue-archive.lock')
const BOT_LOCK_FILE = path.join(os.homedir(), '.dialogue-bot.lock')

function writeBotLockFile(): void {
  fs.writeFileSync(BOT_LOCK_FILE, process.pid.toString())
}

function removeBotLockFile(): void {
  try {
    if (fs.existsSync(BOT_LOCK_FILE)) {
      fs.unlinkSync(BOT_LOCK_FILE)
    }
  } catch {
    // Ignore
  }
}

function isArchiveRunning(): boolean {
  try {
    if (!fs.existsSync(ARCHIVE_LOCK_FILE)) return false
    const pid = parseInt(fs.readFileSync(ARCHIVE_LOCK_FILE, 'utf-8').trim(), 10)
    process.kill(pid, 0)
    return true
  } catch {
    if (fs.existsSync(ARCHIVE_LOCK_FILE)) {
      fs.unlinkSync(ARCHIVE_LOCK_FILE)
    }
    return false
  }
}

function spawnArchiveProcess(): ChildProcess {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const archivePath = path.join(__dirname, 'archive.mjs')
  const child = spawn('node', [archivePath], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return child
}

async function waitForArchiveData(timeoutMs = 30000): Promise<boolean> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    if (await hasArchiveData()) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

async function ensureArchiveAndLinks(): Promise<void> {
  const hasCachedData = hasLocalCache()

  // Start archive if not running
  if (!isArchiveRunning()) {
    console.log('🚀 Starting archive service in background...')
    spawnArchiveProcess()
  }

  if (hasCachedData) {
    console.log('💾 Loading from local cache...')
    await initDBWithCache() // Syncs if cache is stale
    enableLocalCacheMode()
  } else {
    console.log('⏳ Waiting for archive to initialize...')
    const hasData = await waitForArchiveData(60000)

    if (!hasData) {
      console.log('⚠️  Archive is starting but no data yet. Links will sync once data is available.')
    }

    console.log('📥 Downloading archive to local cache...')
    await initDBWithCache({ forceSync: true })
    enableLocalCacheMode()
  }

  // Sync links database
  console.log('🔗 Syncing links database...')
  const { added, total } = await syncLinksFromCache()
  console.log(`✅ Links: ${added} new, ${total} total`)
}

void (async () => {
  // Write lock file so inbox can detect us
  writeBotLockFile()

  // Clean up lock file on exit
  process.on('exit', removeBotLockFile)
  process.on('SIGINT', () => {
    removeBotLockFile()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    removeBotLockFile()
    process.exit(0)
  })

  // Ensure archive is running and links are synced before starting bot
  await ensureArchiveAndLinks()

  await deployCommands()
  console.log('Application commands successfully registered')
  await startBot()
  console.log('Bot has started')

  // Start periodic cache sync as fallback (catches any missed writes)
  const SYNC_INTERVAL_MS = 30000 // 30 seconds
  console.log(`Starting periodic cache sync every ${SYNC_INTERVAL_MS / 1000}s as fallback...`)
  setInterval(async () => {
    try {
      await syncCache()
      console.log('✓ Background cache sync completed')
    } catch (error) {
      console.error('✗ Background cache sync failed:', error instanceof Error ? error.message : 'Unknown error')
    }
  }, SYNC_INTERVAL_MS)

  // Start periodic links sync (extracts links from archived messages)
  const LINKS_SYNC_INTERVAL_MS = 60000 // 60 seconds (1 minute)
  console.log(`Starting periodic links sync every ${LINKS_SYNC_INTERVAL_MS / 1000}s...`)
  setInterval(async () => {
    try {
      const { added, total } = await syncLinksFromCache()
      if (added > 0) {
        console.log(`✓ Links sync: ${added} new links added (${total} total)`)
      }
    } catch (error) {
      console.error('✗ Links sync failed:', error instanceof Error ? error.message : 'Unknown error')
    }
  }, LINKS_SYNC_INTERVAL_MS)
})()
