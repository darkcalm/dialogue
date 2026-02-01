/**
 * Shared types and utilities for CLI tools
 */

import { Client, TextChannel, ThreadChannel, Message } from 'discord.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as https from 'https'
import * as http from 'http'
import { exec } from 'child_process'
import { promisify } from 'util'
import { emojify as emojifyNode, get as getEmojiNode, has as hasEmojiNode } from 'node-emoji'
import stringWidth from 'string-width'
import config from '@/helpers/env'
import { IPlatformClient, IPlatformMessage, IPlatformChannel } from '@/platforms/types'
import {
  getCachedMessages,
  setCachedMessages,
  prependCachedMessages,
  isCacheStale,
} from './cache'

const execAsync = promisify(exec)

// ==================== Emoji Utilities ====================

/**
 * Convert emoji shortcodes to Unicode emojis in text
 * Uses node-emoji library for comprehensive shortcode support
 */
export const emojify = (text: string): string => {
  return emojifyNode(text)
}

/**
 * Get emoji by shortcode name (without colons)
 */
export const getEmoji = (name: string): string | null => {
  const result = getEmojiNode(`:${name}:`)
  if (result && result !== `:${name}:`) {
    return result
  }
  return null
}

/**
 * Check if a string contains emoji characters
 */
export const hasEmoji = (text: string): boolean => {
  return hasEmojiNode(text) || /\p{Emoji}/u.test(text)
}

/**
 * Get the visual width of a string (handles emoji width correctly)
 */
export const getStringWidth = (text: string): number => {
  return stringWidth(text)
}

const ELLIPSIS = '…'
const ELLIPSIS_WIDTH = stringWidth(ELLIPSIS)

/**
 * Truncate text to fit within maxWidth (in terminal columns).
 * Emoji and other wide chars count as 2. Appends … when truncated.
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth < ELLIPSIS_WIDTH) return ''
  const w = stringWidth(text)
  if (w <= maxWidth) return text
  let prefix = ''
  for (const c of text) {
    if (stringWidth(prefix + c) + ELLIPSIS_WIDTH > maxWidth) break
    prefix += c
  }
  return prefix + ELLIPSIS
}

// ==================== Interfaces ====================

export interface ChannelInfo {
  id: string
  name: string
  type: string
  guildName?: string
}

export interface ReplyInfo {
  author: string
  content: string // Truncated preview of the replied message
}

export interface AttachmentInfo {
  id: string
  name: string
  url: string
  size: number
}

export interface MessageInfo {
  id: string
  author: string
  authorId: string
  content: string
  timestamp: string
  date: Date
  isBot: boolean
  hasAttachments: boolean
  attachmentCount: number
  attachments: AttachmentInfo[]
  reactions: Array<{ emoji: string; count: number; name: string; users: string[] }>
  replyTo?: ReplyInfo // Information about the message being replied to
}

/**
 * Convert IPlatformMessage to MessageInfo for UI display
 */
export function platformMessageToMessageInfo(msg: IPlatformMessage): MessageInfo {
  return {
    id: msg.id,
    author: msg.author,
    authorId: msg.authorId,
    content: msg.content,
    timestamp: msg.timestamp,
    date: msg.date,
    isBot: msg.isBot,
    hasAttachments: msg.attachments.length > 0,
    attachmentCount: msg.attachments.length,
    attachments: msg.attachments.map(att => ({
      id: att.id,
      name: att.name,
      url: att.url,
      size: att.size,
    })),
    reactions: msg.reactions,
    replyTo: msg.replyTo,
  }
}

export interface ChannelVisitData {
  [channelId: string]: {
    lastVisited: string // ISO date string
    lastMessageId?: string
  }
}



// ==================== Visit Tracking ====================

const VISIT_DATA_PATH = path.join(os.homedir(), '.discord-cli-visits.json')

export const loadVisitData = (): ChannelVisitData => {
  try {
    if (fs.existsSync(VISIT_DATA_PATH)) {
      const data = fs.readFileSync(VISIT_DATA_PATH, 'utf-8')
      return JSON.parse(data)
    }
  } catch {
    // Ignore errors, return empty
  }
  return {}
}

export const saveVisitData = (data: ChannelVisitData): void => {
  try {
    fs.writeFileSync(VISIT_DATA_PATH, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('Failed to save visit data:', err)
  }
}

export const markChannelVisited = (channelId: string, lastMessageId?: string, platform?: string): void => {
  const data = loadVisitData()
  // Use platform-prefixed key if platform provided
  const key = platform ? `${platform}:${channelId}` : channelId
  data[key] = {
    lastVisited: new Date().toISOString(),
    lastMessageId,
  }
  saveVisitData(data)
}

export const removeChannelVisit = (channelId: string, platform?: string): void => {
  const data = loadVisitData()
  const key = platform ? `${platform}:${channelId}` : channelId
  delete data[key]
  // Also try to delete unprefixed key for backwards compatibility
  delete data[channelId]
  saveVisitData(data)
}

// ==================== Mention Formatting ====================

/**
 * Replace Discord mention format (<@userid> or <@!userid>) with readable @username
 */
export const formatMentions = (content: string, message: Message): string => {
  let formattedContent = content

  // Replace user mentions with @username
  const mentionRegex = /<@!?(\d+)>/g
  formattedContent = formattedContent.replace(mentionRegex, (match, userId) => {
    // Try to find the user in the message's mentions
    const user = message.mentions.users.get(userId)
    if (user) {
      return `@${user.displayName || user.username}`
    }
    // If not found, try the guild members (if in a guild)
    if (message.guild) {
      const member = message.guild.members.cache.get(userId)
      if (member) {
        return `@${member.displayName || member.user.username}`
      }
    }
    // Fallback to original mention if user can't be resolved
    return match
  })

  return formattedContent
}

// ==================== Message Loading (Platform-Agnostic) ====================

/**
 * Load messages from a channel using platform client
 * Uses cache-first strategy: returns cached messages immediately if available,
 * fetches from network only if cache is missing or stale
 */
export const loadMessagesFromPlatform = async (
  client: IPlatformClient,
  channelId: string,
  limit: number = 20,
  forceRefresh: boolean = false
): Promise<MessageInfo[]> => {
  const platform = client.type

  // Check cache first (unless force refresh)
  if (!forceRefresh) {
    const cached = getCachedMessages(platform, channelId)
    if (cached && !isCacheStale(platform, channelId)) {
      // Return most recent messages from cache
      const cachedMessages = cached.messages.slice(-limit)
      return cachedMessages
    }
  }

  // Fetch from network
  try {
    const platformMessages = await client.getMessages(channelId, limit)
    const result = platformMessages.map(platformMessageToMessageInfo)

    // Update cache
    setCachedMessages(platform, channelId, result, result.length >= limit)

    return result
  } catch (error) {
    console.error('❌ Error loading messages:', error)

    // Fall back to stale cache if available
    const cached = getCachedMessages(platform, channelId)
    if (cached) {
      return cached.messages.slice(-limit)
    }

    return []
  }
}

/**
 * Load older messages before a specific message ID
 * Uses cache and updates it with older messages
 */
export const loadOlderMessagesFromPlatform = async (
  client: IPlatformClient,
  channelId: string,
  beforeMessageId: string,
  limit: number = 20
): Promise<{ messages: MessageInfo[]; newCount: number; hasMore: boolean }> => {
  const platform = client.type

  try {
    const platformMessages = await client.getMessagesBefore(channelId, beforeMessageId, limit)
    const newMessages = platformMessages.map(platformMessageToMessageInfo)
    const hasMore = newMessages.length >= limit

    // Update cache with older messages
    const addedCount = prependCachedMessages(platform, channelId, newMessages, hasMore)

    // Return the full cached message list for the channel
    const cached = getCachedMessages(platform, channelId)
    return {
      messages: cached?.messages || newMessages,
      newCount: addedCount,
      hasMore,
    }
  } catch (error) {
    console.error('Error loading older messages:', error)
    return { messages: [], newCount: 0, hasMore: false }
  }
}

// ==================== Message Loading (Discord-Specific - Legacy) ====================

export const loadMessages = async (
  client: Client,
  channelInfo: ChannelInfo,
  messageObjects: Map<string, Message>,
  limit: number = 20
): Promise<MessageInfo[]> => {
  try {
    const channel = await client.channels.fetch(channelInfo.id)
    if (channel && channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
      const messages = await channel.messages.fetch({ limit })
      messageObjects.clear()
      
      const messagesArray = Array.from(messages.values()).reverse()
      
      // Build a map of message IDs to their info for reply lookups
      const messageMap = new Map<string, Message>()
      messagesArray.forEach(msg => messageMap.set(msg.id, msg))
      
      const result: MessageInfo[] = []
      
      for (const msg of messagesArray) {
        messageObjects.set(msg.id, msg)
        const authorName = msg.author.displayName || msg.author.username
        const botTag = msg.author.bot ? ' [BOT]' : ''
        
        const hasAttachments = msg.attachments.size > 0
        const attachmentCount = msg.attachments.size
        
        const reactions: Array<{ emoji: string; count: number; name: string; users: string[] }> = []
        if (msg.reactions.cache.size > 0) {
          for (const reaction of msg.reactions.cache.values()) {
            let emojiDisplay: string
            let emojiName: string
            
            if (reaction.emoji.id) {
              emojiName = reaction.emoji.name || 'unknown'
              emojiDisplay = `:${emojiName}:`
            } else {
              emojiName = reaction.emoji.name || reaction.emoji.toString()
              emojiDisplay = reaction.emoji.toString()
            }
            
            // Fetch users who reacted
            const users: string[] = []
            try {
              const reactionUsers = await reaction.users.fetch()
              reactionUsers.forEach(user => {
                users.push(user.displayName || user.username)
              })
            } catch {
              // If fetching users fails, continue without user list
            }
            
            reactions.push({
              emoji: emojiDisplay,
              count: reaction.count,
              name: emojiName,
              users,
            })
          }
        }
        
        // Check if this message is a reply
        let replyTo: ReplyInfo | undefined
        if (msg.reference && msg.reference.messageId) {
          try {
            // First check if the referenced message is in our current batch
            let referencedMsg = messageMap.get(msg.reference.messageId)
            
            // If not in batch, try to fetch it
            if (!referencedMsg) {
              referencedMsg = await channel.messages.fetch(msg.reference.messageId).catch(() => undefined)
            }
            
            if (referencedMsg) {
              const refAuthorName = referencedMsg.author.displayName || referencedMsg.author.username
              const refBotTag = referencedMsg.author.bot ? ' [BOT]' : ''
              let refContent = emojify(referencedMsg.content || '(no text content)')
              // Replace Discord mentions with readable @username format
              refContent = formatMentions(refContent, referencedMsg)
              // Truncate to 50 chars for preview
              const contentPreview = refContent.length > 50
                ? refContent.substring(0, 50) + '...'
                : refContent

              replyTo = {
                author: `${refAuthorName}${refBotTag}`,
                content: contentPreview.replace(/\n/g, ' '), // Replace newlines with spaces
              }
            }
          } catch {
            // Couldn't fetch referenced message, leave replyTo undefined
          }
        }
        
        const messageDate = new Date(msg.createdTimestamp)
        // Convert emoji shortcodes to Unicode in message content
        let processedContent = emojify(msg.content || '(no text content)')
        // Replace Discord mentions with readable @username format
        processedContent = formatMentions(processedContent, msg)

        result.push({
          id: msg.id,
          author: `${authorName}${botTag}`,
          authorId: msg.author.id,
          content: processedContent,
          timestamp: messageDate.toLocaleTimeString(),
          date: messageDate,
          isBot: msg.author.bot,
          hasAttachments,
          attachmentCount,
          reactions,
          replyTo,
        })
      }
      
      return result
    }
  } catch (err) {
    console.error('Error loading messages:', err)
  }
  return []
}

/**
 * Load older messages before a given message ID (for infinite scrolling)
 * Returns messages in chronological order (oldest first)
 */
export const loadOlderMessages = async (
  client: Client,
  channelInfo: ChannelInfo,
  beforeMessageId: string,
  messageObjects: Map<string, Message>,
  existingMessages: MessageInfo[],
  limit: number = 20
): Promise<MessageInfo[]> => {
  try {
    const channel = await client.channels.fetch(channelInfo.id)
    if (channel && channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
      const messages = await channel.messages.fetch({ limit, before: beforeMessageId })
      
      if (messages.size === 0) {
        return existingMessages // No more messages
      }
      
      const messagesArray = Array.from(messages.values()).reverse()
      
      // Build a map including both existing and new messages for reply lookups
      const messageMap = new Map<string, Message>()
      messagesArray.forEach(msg => messageMap.set(msg.id, msg))
      
      const newMessages: MessageInfo[] = []
      
      for (const msg of messagesArray) {
        messageObjects.set(msg.id, msg)
        const authorName = msg.author.displayName || msg.author.username
        const botTag = msg.author.bot ? ' [BOT]' : ''
        
        const hasAttachments = msg.attachments.size > 0
        const attachmentCount = msg.attachments.size
        
        const reactions: Array<{ emoji: string; count: number; name: string; users: string[] }> = []
        if (msg.reactions.cache.size > 0) {
          for (const reaction of msg.reactions.cache.values()) {
            let emojiDisplay: string
            let emojiName: string
            
            if (reaction.emoji.id) {
              emojiName = reaction.emoji.name || 'unknown'
              emojiDisplay = `:${emojiName}:`
            } else {
              emojiName = reaction.emoji.name || reaction.emoji.toString()
              emojiDisplay = reaction.emoji.toString()
            }
            
            // Fetch users who reacted
            const users: string[] = []
            try {
              const reactionUsers = await reaction.users.fetch()
              reactionUsers.forEach(user => {
                users.push(user.displayName || user.username)
              })
            } catch {
              // If fetching users fails, continue without user list
            }
            
            reactions.push({
              emoji: emojiDisplay,
              count: reaction.count,
              name: emojiName,
              users,
            })
          }
        }
        
        let replyTo: ReplyInfo | undefined
        if (msg.reference && msg.reference.messageId) {
          try {
            let referencedMsg = messageMap.get(msg.reference.messageId)
            
            if (!referencedMsg) {
              referencedMsg = await channel.messages.fetch(msg.reference.messageId).catch(() => undefined)
            }
            
            if (referencedMsg) {
              const refAuthorName = referencedMsg.author.displayName || referencedMsg.author.username
              const refBotTag = referencedMsg.author.bot ? ' [BOT]' : ''
              let refContent = emojify(referencedMsg.content || '(no text content)')
              // Replace Discord mentions with readable @username format
              refContent = formatMentions(refContent, referencedMsg)
              const contentPreview = refContent.length > 50
                ? refContent.substring(0, 50) + '...'
                : refContent

              replyTo = {
                author: `${refAuthorName}${refBotTag}`,
                content: contentPreview.replace(/\n/g, ' '),
              }
            }
          } catch {
            // Couldn't fetch referenced message
          }
        }
        
        const messageDate = new Date(msg.createdTimestamp)
        let processedContent = emojify(msg.content || '(no text content)')
        // Replace Discord mentions with readable @username format
        processedContent = formatMentions(processedContent, msg)

        newMessages.push({
          id: msg.id,
          author: `${authorName}${botTag}`,
          authorId: msg.author.id,
          content: processedContent,
          timestamp: messageDate.toLocaleTimeString(),
          date: messageDate,
          isBot: msg.author.bot,
          hasAttachments,
          attachmentCount,
          reactions,
          replyTo,
        })
      }
      
      // Prepend new messages to existing ones (older messages go first)
      return [...newMessages, ...existingMessages]
    }
  } catch (err) {
    console.error('Error loading older messages:', err)
  }
  return existingMessages
}

// ==================== URL Helpers ====================

export const extractUrls = (text: string): string[] => {
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}[^\s]*)/gi
  const matches = text.match(urlRegex)
  return matches ? matches.filter(url => {
    return url.length > 4 && (url.startsWith('http') || url.includes('.'))
  }) : []
}

export const openUrlInBrowser = async (url: string): Promise<void> => {
  const platform = os.platform()
  let command: string

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url
  }

  if (platform === 'darwin') {
    command = `open "${url}"`
  } else if (platform === 'win32') {
    command = `start "" "${url}"`
  } else {
    command = `xdg-open "${url}"`
  }

  await execAsync(command)
}

// ==================== Date Formatting ====================

export const formatDateHeader = (date: Date): string => {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  
  const messageDateStr = date.toDateString()
  const todayStr = today.toDateString()
  const yesterdayStr = yesterday.toDateString()
  
  if (messageDateStr === todayStr) {
    return 'Today'
  } else if (messageDateStr === yesterdayStr) {
    return 'Yesterday'
  } else {
    return date.toLocaleDateString('en-US', { 
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  }
}

// ==================== LLM Integration ====================

export const rewriteMessageWithLLM = async (text: string): Promise<string> => {
  if (!config.OPENROUTER_API_KEY || !config.OPENROUTER_MODEL) {
    return text
  }

  return await new Promise<string>((resolve) => {
    try {
      const data = JSON.stringify({
        model: config.OPENROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a message enhancement pipeline. Your task is to rewrite Discord messages to be clearer, friendlier, and more concise. ' +
              'CRITICAL: Return ONLY the rewritten message text. Do NOT include any prefixes, explanations, or meta-commentary like "Here\'s a clearer version:" or "Here\'s the rewritten message:". ' +
              'Just output the enhanced message text directly. ' +
              'Preserve the intent and meaning while improving wording and tone. ' +
              'This is a pipeline transformation, not a conversation - output only the processed text.',
          },
          {
            role: 'user',
            content: text,
          },
        ],
      })

      const options: https.RequestOptions = {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
          'Content-Length': Buffer.byteLength(data),
          'X-Title': 'dialogue-discord-cli',
        },
      }

      const req = https.request(options, (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            const rewritten =
              parsed?.choices?.[0]?.message?.content &&
              typeof parsed.choices[0].message.content === 'string'
                ? parsed.choices[0].message.content
                : text
            resolve(rewritten)
          } catch {
            resolve(text)
          }
        })
      })

      req.on('error', () => {
        resolve(text)
      })

      req.write(data)
      req.end()
    } catch {
      resolve(text)
    }
  })
}

// ==================== File Attachment ====================

export const attachFile = (
  filePath: string,
  attachedFiles: Array<{ path: string; name: string }>
): boolean => {
  try {
    let finalPath = filePath.trim()
    
    if (finalPath.startsWith('~')) {
      finalPath = finalPath.replace('~', os.homedir())
    }
    
    // Unescape terminal drag-and-drop format (handles \space, \(, \), \', etc.)
    finalPath = finalPath.replace(/\\(.)/g, '$1')
    
    finalPath = path.isAbsolute(finalPath) 
      ? path.normalize(finalPath)
      : path.resolve(finalPath)
    
    if (!fs.existsSync(finalPath)) {
      return false
    }

    const stats = fs.statSync(finalPath)
    if (!stats.isFile()) {
      return false
    }

    const fileName = path.basename(finalPath)
    attachedFiles.push({ path: finalPath, name: fileName })
    return true
  } catch {
    return false
  }
}

// ==================== Download Attachments ====================

export const downloadAttachments = async (
  message: Message,
  statusCallback: (msg: string) => void
): Promise<void> => {
  if (message.attachments.size === 0) {
    statusCallback('❌ Message has no attachments')
    return
  }

  const homeDir = os.homedir()
  const downloadsPath = path.join(homeDir, 'Downloads')
  
  if (!fs.existsSync(downloadsPath)) {
    fs.mkdirSync(downloadsPath, { recursive: true })
  }

  statusCallback(`📥 Downloading ${message.attachments.size} file(s)...`)

  const downloadPromises = Array.from(message.attachments.values()).map(async (attachment, index) => {
    const url = attachment.url
    const fileName = attachment.name || `attachment_${index + 1}`
    const filePath = path.join(downloadsPath, fileName)

    let finalPath = filePath
    let counter = 1
    while (fs.existsSync(finalPath)) {
      const ext = path.extname(fileName)
      const nameWithoutExt = path.basename(fileName, ext)
      finalPath = path.join(downloadsPath, `${nameWithoutExt}_${counter}${ext}`)
      counter++
    }

    return new Promise<void>((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      const file = fs.createWriteStream(finalPath)

      protocol.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          protocol.get(response.headers.location!, (redirectResponse) => {
            redirectResponse.pipe(file)
            file.on('finish', () => {
              file.close()
              resolve()
            })
          }).on('error', reject)
        } else {
          response.pipe(file)
          file.on('finish', () => {
            file.close()
            resolve()
          })
        }
      }).on('error', (err) => {
        fs.unlinkSync(finalPath)
        reject(err)
      })
    })
  })

  await Promise.all(downloadPromises)
  statusCallback(`✅ Downloaded ${message.attachments.size} file(s) to Downloads folder`)
}

/**
 * Download attachments from a MessageInfo (platform-agnostic)
 */
export const downloadAttachmentsFromInfo = async (
  attachments: AttachmentInfo[],
  statusCallback: (msg: string) => void
): Promise<void> => {
  if (attachments.length === 0) {
    statusCallback('❌ Message has no attachments')
    return
  }

  const homeDir = os.homedir()
  const downloadsPath = path.join(homeDir, 'Downloads')

  if (!fs.existsSync(downloadsPath)) {
    fs.mkdirSync(downloadsPath, { recursive: true })
  }

  statusCallback(`📥 Downloading ${attachments.length} file(s)...`)

  const downloadPromises = attachments.map(async (attachment, index) => {
    const url = attachment.url
    const fileName = attachment.name || `attachment_${index + 1}`
    const filePath = path.join(downloadsPath, fileName)

    let finalPath = filePath
    let counter = 1
    while (fs.existsSync(finalPath)) {
      const ext = path.extname(fileName)
      const nameWithoutExt = path.basename(fileName, ext)
      finalPath = path.join(downloadsPath, `${nameWithoutExt}_${counter}${ext}`)
      counter++
    }

    return new Promise<void>((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      const file = fs.createWriteStream(finalPath)

      protocol.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          protocol.get(response.headers.location!, (redirectResponse) => {
            redirectResponse.pipe(file)
            file.on('finish', () => {
              file.close()
              resolve()
            })
          }).on('error', reject)
        } else {
          response.pipe(file)
          file.on('finish', () => {
            file.close()
            resolve()
          })
        }
      }).on('error', (err) => {
        fs.unlink(finalPath, () => {}) // Clean up on error
        reject(err)
      })
    })
  })

  await Promise.all(downloadPromises)
  statusCallback(`✅ Downloaded ${attachments.length} file(s) to Downloads folder`)
}

// ==================== Emoji Resolution for Reactions ====================

export const resolveEmoji = async (
  input: string,
  channel: TextChannel | ThreadChannel
): Promise<string | null> => {
  const trimmed = input.trim()
  
  // Check if it's a custom emoji format <:name:id> or <a:name:id>
  const customMatch = trimmed.match(/^<a?:(\w+):(\d+)>$/)
  if (customMatch) {
    return customMatch[2] // Return just the ID
  }
  
  // Check if it's already a unicode emoji (single character or emoji sequence)
  if (/^\p{Emoji}/u.test(trimmed) && !trimmed.startsWith(':')) {
    return trimmed
  }
  
  // Check if it's in :name: format
  const nameMatch = trimmed.match(/^:(\w+):$/)
  if (nameMatch) {
    const emojiName = nameMatch[1]
    
    // Try to find custom emoji in the guild first
    const guild = channel.guild
    if (guild) {
      const customEmoji = guild.emojis.cache.find(
        e => e.name?.toLowerCase() === emojiName.toLowerCase()
      )
      if (customEmoji) {
        return customEmoji.id
      }
    }
    
    // Use node-emoji for shortcode lookup
    const unicodeEmoji = getEmoji(emojiName)
    if (unicodeEmoji) {
      return unicodeEmoji
    }
    
    return null
  }
  
  // Try without colons - maybe they typed just the name
  const unicodeEmoji = getEmoji(trimmed)
  if (unicodeEmoji) {
    return unicodeEmoji
  }
  
  // If it's just text without colons, try as-is (might be unicode)
  return trimmed || null
}


