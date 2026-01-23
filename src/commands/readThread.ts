import { ChatInputCommandInteraction, ThreadChannel, SlashCommandBuilder } from 'discord.js'

export const data = new SlashCommandBuilder()
  .setName('readthread')
  .setDescription('Read recent messages from a thread')
  .addChannelOption((option) =>
    option
      .setName('thread')
      .setDescription('The thread to read from')
      .setRequired(true)
  )
  .addIntegerOption((option) =>
    option
      .setName('limit')
      .setDescription('Number of messages to fetch (1-100)')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(100)
  )

export async function execute(interaction: ChatInputCommandInteraction) {
  const thread = interaction.options.get('thread')?.channel as ThreadChannel
  const limit = (interaction.options.get('limit')?.value as number) || 10

  if (!thread || !thread.isThread()) {
    return interaction.reply({
      content: 'Please provide a valid thread.',
      ephemeral: true,
    })
  }

  try {
    // Join the thread if not already a member
    if (!thread.members.cache.has(interaction.client.user.id)) {
      await thread.join()
    }

    // Fetch messages from the thread
    const messages = await thread.messages.fetch({ limit })

    if (messages.size === 0) {
      return interaction.reply({
        content: `No messages found in thread "${thread.name}".`,
        ephemeral: true,
      })
    }

    // Format the messages
    const messageList = Array.from(messages.values())
      .reverse()
      .map(
        (msg, idx) =>
          `[${idx + 1}] ${msg.author.tag}: ${msg.content || '(no text content)'}`
      )
      .join('\n')

    return interaction.reply({
      content: `**Last ${messages.size} messages from thread "${thread.name}":**\n\`\`\`\n${messageList}\n\`\`\``,
      ephemeral: true,
    })
  } catch (error) {
    console.error('Error reading thread:', error)
    return interaction.reply({
      content: 'Failed to read messages. Make sure the bot has permission to view the thread.',
      ephemeral: true,
    })
  }
}
