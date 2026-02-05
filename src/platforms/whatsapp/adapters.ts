/**
 * WhatsApp type adapters - convert Baileys types to platform interfaces
 */

import { WASocket, WAMessage, Chat, proto } from '@whiskeysockets/baileys'
import {
  IPlatformChannel,
  IPlatformMessage,
  IAttachment,
  IReaction,
  IMessageReference,
} from '../types'

// ==================== Chat/Channel Adapters ====================

/**
 * Convert Baileys chat to platform channel interface
 */
export function adaptWhatsAppChat(chat: Chat): IPlatformChannel {
  // Determine channel type
  let type: 'text' | 'dm' | 'group' | 'thread'
  const chatId = chat.id || ''
  if (chatId.endsWith('@g.us')) {
    type = 'group' // Group chat
  } else if (chatId.endsWith('@s.whatsapp.net')) {
    type = 'dm' // 1-on-1 chat
  } else {
    type = 'dm' // Default to DM
  }

  // Extract name
  let name = chat.name || chatId
  // Try to clean up the ID if no name is available
  if (!chat.name) {
    const phoneNumber = chatId.split('@')[0]
    name = phoneNumber
  }

  return {
    id: chatId,
    name,
    type,
    platform: 'whatsapp',
    parentName: undefined, // WhatsApp has no guild/server concept
    metadata: {
      nativeChat: chat,
      unreadCount: chat.unreadCount || 0,
    },
  }
}

// ==================== Message Adapters ====================

/**
 * Extract message content from various message types
 */
function extractMessageContent(message: proto.IWebMessageInfo): string {
  const msg = message.message
  if (!msg) return ''

  // Text message
  if (msg.conversation) {
    return msg.conversation
  }

  // Extended text message (with link previews, etc.)
  if (msg.extendedTextMessage?.text) {
    return msg.extendedTextMessage.text
  }

  // Image with caption
  if (msg.imageMessage?.caption) {
    return msg.imageMessage.caption
  }

  // Video with caption
  if (msg.videoMessage?.caption) {
    return msg.videoMessage.caption
  }

  // Document with caption
  if (msg.documentMessage?.caption) {
    return msg.documentMessage.caption
  }

  // Sticker (no text)
  if (msg.stickerMessage) {
    return '[Sticker]'
  }

  // Audio message
  if (msg.audioMessage) {
    return '[Audio]'
  }

  // Location message
  if (msg.locationMessage) {
    return '[Location]'
  }

  // Contact message
  if (msg.contactMessage) {
    return '[Contact]'
  }

  return ''
}

/**
 * Extract attachments from message
 */
function extractAttachments(message: proto.IWebMessageInfo): IAttachment[] {
  const msg = message.message
  if (!msg || !message.key) return []

  const attachments: IAttachment[] = []
  const messageId = message.key.id || 'unknown'

  // Image
  if (msg.imageMessage) {
    attachments.push({
      id: messageId || 'image',
      name: msg.imageMessage.caption || 'image.jpg',
      url: msg.imageMessage.url || '',
      size: Number(msg.imageMessage.fileLength) || 0,
      contentType: msg.imageMessage.mimetype || undefined,
      width: msg.imageMessage.width || undefined,
      height: msg.imageMessage.height || undefined,
    })
  }

  // Video
  if (msg.videoMessage) {
    attachments.push({
      id: messageId || 'video',
      name: msg.videoMessage.caption || 'video.mp4',
      url: msg.videoMessage.url || '',
      size: Number(msg.videoMessage.fileLength) || 0,
      contentType: msg.videoMessage.mimetype || undefined,
      width: msg.videoMessage.width || undefined,
      height: msg.videoMessage.height || undefined,
    })
  }

  // Document
  if (msg.documentMessage) {
    attachments.push({
      id: messageId || 'document',
      name: msg.documentMessage.fileName || 'document',
      url: msg.documentMessage.url || '',
      size: Number(msg.documentMessage.fileLength) || 0,
      contentType: msg.documentMessage.mimetype || undefined,
    })
  }

  // Audio
  if (msg.audioMessage) {
    attachments.push({
      id: messageId || 'audio',
      name: 'audio.ogg',
      url: msg.audioMessage.url || '',
      size: Number(msg.audioMessage.fileLength) || 0,
      contentType: msg.audioMessage.mimetype || undefined,
    })
  }

  return attachments
}

/**
 * Extract reactions from message
 */
function extractReactions(message: proto.IWebMessageInfo): IReaction[] {
  const reactions: IReaction[] = []

  // Note: Baileys reactions are handled differently - they come as separate messages
  // For now, we'll return empty and handle reactions via message updates
  // TODO: Implement reaction tracking

  return reactions
}

/**
 * Extract reply information
 */
function extractReplyInfo(message: proto.IWebMessageInfo): IMessageReference | undefined {
  const contextInfo = message.message?.extendedTextMessage?.contextInfo

  if (contextInfo?.quotedMessage) {
    // Extract quoted message content
    let content = ''
    const quotedMsg = contextInfo.quotedMessage
    if (quotedMsg.conversation) {
      content = quotedMsg.conversation
    } else if (quotedMsg.extendedTextMessage?.text) {
      content = quotedMsg.extendedTextMessage.text
    }

    // Truncate for preview
    if (content.length > 100) {
      content = content.substring(0, 97) + '...'
    }

    return {
      messageId: contextInfo.stanzaId || '',
      author: contextInfo.participant || 'Unknown',
      content,
    }
  }

  return undefined
}

/**
 * Convert Baileys message to platform message interface
 */
export function adaptWhatsAppMessage(
  message: proto.IWebMessageInfo,
  chatId: string
): IPlatformMessage {
  // Extract sender info
  const pushName = message.pushName || 'Unknown'
  const messageKey = message.key || {}
  const senderId = messageKey.participant || messageKey.remoteJid || chatId

  // Extract content
  const content = extractMessageContent(message)

  // Extract timestamp
  const timestamp = message.messageTimestamp
    ? new Date(Number(message.messageTimestamp) * 1000)
    : new Date()

  // Extract attachments
  const attachments = extractAttachments(message)

  // Extract reactions
  const reactions = extractReactions(message)

  // Extract reply info
  const replyTo = extractReplyInfo(message)

  return {
    id: messageKey.id || '',
    channelId: chatId,
    author: pushName,
    authorId: senderId,
    content,
    timestamp: timestamp.toISOString(),
    date: timestamp,
    isBot: false, // WhatsApp doesn't have bots in the same way
    attachments,
    reactions,
    replyTo,
    embeds: [],
    stickers: [],
    metadata: {
      nativeMessage: message,
      fromMe: messageKey.fromMe || false,
    },
  }
}

/**
 * Check if a message is from the current user
 */
export function isMessageFromMe(message: proto.IWebMessageInfo): boolean {
  return message.key?.fromMe || false
}

/**
 * Get phone number from JID (WhatsApp ID)
 */
export function getPhoneFromJid(jid: string): string {
  return jid.split('@')[0]
}

/**
 * Create JID from phone number for DM
 */
export function createDmJid(phone: string): string {
  return `${phone}@s.whatsapp.net`
}

/**
 * Check if JID is a group
 */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us')
}
