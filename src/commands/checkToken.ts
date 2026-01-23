import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js'
import { checkToken, formatTokenForDisplay } from '@/helpers/checkToken'

export const data = new SlashCommandBuilder()
  .setName('checktoken')
  .setDescription('Check if a Discord token is valid and its type')
  .addStringOption((option) =>
    option
      .setName('token')
      .setDescription('The Discord token to check')
      .setRequired(true)
  )

export async function execute(interaction: ChatInputCommandInteraction) {
  const token = interaction.options.get('token')?.value as string

  if (!token) {
    return interaction.reply({
      content: 'Please provide a token to check.',
      ephemeral: true,
    })
  }

  await interaction.deferReply({ ephemeral: true })

  const result = await checkToken(token)

  if (!result.isValid) {
    return interaction.editReply({
      content: `❌ **Token is invalid**\n\`\`\`\n${formatTokenForDisplay(token)}\n\`\`\`\n**Error:** ${result.error || 'Unknown error'}`,
    })
  }

  const tokenTypeEmoji = result.tokenType === 'bot' ? '🤖' : '👤'
  const tokenTypeLabel = result.tokenType === 'bot' ? 'Bot Token' : 'User Token'

  let response = `✅ **Token is valid** ${tokenTypeEmoji}\n`
  response += `**Type:** ${tokenTypeLabel}\n`
  response += `**Token:** \`${formatTokenForDisplay(token)}\`\n\n`

  if (result.userInfo) {
    response += `**Account Info:**\n`
    response += `- Username: ${result.userInfo.username}#${result.userInfo.discriminator}\n`
    response += `- ID: ${result.userInfo.id}\n`
    response += `- Bot: ${result.userInfo.bot ? 'Yes' : 'No'}\n`
  }

  // Add warning for user tokens
  if (result.tokenType === 'user') {
    response += `\n⚠️ **WARNING:** Using user tokens violates Discord's Terms of Service and may result in account termination.`
  }

  return interaction.editReply({
    content: response,
  })
}
