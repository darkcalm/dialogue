/**
 * Platform client factory
 * Creates the appropriate platform client based on type
 */

import { IPlatformClient, PlatformType } from './types'
import { DiscordPlatformClient } from './discord/client'
import { WhatsAppPlatformClient } from './whatsapp/client'

/**
 * Create a platform client instance
 */
export async function createPlatformClient(type: PlatformType): Promise<IPlatformClient> {
  switch (type) {
    case 'discord':
      return new DiscordPlatformClient()

    case 'whatsapp':
      return new WhatsAppPlatformClient()

    default:
      throw new Error(`Unknown platform type: ${type}`)
  }
}
