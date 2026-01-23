import { checkToken, formatTokenForDisplay } from '@/helpers/checkToken'

/**
 * Standalone script to check a Discord token
 * Usage: node dist/scripts/checkToken.js YOUR_TOKEN_HERE
 * Or set USER_TOKEN in .env file
 */

async function main() {
  // Get token from command line argument or environment variable
  const token =
    process.argv[2] || process.env.USER_TOKEN || process.env.DISCORD_BOT_TOKEN

  if (!token) {
    console.error('❌ No token provided!')
    console.log('Usage: node dist/scripts/checkToken.js YOUR_TOKEN')
    console.log('Or set USER_TOKEN in .env file')
    process.exit(1)
  }

  console.log('🔍 Checking token...')
  console.log(`Token: ${formatTokenForDisplay(token)}\n`)

  const result = await checkToken(token)

  if (!result.isValid) {
    console.error('❌ Token is INVALID')
    console.error(`Error: ${result.error || 'Unknown error'}`)
    process.exit(1)
  }

  const tokenTypeEmoji = result.tokenType === 'bot' ? '🤖' : '👤'
  const tokenTypeLabel = result.tokenType === 'bot' ? 'Bot Token' : 'User Token'

  console.log(`✅ Token is VALID ${tokenTypeEmoji}`)
  console.log(`Type: ${tokenTypeLabel}\n`)

  if (result.userInfo) {
    console.log('Account Information:')
    console.log(`  Username: ${result.userInfo.username}#${result.userInfo.discriminator}`)
    console.log(`  ID: ${result.userInfo.id}`)
    console.log(`  Bot: ${result.userInfo.bot ? 'Yes' : 'No'}`)
  }

  if (result.tokenType === 'user') {
    console.log('\n⚠️  WARNING: Using user tokens violates Discord\'s Terms of Service')
    console.log('⚠️  Your account may be terminated if detected')
    console.log('⚠️  Use a bot token instead for automation')
  }

  process.exit(0)
}

void main()
