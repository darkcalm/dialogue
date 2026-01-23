import * as commandModules from '@/commands/index'
import { Client, IntentsBitField } from 'discord.js'
import config from '@/helpers/env'
import { parsePayload } from '@/helpers/bcd/presets'
import { getSession, deleteSession } from '@/helpers/bcd/sessionAgent'

const commands = Object(commandModules)

export const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.DirectMessages,
    IntentsBitField.Flags.MessageContent, // Required to read message content
  ],
})

export async function startBot() {
  client.once('ready', (client) => {
    console.log(`Discord ${client.user.tag} is ready`)
    console.log(
      `Link to invite: https://discord.com/api/oauth2/authorize?client_id=${config.CLIENT_ID}&permissions=0&scope=bot%20applications.commands`
    )
  })

  client.on('interactionCreate', (interaction) => {
    if (!interaction.isCommand()) return

    const { commandName } = interaction
    if (commands[commandName])
      commands[commandName].execute(interaction, client)
  })

  // Handle message replies for BCD dialogue updates
  // Matches original Python: @bot.event async def on_message(interaction)
  client.on('messageCreate', async (message) => {
    if (!client.user) return
    if (message.author.id === client.user.id) return
    if (!message.reference) return

    try {
      if (!message.reference.messageId) return
      
      // Fetch the referenced message
      const referencedMessage = await message.channel.messages.fetch(
        message.reference.messageId
      )

      // Check if the referenced message is from the bot
      if (referencedMessage.author.id !== client.user.id) return

      // Handle delete command - matches original: if interaction.content in ['delete', 'd']
      // Original is case-sensitive exact match, but we'll make it case-insensitive for better UX
      const contentTrimmed = message.content.trim()
      if (contentTrimmed.toLowerCase() === 'delete' || contentTrimmed.toLowerCase() === 'd') {
        try {
          await referencedMessage.delete()
        } catch (deleteError) {
          console.error('Error deleting message:', deleteError)
        }
        return
      }

      // Update diagram - matches original: Payload(reference.content, interaction.content)
      const refContent = referencedMessage.content
      const newContent = message.content
      
      // Create session using message ID (matching original: append_session(interaction.reference.message_id))
      const session = getSession(message.reference.messageId)
      
      // Parse payload with both reference content and new content
      const payload = parsePayload(refContent, newContent)

      if (payload) {
        // Output with publish=true (matching original)
        await session.output(message, payload, true)
      }
      
      // Clean up session (matching original: del sa)
      deleteSession(message.reference.messageId)
    } catch (error) {
      console.error('Error handling message reply:', error)
    }
  })

  await client.login(config.DISCORD_BOT_TOKEN)
}
