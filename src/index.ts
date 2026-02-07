import 'dotenv/config'

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { startBot } from '@/helpers/bot'
import deployCommands from '@/helpers/deployCommands'
import { getClient, initDB, closeAllDBs } from '@/cli/db' // New db client imports
import { syncLinksFromCache } from '@/cli/links-db' // This will also need refactoring

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

async function ensureLocalDbsAndLinks(): Promise<void> {
  console.log('Initializing local databases...')
  const realtimeLocalDb = getClient('realtime', 'local')
  const archiveLocalDb = getClient('archive', 'local')

  await initDB(realtimeLocalDb)
  await initDB(archiveLocalDb)
  console.log('Local databases initialized.')
  
  // Sync links database (this will be updated in links-db.ts to use new DBs)
  console.log('🔗 Syncing links database...')
  const { added, total } = await syncLinksFromCache(realtimeLocalDb, archiveLocalDb)
  console.log(`✅ Links: ${added} new, ${total} total`)
}

void (async () => {
  writeBotLockFile()

  process.on('exit', removeBotLockFile)
  process.on('SIGINT', () => {
    removeBotLockFile()
    closeAllDBs() // Close all DB connections on shutdown
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    removeBotLockFile()
    closeAllDBs() // Close all DB connections on shutdown
    process.exit(0)
  })

  // Ensure local databases are initialized and links are synced before starting bot
  await ensureLocalDbsAndLinks()

  await deployCommands()
  console.log('Application commands successfully registered')
  await startBot()
  console.log('Bot has started')

  // Periodic syncs (cache and links) are now managed by services themselves or orchestrator.
  // The bot service will no longer perform these periodic syncs.
})()