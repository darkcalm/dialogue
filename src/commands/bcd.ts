import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandStringOption,
  SlashCommandIntegerOption,
} from 'discord.js'
import { Protocols, parsePayload } from '@/helpers/bcd/presets'
import { getSession, deleteSession } from '@/helpers/bcd/sessionAgent'

export const data = new SlashCommandBuilder()
  .setName('bcd')
  .setDescription('Generate dialogues. Update dialogues through replies. Use /bcd to see the list of dialogues.')
  .addStringOption((option: SlashCommandStringOption) =>
    option
      .setName('see_keys')
      .setDescription('(optional) provides a sample of an assign for the dialogue in dm')
      .setRequired(false)
      .addChoices(
        ...Object.keys(Protocols).map((name) => ({
          name,
          value: name,
        }))
      )
  )
  .addStringOption((option: SlashCommandStringOption) =>
    option
      .setName('diagram')
      .setDescription('choose which dialogue to assign to')
      .setRequired(false)
      .addChoices(
        ...Object.keys(Protocols).map((name) => ({
          name,
          value: name,
        }))
      )
  )
  .addStringOption((option: SlashCommandStringOption) =>
    option
      .setName('assign')
      .setDescription('recommend: key content; key content etc.')
      .setRequired(false)
  )
  .addIntegerOption((option: SlashCommandIntegerOption) =>
    option
      .setName('publish')
      .setDescription('send bcd outputs publicly')
      .setRequired(false)
      .addChoices(
        { name: 'private', value: 0 },
        { name: 'public', value: 1 }
      )
  )

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply()

  const seeKeys = interaction.options.get('see_keys')?.value as string | undefined
  const diagram = interaction.options.get('diagram')?.value as string | undefined
  const assign = interaction.options.get('assign')?.value as string | undefined
  const publish = (interaction.options.get('publish')?.value as number) || 0

  // Show keys for a diagram
  if (seeKeys && Protocols[seeKeys]) {
    const protocol = Protocols[seeKeys]
    const keyList = Object.entries(protocol.keys)
      .map(([k, v]) => `${k} ${v.join(' ')}`)
      .join('; ')

    await interaction.followUp({
      content: `${seeKeys} <> ${keyList}`,
      ephemeral: true,
    })
    return
  }

  // Generate diagram
  if (diagram || assign) {
    const diagramName = diagram || ''
    const assignText = assign || ''
    // Match original: diagram+" <> " format
    const payloadInput = diagramName ? `${diagramName} <> ${assignText}` : assignText

    const payload = parsePayload(payloadInput)

    if (!payload) {
      await interaction.followUp({
        content: '❌ Invalid dialogue or assignment format.',
        ephemeral: true,
      })
      return
    }

    // Use interaction token/id for session (matching original behavior)
    const session = getSession(interaction.id)
    await session.output(interaction, payload, publish === 1)
    deleteSession(interaction.id)
    return
  }

  // Default: show unresponsive message
  try {
    await interaction.user.send('🤔 unresponsive to input')
    await interaction.followUp({
      content: 'Sent you a DM!',
      ephemeral: true,
    })
  } catch (error) {
    await interaction.followUp({
      content: '🤔 unresponsive to input',
      ephemeral: true,
    })
  }
}
