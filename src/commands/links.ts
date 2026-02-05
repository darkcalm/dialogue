import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js'
import { SlashCommandBuilder } from '@discordjs/builders'
import {
  initLinksDB,
  syncLinksFromCache,
  getLinks,
  getLinksStats,
  hasLinksDB,
} from '@/cli/links-db'
import { initDBWithCache, hasLocalCache } from '@/cli/local-cache'
import { enableLocalCacheMode } from '@/cli/db'

export const data = new SlashCommandBuilder()
  .setName('links')
  .setDescription('Query the links database')
  .addSubcommand((subcommand) =>
    subcommand.setName('stats').setDescription('Show links database statistics')
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('list')
      .setDescription('List recent links')
      .addStringOption((option) =>
        option
          .setName('channel')
          .setDescription('Filter by channel name (substring match)')
          .setRequired(false)
      )
      .addIntegerOption((option) =>
        option
          .setName('count')
          .setDescription('Number of links to show (max 25)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(25)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('search')
      .setDescription('Search for links by URL pattern')
      .addStringOption((option) =>
        option
          .setName('pattern')
          .setDescription('URL pattern to search for (e.g., "youtube", "github.com")')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('channel')
          .setDescription('Filter by channel name (substring match)')
          .setRequired(false)
      )
      .addIntegerOption((option) =>
        option
          .setName('count')
          .setDescription('Number of results to show (max 25)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(25)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('sync').setDescription('Sync links from the message archive')
  )

async function ensureReady(): Promise<string | null> {
  if (!hasLocalCache()) {
    return 'No local cache available. The archive service needs to run first.'
  }

  try {
    await initDBWithCache()
    enableLocalCacheMode()
    await initLinksDB()
    return null
  } catch (err) {
    return `Failed to initialize: ${err instanceof Error ? err.message : 'Unknown error'}`
  }
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand()

  // Defer reply for potentially slow operations
  await interaction.deferReply()

  const error = await ensureReady()
  if (error) {
    return interaction.editReply(`❌ ${error}`)
  }

  try {
    switch (subcommand) {
      case 'stats': {
        if (!hasLinksDB()) {
          return interaction.editReply(
            '❌ Links database not found. Use `/links sync` first to build it.'
          )
        }

        const stats = await getLinksStats()

        const embed = new EmbedBuilder()
          .setTitle('🔗 Links Database Stats')
          .setColor(0x5865f2)
          .addFields(
            { name: 'Total Links', value: stats.totalLinks.toLocaleString(), inline: true },
            { name: 'Unique URLs', value: stats.uniqueUrls.toLocaleString(), inline: true },
            { name: 'Messages with Links', value: stats.uniqueMessages.toLocaleString(), inline: true },
            { name: 'Unique Authors', value: stats.uniqueAuthors.toLocaleString(), inline: true }
          )

        if (stats.oldestLink && stats.newestLink) {
          const oldest = new Date(stats.oldestLink).toLocaleDateString()
          const newest = new Date(stats.newestLink).toLocaleDateString()
          embed.addFields({ name: 'Date Range', value: `${oldest} → ${newest}`, inline: false })
        }

        return interaction.editReply({ embeds: [embed] })
      }

      case 'list': {
        if (!hasLinksDB()) {
          return interaction.editReply(
            '❌ Links database not found. Use `/links sync` first to build it.'
          )
        }

        const count = interaction.options.getInteger('count') || 10
        const channelFilter = interaction.options.getString('channel')
        const links = await getLinks({ limit: count, channelPattern: channelFilter || undefined })

        if (links.length === 0) {
          return interaction.editReply(channelFilter 
            ? `No links found in channels matching "${channelFilter}".`
            : 'No links found in the database.')
        }

        const title = channelFilter 
          ? `📋 Recent ${links.length} Links in "${channelFilter}"`
          : `📋 Recent ${links.length} Links`

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setColor(0x5865f2)

        const description = links
          .map((link) => {
            const date = new Date(link.timestamp).toLocaleDateString()
            const channel = link.channelName || 'unknown'
            const truncatedUrl =
              link.url.length > 60 ? link.url.substring(0, 57) + '...' : link.url
            return `**${link.authorName}** in #${channel} (${date})\n🔗 ${truncatedUrl}`
          })
          .join('\n\n')

        embed.setDescription(description.substring(0, 4096))

        return interaction.editReply({ embeds: [embed] })
      }

      case 'search': {
        if (!hasLinksDB()) {
          return interaction.editReply(
            '❌ Links database not found. Use `/links sync` first to build it.'
          )
        }

        const pattern = interaction.options.getString('pattern', true)
        const channelFilter = interaction.options.getString('channel')
        const count = interaction.options.getInteger('count') || 10
        const links = await getLinks({ 
          urlPattern: pattern, 
          channelPattern: channelFilter || undefined,
          limit: count 
        })

        if (links.length === 0) {
          const msg = channelFilter 
            ? `No links found matching "${pattern}" in channels matching "${channelFilter}".`
            : `No links found matching "${pattern}".`
          return interaction.editReply(msg)
        }

        const title = channelFilter
          ? `🔍 ${links.length} Links matching "${pattern}" in "${channelFilter}"`
          : `🔍 ${links.length} Links matching "${pattern}"`

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setColor(0x57f287)

        const description = links
          .map((link) => {
            const date = new Date(link.timestamp).toLocaleDateString()
            const channel = link.channelName || 'unknown'
            const truncatedUrl =
              link.url.length > 60 ? link.url.substring(0, 57) + '...' : link.url
            return `**${link.authorName}** in #${channel} (${date})\n🔗 ${truncatedUrl}`
          })
          .join('\n\n')

        embed.setDescription(description.substring(0, 4096))

        return interaction.editReply({ embeds: [embed] })
      }

      case 'sync': {
        const { added, total } = await syncLinksFromCache()

        const embed = new EmbedBuilder()
          .setTitle('🔄 Links Sync Complete')
          .setColor(0x57f287)
          .addFields(
            { name: 'New Links Added', value: added.toLocaleString(), inline: true },
            { name: 'Total Links', value: total.toLocaleString(), inline: true }
          )

        return interaction.editReply({ embeds: [embed] })
      }

      default:
        return interaction.editReply('Unknown subcommand.')
    }
  } catch (err) {
    console.error('Links command error:', err)
    return interaction.editReply(
      `❌ Error: ${err instanceof Error ? err.message : 'Unknown error'}`
    )
  }
}
