/**
 * CLI for the links database
 * Syncs links from the local message cache and provides query interface
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  syncLinksFromCache,
  getLinks,
  getUniqueUrls,
  getLinksStats,
  getLinksDBInfo,
  hasLinksDB,
  initLinksDB,
} from './links-db'
import { initDBWithCache, hasLocalCache } from './local-cache'
import { enableLocalCacheMode } from './db'

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] || 'sync'

  // Ensure local cache is ready
  if (!hasLocalCache()) {
    console.log('❌ No local cache found. Run `npm run inbox` first to sync from Turso.')
    process.exit(1)
  }

  // Initialize cache connection
  await initDBWithCache()
  enableLocalCacheMode()

  switch (command) {
    case 'sync': {
      const fullSync = args.includes('--full')
      if (fullSync) {
        const syncFile = path.join(os.homedir(), '.dialogue-cache', 'links-last-sync.txt')
        if (fs.existsSync(syncFile)) {
          fs.unlinkSync(syncFile)
        }
        console.log('🔗 Full re-sync of links database...')
      } else {
        console.log('🔗 Syncing links database...')
      }
      const { added, total } = await syncLinksFromCache()
      console.log(`✅ Added ${added} new link entries`)
      console.log(`📊 Total links in database: ${total}`)
      break
    }

    case 'stats': {
      if (!hasLinksDB()) {
        console.log('❌ Links database not found. Run `npm run links sync` first.')
        process.exit(1)
      }
      await initLinksDB()
      const stats = await getLinksStats()
      const info = getLinksDBInfo()

      console.log('📊 Links Database Stats')
      console.log('========================')
      console.log(`Database path: ${info.path}`)
      console.log(`Last sync: ${info.lastSync?.toISOString() || 'never'}`)
      console.log(`Total link entries: ${stats.totalLinks}`)
      console.log(`Unique URLs: ${stats.uniqueUrls}`)
      console.log(`Unique messages with links: ${stats.uniqueMessages}`)
      console.log(`Unique authors: ${stats.uniqueAuthors}`)
      if (stats.oldestLink) {
        console.log(`Date range: ${stats.oldestLink} to ${stats.newestLink}`)
      }
      break
    }

    case 'list': {
      if (!hasLinksDB()) {
        console.log('❌ Links database not found. Run `npm run links sync` first.')
        process.exit(1)
      }
      await initLinksDB()

      const limit = parseInt(args[1]) || 20
      const links = await getLinks({ limit })

      console.log(`📋 Recent ${links.length} links:\n`)
      for (const link of links) {
        const date = new Date(link.timestamp).toLocaleDateString()
        const channel = link.channelName || link.channelId
        console.log(`[${date}] ${link.authorName} in #${channel}`)
        console.log(`  🔗 ${link.url}`)
        if (link.content && link.content.length > 100) {
          console.log(`  💬 ${link.content.substring(0, 100)}...`)
        } else if (link.content) {
          console.log(`  💬 ${link.content}`)
        }
        console.log()
      }
      break
    }

    case 'top': {
      if (!hasLinksDB()) {
        console.log('❌ Links database not found. Run `npm run links sync` first.')
        process.exit(1)
      }
      await initLinksDB()

      const limit = parseInt(args[1]) || 20
      const urls = await getUniqueUrls({ limit })

      console.log(`🏆 Top ${urls.length} most shared URLs:\n`)
      for (const item of urls) {
        console.log(`[${item.count}x] ${item.url}`)
        console.log(`    First: ${new Date(item.firstSeen).toLocaleDateString()} | Last: ${new Date(item.lastSeen).toLocaleDateString()}`)
      }
      break
    }

    case 'search': {
      if (!hasLinksDB()) {
        console.log('❌ Links database not found. Run `npm run links sync` first.')
        process.exit(1)
      }
      await initLinksDB()

      const pattern = args[1]
      if (!pattern) {
        console.log('Usage: npm run links search <url-pattern>')
        process.exit(1)
      }

      const links = await getLinks({ urlPattern: pattern, limit: 50 })

      console.log(`🔍 Found ${links.length} links matching "${pattern}":\n`)
      for (const link of links) {
        const date = new Date(link.timestamp).toLocaleDateString()
        const channel = link.channelName || link.channelId
        console.log(`[${date}] ${link.authorName} in #${channel}`)
        console.log(`  🔗 ${link.url}`)
        console.log()
      }
      break
    }

    default:
      console.log('🔗 Links Database CLI')
      console.log('Usage: npm run links <command>')
      console.log()
      console.log('Commands:')
      console.log('  sync           Sync links from local message cache (default)')
      console.log('  stats          Show database statistics')
      console.log('  list [n]       List recent n links (default: 20)')
      console.log('  top [n]        Show top n most shared URLs (default: 20)')
      console.log('  search <pat>   Search for URLs matching pattern')
  }

  process.exit(0)
}

void main()
