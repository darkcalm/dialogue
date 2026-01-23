import { ChatInputCommandInteraction, TextChannel, SlashCommandBuilder } from 'discord.js'

export const data = new SlashCommandBuilder()
  .setName('readchannel')
  .setDescription('Read recent messages from a channel')
  .addChannelOption((option) =>
    option
      .setName('channel')
      .setDescription('The channel to read from')
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
  const channel = interaction.options.get('channel')?.channel as TextChannel
  const limit = (interaction.options.get('limit')?.value as number) || 10

  if (!channel || !channel.isTextBased()) {
    return interaction.reply({
      content: 'Please provide a valid text channel.',
      ephemeral: true,
    })
  }

  try {
    // Fetch messages from the channel
    const messages = await channel.messages.fetch({ limit })

    if (messages.size === 0) {
      return interaction.reply({
        content: `No messages found in ${channel.name}.`,
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
      content: `**Last ${messages.size} messages from ${channel.name}:**\n\`\`\`\n${messageList}\n\`\`\``,
      ephemeral: true,
    })
  } catch (error) {
    console.error('Error reading channel:', error)
    return interaction.reply({
      content: 'Failed to read messages. Make sure the bot has permission to view the channel.',
      ephemeral: true,
    })
  }
}
