import { REST } from '@discordjs/rest'

/**
 * Check if a Discord token is valid and determine its type
 * @param token - The Discord token to check
 * @returns Object with isValid, tokenType ('bot' | 'user' | 'invalid'), and userInfo
 */
export async function checkToken(token: string): Promise<{
  isValid: boolean
  tokenType: 'bot' | 'user' | 'invalid'
  userInfo?: {
    id: string
    username: string
    discriminator: string
    bot?: boolean
  }
  error?: string
}> {
  try {
    const rest = new REST({ version: '10' }).setToken(token)

    // Try to get current user info (works for both bot and user tokens)
    const user = (await rest.get('/users/@me')) as {
      id: string
      username: string
      discriminator: string
      bot?: boolean
    }

    // Determine token type
    const tokenType: 'bot' | 'user' = user.bot ? 'bot' : 'user'

    return {
      isValid: true,
      tokenType,
      userInfo: {
        id: user.id,
        username: user.username,
        discriminator: user.discriminator,
        bot: user.bot,
      },
    }
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    return {
      isValid: false,
      tokenType: 'invalid',
      error: errorMessage,
    }
  }
}

/**
 * Format token for display (shows first/last few characters)
 */
export function formatTokenForDisplay(token: string): string {
  if (token.length <= 10) return '***'
  return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`
}
