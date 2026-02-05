/**
 * Start bot service in background (daemonized)
 */

import 'dotenv/config'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'

const BOT_LOCK_FILE = path.join(os.homedir(), '.dialogue-bot.lock')

function isBotRunning(): boolean {
  try {
    if (!fs.existsSync(BOT_LOCK_FILE)) return false
    const pid = parseInt(fs.readFileSync(BOT_LOCK_FILE, 'utf-8').trim(), 10)
    process.kill(pid, 0)
    return true
  } catch {
    if (fs.existsSync(BOT_LOCK_FILE)) {
      fs.unlinkSync(BOT_LOCK_FILE)
    }
    return false
  }
}

function main() {
  if (isBotRunning()) {
    const pid = fs.readFileSync(BOT_LOCK_FILE, 'utf-8').trim()
    console.log(`🤖 Bot is already running (PID: ${pid})`)
    process.exit(0)
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const botPath = path.join(__dirname, 'index.mjs')

  console.log('🤖 Starting bot service in background...')

  const child = spawn('node', [botPath], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  console.log(`✅ Bot started with PID: ${child.pid}`)
  console.log('You can close this terminal. The bot will keep running.')
  console.log(`To stop: kill ${child.pid}`)

  process.exit(0)
}

main()
