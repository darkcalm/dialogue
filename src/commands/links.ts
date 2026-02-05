import { ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js'
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

// Store search results for copy functionality
const searchCache = new Map<string, string>()

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
          .setDescription('Filter by channel or thread name (substring match)')
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
      .setDescription('Search for links by URL text or channel')
      .addStringOption((option) =>
        option
          .setName('url')
          .setDescription('Text to search for within URLs (e.g., "youtube", "github.com")')
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName('channel')
          .setDescription('Filter by channel or thread name (substring match)')
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

function generateLinksText(links: any[]): string {
  return links
    .map((link) => {
      const date = new Date(link.timestamp).toLocaleDateString()
      const channel = link.channelName || 'unknown'
      const author = link.authorName || 'unknown'
      return `${link.url} | #${channel} | ${author} | ${date}`
    })
    .join('\n')
}

function createActionButtons(cacheKey: string) {
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`links_copy_${cacheKey}`)
        .setLabel('📋 Copy Links')
        .setStyle(ButtonStyle.Secondary)
    )
  return row
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

        const urlPattern = interaction.options.getString('url')
        const channelFilter = interaction.options.getString('channel')

        console.log(`🔍 Search: url="${urlPattern}", channel="${channelFilter}"`)

        // Require at least one filter
        if (!urlPattern && !channelFilter) {
          return interaction.editReply(
            '❌ Please provide at least one filter: `url` or `channel`'
          )
        }

        const links = await getLinks({
          urlPattern: urlPattern || undefined,
          channelPattern: channelFilter || undefined,
          limit: 10000 // Get all results
        })

        if (links.length === 0) {
          let msg = 'No links found'
          if (urlPattern && channelFilter) {
            msg += ` with URLs matching "${urlPattern}" in channels matching "${channelFilter}".`
          } else if (urlPattern) {
            msg += ` with URLs matching "${urlPattern}".`
          } else if (channelFilter) {
            msg += ` in channels matching "${channelFilter}".`
          }
          return interaction.editReply(msg)
        }

        // Generate text content and file
        const linksText = generateLinksText(links)
        const file = new AttachmentBuilder(Buffer.from(linksText, 'utf-8'), { name: 'links.txt' })

        // Cache for copy button
        const cacheKey = `${interaction.user.id}_${urlPattern || ''}_${channelFilter || ''}`
        searchCache.set(cacheKey, linksText)

        // Create summary embed
        let title = `🔍 Found ${links.length} Link${links.length === 1 ? '' : 's'}`
        if (urlPattern && channelFilter) {
          title += ` (URL: "${urlPattern}", Channel: "${channelFilter}")`
        } else if (urlPattern) {
          title += ` (URL: "${urlPattern}")`
        } else if (channelFilter) {
          title += ` (Channel: "${channelFilter}")`
        }

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setColor(0x57f287)
          .setDescription(`📥 Download **links.txt** below or use the Copy button`)

        const buttons = createActionButtons(cacheKey)

        return interaction.editReply({
          embeds: [embed],
          files: [file],
          components: [buttons]
        })
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

// Handle button interactions for copy
export async function handleButton(interaction: any) {
  if (!interaction.customId.startsWith('links_copy_')) return

  try {
    const cacheKey = interaction.customId.replace('links_copy_', '')
    const linksText = searchCache.get(cacheKey)

    if (!linksText) {
      return interaction.reply({ content: '❌ Search cache expired. Run the search again.', ephemeral: true })
    }

    // Create code block with the links
    const codeBlock = '```\n' + linksText + '\n```'
    const maxLength = 2000

    if (codeBlock.length > maxLength) {
      // Too long for a message, send as file instead
      const file = new AttachmentBuilder(Buffer.from(linksText, 'utf-8'), { name: 'links.txt' })
      return interaction.reply({ files: [file], ephemeral: true })
    }

    interaction.reply({ content: codeBlock, ephemeral: true })
  } catch (err) {
    console.error('Button interaction error:', err)
    interaction.reply({ content: '❌ Error copying links', ephemeral: true })
  }
}
