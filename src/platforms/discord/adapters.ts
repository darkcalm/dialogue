/**
 * Discord type adapters - convert Discord.js types to platform interfaces
 */

import {
  TextChannel,
  ThreadChannel,
  DMChannel,
  Message,
  Reaction,
  User,
  MessageReaction,
  PartialMessageReaction,
} from 'discord.js'
import {
  IPlatformChannel,
  IPlatformMessage,
  IAttachment,
  IReaction,
  IMessageReference,
} from '../types'

// ==================== Channel Adapters ====================

/**
 * Convert Discord.js channel to platform channel interface
 */
export function adaptDiscordChannel(
  channel: TextChannel | ThreadChannel | DMChannel
): IPlatformChannel {
  // Determine channel type
  let type: 'text' | 'dm' | 'group' | 'thread'
  if (channel.isTextBased()) {
    if (channel.isDMBased()) {
      type = 'dm'
    } else if (channel.isThread()) {
      type = 'thread'
    } else {
      type = 'text'
    }
  } else {
    type = 'text' // Fallback
  }

  // Get parent name (guild name for text channels)
  let parentName: string | undefined
  if ('guild' in channel && channel.guild) {
    parentName = channel.guild.name
  }

  return {
    id: channel.id,
    name: channel.isThread() ? channel.name : ('name' in channel ? channel.name : 'DM'),
    type,
    platform: 'discord',
    parentName,
    metadata: {
      nativeChannel: channel,
    },
  }
}

// ==================== Message Adapters ====================

/**
 * Convert Discord.js attachment to platform attachment interface
 */
function adaptDiscordAttachment(attachment: Message['attachments'] extends Map<string, infer A> ? A : never): IAttachment {
  return {
    id: attachment.id,
    name: attachment.name || 'attachment',
    url: attachment.url,
    size: attachment.size,
    contentType: attachment.contentType || undefined,
    width: attachment.width || undefined,
    height: attachment.height || undefined,
  }
}

/**
 * Extract reaction information from a Discord.js message
 */
async function adaptDiscordReactions(message: Message): Promise<IReaction[]> {
  const reactions: IReaction[] = []

  for (const [, reaction] of message.reactions.cache) {
    // Fetch users who reacted (if not already fetched)
    let users: User[]
    try {
      const fetchedUsers = await reaction.users.fetch()
      users = Array.from(fetchedUsers.values())
    } catch {
      users = []
    }

    // Get emoji representation
    const emoji = reaction.emoji.name || '?'
    const emojiName = reaction.emoji.id
      ? `:${reaction.emoji.name || 'custom'}:`
      : emoji

    reactions.push({
      emoji,
      count: reaction.count || 0,
      name: emojiName,
      users: users.map(u => u.id),
    })
  }

  return reactions
}

/**
 * Extract reply information from a Discord.js message reference
 */
async function adaptDiscordReplyInfo(message: Message): Promise<IMessageReference | undefined> {
  if (!message.reference || !message.reference.messageId) {
    return undefined
  }

  try {
    const referencedMessage = await message.channel.messages.fetch(message.reference.messageId)

    // Truncate content for preview (max 100 chars)
    const content = referencedMessage.content.length > 100
      ? referencedMessage.content.substring(0, 97) + '...'
      : referencedMessage.content

    return {
      messageId: referencedMessage.id,
      author: referencedMessage.author.username,
      content,
    }
  } catch {
    // Message not found or inaccessible
    return undefined
  }
}

/**
 * Convert Discord.js message to platform message interface
 */
export async function adaptDiscordMessage(message: Message): Promise<IPlatformMessage> {
  // Get reactions
  const reactions = await adaptDiscordReactions(message)

  // Get reply info
  const replyTo = await adaptDiscordReplyInfo(message)

  // Convert attachments
  const attachments = Array.from(message.attachments.values()).map(adaptDiscordAttachment)

  return {
    id: message.id,
    channelId: message.channelId,
    author: message.author.username,
    authorId: message.author.id,
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    date: message.createdAt,
    isBot: message.author.bot,
    attachments,
    reactions,
    replyTo,
    metadata: {
      nativeMessage: message,
    },
  }
}

/**
 * Convert Discord.js message synchronously (without fetching additional data)
 * Use this when you need quick conversion without async operations
 * Note: reactions and replyTo will be limited/empty
 */
export function adaptDiscordMessageSync(message: Message): IPlatformMessage {
  // Get reactions without fetching users
  const reactions: IReaction[] = []
  for (const [, reaction] of message.reactions.cache) {
    const emoji = reaction.emoji.name || '?'
    const emojiName = reaction.emoji.id
      ? `:${reaction.emoji.name || 'custom'}:`
      : emoji

    reactions.push({
      emoji,
      count: reaction.count || 0,
      name: emojiName,
      users: [], // Would need async fetch
    })
  }

  // Convert attachments
  const attachments = Array.from(message.attachments.values()).map(adaptDiscordAttachment)

  // Basic reply info without fetching
  let replyTo: IMessageReference | undefined
  if (message.reference?.messageId) {
    replyTo = {
      messageId: message.reference.messageId,
      author: 'Unknown', // Would need async fetch
      content: '', // Would need async fetch
    }
  }

  return {
    id: message.id,
    channelId: message.channelId,
    author: message.author.username,
    authorId: message.author.id,
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    date: message.createdAt,
    isBot: message.author.bot,
    attachments,
    reactions,
    replyTo,
    metadata: {
      nativeMessage: message,
    },
  }
}
