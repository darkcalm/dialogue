/**
 * Clear all data from Turso database
 */

import { createClient } from '@libsql/client'
import * as dotenv from 'dotenv'

// Load env vars
dotenv.config()

async function main() {
  const url = process.env.TURSO_DB_URL
  const authToken = process.env.TURSO_AUTH_TOKEN

  if (!url || !authToken) {
    console.error('❌ TURSO_DB_URL and TURSO_AUTH_TOKEN env vars required')
    process.exit(1)
  }

  const client = createClient({ url, authToken })

  try {
    console.log('🗑️  Clearing Turso database...')
    console.log(`Database: ${url}`)

    // Delete all data (keep tables)
    await client.execute('DELETE FROM messages')
    console.log('✅ Deleted messages')

    await client.execute('DELETE FROM channels')
    console.log('✅ Deleted channels')

    await client.execute('DELETE FROM channel_events')
    console.log('✅ Deleted channel_events')

    console.log('✅ Turso cleared successfully')
  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  } finally {
    client.close()
  }
}

main()
