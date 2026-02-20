import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js'

export interface HeartbeatSkill {
  id: string
  name: string
  description: string
  usage: string
}

export const HEARTBEAT_SKILLS: HeartbeatSkill[] = [
  {
    id: 'archive-search',
    name: 'Archive Search',
    description: 'Finds related past messages in the archive.',
    usage: 'Used automatically when building reply views.',
  },
  {
    id: 'web-search',
    name: 'Web Search',
    description: 'Pulls a few external references for context.',
    usage: 'Used automatically when building reply views.',
  },
  {
    id: 'curiosity-ranking',
    name: 'Curiosity Ranking',
    description: 'Scores how interesting a reply idea is.',
    usage: 'Used automatically to rank reply views.',
  },
  {
    id: 'reply-synthesis',
    name: 'Reply Synthesis',
    description: 'Drafts a short reply from the best signals.',
    usage: 'Used automatically when building reply views.',
  },
  {
    id: 'reply-view-synthesis',
    name: 'Reply View Assembly',
    description: 'Collects references, scores, and draft into one view.',
    usage: 'Used automatically when building reply views.',
  },
]

export interface SkillCommand {
  data: SlashCommandBuilder
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>
}

const buildSkillCommand = (skill: HeartbeatSkill): SkillCommand => ({
  data: new SlashCommandBuilder()
    .setName(`heartbeat-${skill.id}`)
    .setDescription(`Heartbeat skill: ${skill.name}`),
  execute: async (interaction: ChatInputCommandInteraction) => {
    const content = `${skill.name}: ${skill.description}\nUsage: ${skill.usage}`
    await interaction.reply({ content, ephemeral: true })
  },
})

export const heartbeatSkillsCommand: SkillCommand = {
  data: new SlashCommandBuilder()
    .setName('heartbeat-skills')
    .setDescription('List heartbeat skills'),
  execute: async (interaction: ChatInputCommandInteraction) => {
    const lines = HEARTBEAT_SKILLS.map(skill => `/heartbeat-${skill.id} — ${skill.name}`)
    const content = lines.length > 0 ? lines.join('\n') : 'No heartbeat skills registered.'
    await interaction.reply({ content, ephemeral: true })
  },
}

export const heartbeatSkillCommands: SkillCommand[] = HEARTBEAT_SKILLS.map(buildSkillCommand)
