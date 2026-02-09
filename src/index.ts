import 'dotenv/config'

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { startBot } from '@/helpers/bot'
import deployCommands from '@/helpers/deployCommands'
import { closeAllDBs } from '@/cli/db'

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

void (async () => {
  writeBotLockFile()

  process.on('exit', removeBotLockFile)
  process.on('SIGINT', () => {
    removeBotLockFile()
    closeAllDBs()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    removeBotLockFile()
    closeAllDBs()
    process.exit(0)
  })

  await deployCommands()
  console.log('Application commands successfully registered')
  await startBot()
  console.log('Bot has started')
})()