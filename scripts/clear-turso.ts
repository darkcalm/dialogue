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

    // Drop all tables
    await client.execute('DROP TABLE IF EXISTS messages')
    console.log('✅ Dropped messages table')

    await client.execute('DROP TABLE IF EXISTS channels')
    console.log('✅ Dropped channels table')

    await client.execute('DROP TABLE IF EXISTS channel_events')
    console.log('✅ Dropped channel_events table')

    console.log('✅ Turso tables dropped successfully')
  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  } finally {
    client.close()
  }
}

main()
