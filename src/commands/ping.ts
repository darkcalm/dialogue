import { ChatInputCommandInteraction } from 'discord.js'
import { SlashCommandBuilder } from '@discordjs/builders'

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Replies with pong')

export function execute(interaction: ChatInputCommandInteraction) {
  return interaction.reply('Pong!')
}
