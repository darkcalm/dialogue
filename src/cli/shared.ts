/**
 * Shared types and utilities for CLI tools
 */

import { Client, TextChannel, ThreadChannel, Message } from 'discord.js'
import * as blessed from 'blessed'
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
  reactions: Array<{ emoji: string; count: number; name: string }>
  replyTo?: ReplyInfo // Information about the message being replied to
}

export interface ChannelVisitData {
  [channelId: string]: {
    lastVisited: string // ISO date string
    lastMessageId?: string
  }
}

// ==================== State Management ====================

export interface AppState {
  client: Client
  screen: blessed.Widgets.Screen
  channelList: ChannelInfo[]
  selectedChannelIndex: number
  selectedChannel: ChannelInfo
  recentMessages: MessageInfo[]
  messageObjects: Map<string, Message>
  messageScrollIndex: number
  selectedMessageIndex: number
  currentMode: 'channel-select' | 'messages' | 'input' | 'react-input' | 'llm-review'
  replyingToMessage: Message | null
  attachedFiles: Array<{ path: string; name: string }>
  llmOriginalText: string
  llmProcessedText: string
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

export const markChannelVisited = (channelId: string, lastMessageId?: string): void => {
  const data = loadVisitData()
  data[channelId] = {
    lastVisited: new Date().toISOString(),
    lastMessageId,
  }
  saveVisitData(data)
}

// ==================== Message Loading ====================

export const loadMessages = async (
  client: Client,
  channelInfo: ChannelInfo,
  messageObjects: Map<string, Message>
): Promise<MessageInfo[]> => {
  try {
    const channel = await client.channels.fetch(channelInfo.id)
    if (channel && channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
      const messages = await channel.messages.fetch({ limit: 20 })
      messageObjects.clear()
      
      const messagesArray = Array.from(messages.values()).slice(0, 15).reverse()
      
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
        
        const reactions: Array<{ emoji: string; count: number; name: string }> = []
        if (msg.reactions.cache.size > 0) {
          msg.reactions.cache.forEach(reaction => {
            let emojiDisplay: string
            let emojiName: string
            
            if (reaction.emoji.id) {
              emojiName = reaction.emoji.name || 'unknown'
              emojiDisplay = `:${emojiName}:`
            } else {
              emojiName = reaction.emoji.name || reaction.emoji.toString()
              emojiDisplay = reaction.emoji.toString()
            }
            reactions.push({
              emoji: emojiDisplay,
              count: reaction.count,
              name: emojiName,
            })
          })
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
              const refContent = emojify(referencedMsg.content || '(no text content)')
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
        const processedContent = emojify(msg.content || '(no text content)')
        
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
    
    // Unescape terminal drag-and-drop format
    finalPath = finalPath.replace(/\\ /g, ' ')
    
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

// ==================== UI Components Factory ====================

export interface UIComponents {
  screen: blessed.Widgets.Screen
  statusBox: blessed.Widgets.BoxElement
  channelListBox: blessed.Widgets.ListElement
  messagesBox: blessed.Widgets.BoxElement
  inputBox: blessed.Widgets.TextboxElement
  reactionInputBox: blessed.Widgets.TextboxElement
  llmPreviewBox: blessed.Widgets.BoxElement
  attachmentsBox: blessed.Widgets.BoxElement
}

export const createUIComponents = (title: string): UIComponents => {
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title,
  })

  const statusBox = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: `${title} - Loading...`,
    style: {
      fg: 'white',
      bg: 'blue',
    },
  })

  const channelListBox = blessed.list({
    top: 1,
    left: 0,
    width: '40%',
    height: '90%',
    border: { type: 'line' },
    label: ' Channels ',
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      selected: { bg: 'blue', fg: 'white' },
      item: { fg: 'white' },
    },
  })

  const messagesBox = blessed.box({
    top: 1,
    left: '40%',
    width: '60%',
    height: '77%',
    border: { type: 'line' },
    label: ' Messages ',
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    vi: true,
    style: {
      fg: 'white',
    },
  })

  const llmPreviewBox = blessed.box({
    top: '77%',
    left: '40%',
    width: '60%',
    height: 4,
    content: '',
    hidden: true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      fg: 'magenta',
      bg: 'blue',
    },
  })

  const attachmentsBox = blessed.box({
    top: '85%',
    left: '40%',
    width: '60%',
    height: 3,
    content: '',
    scrollable: true,
    alwaysScroll: true,
    hidden: true,
    style: {
      fg: 'cyan',
      bg: 'blue',
    },
  })

  const inputBox = blessed.textbox({
    bottom: 0,
    left: '40%',
    width: '60%',
    height: 3,
    border: { type: 'line' },
    label: ' Type message: ',
    inputOnFocus: true,
    keys: true,
    mouse: true,
    hidden: false,
    style: {
      fg: 'white',
    },
  })

  const reactionInputBox = blessed.textbox({
    bottom: 0,
    left: '40%',
    width: '60%',
    height: 3,
    border: { type: 'line' },
    label: ' Emoji (e.g., 🐙 or :octopus: or <:custom:id>): ',
    inputOnFocus: true,
    keys: true,
    mouse: true,
    hidden: true,
    style: {
      fg: 'white',
    },
  })

  return {
    screen,
    statusBox,
    channelListBox,
    messagesBox,
    inputBox,
    reactionInputBox,
    llmPreviewBox,
    attachmentsBox,
  }
}
