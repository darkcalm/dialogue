/**
 * Session Agent for managing dialogue generation sessions
 * Ported from Python agents.py
 */

import { Message, ChatInputCommandInteraction } from 'discord.js'
import { Payload, Diagram } from './presets'

export class SessionAgent {
  private token: string

  constructor(token: string) {
    this.token = token
  }

  /**
   * Output dialogue result
   */
  async output(
    interaction: Message | ChatInputCommandInteraction,
    payload: Payload,
    publish: boolean
  ): Promise<void> {
    if (!payload) {
      return
    }

    const output = payload.diagram.printedseed(payload.keyed)

    if (interaction instanceof Message) {
      // Message reply - reply to the user's message that triggered this update
      // This creates a reply thread showing the updated dialogue
      await interaction.reply({
        content: output,
        allowedMentions: { repliedUser: false }, // Don't ping the user
      })
    } else {
      // Slash command interaction
      await interaction.followUp({
        content: output,
        ephemeral: !publish,
      })
    }

    // TODO: Implement image generation
    // For now, we only output text
    // Image generation would require:
    // - SVG/Canvas library for drawing
    // - Image processing for PNG conversion
  }
}

// Session storage
const sessions: Map<string, SessionAgent> = new Map()

export function getSession(token: string): SessionAgent {
  if (!sessions.has(token)) {
    sessions.set(token, new SessionAgent(token))
  }
  return sessions.get(token)!
}

export function deleteSession(token: string): void {
  sessions.delete(token)
}
