import { ChatInputCommandInteraction, TextChannel, SlashCommandBuilder } from 'discord.js'

export const data = new SlashCommandBuilder()
  .setName('post')
  .setDescription('Post a message to a channel as the bot')
  .addChannelOption((option) =>
    option
      .setName('channel')
      .setDescription('The channel to post to')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('message')
      .setDescription('The message to post')
      .setRequired(true)
  )

export async function execute(interaction: ChatInputCommandInteraction) {
  const channel = interaction.options.get('channel')?.channel as TextChannel
  const message = interaction.options.get('message')?.value as string

  if (!channel || !channel.isTextBased()) {
    return interaction.reply({
      content: 'Please provide a valid text channel.',
      ephemeral: true,
    })
  }

  try {
    // Post the message as the bot
    await channel.send(message)

    return interaction.reply({
      content: `Message posted to ${channel.name}!`,
      ephemeral: true,
    })
  } catch (error) {
    console.error('Error posting message:', error)
    return interaction.reply({
      content: 'Failed to post message. Make sure the bot has permission to send messages in that channel.',
      ephemeral: true,
    })
  }
}
