/**
 * Platform abstraction types for multi-platform messaging support
 * Provides a unified interface for Discord, WhatsApp, and future platforms
 */

// ==================== Platform Types ====================

export type PlatformType = 'discord' | 'whatsapp'

// ==================== Channel/Chat Abstraction ====================

/**
 * Platform-agnostic channel/chat representation
 */
export interface IPlatformChannel {
  id: string
  name: string
  type: 'text' | 'dm' | 'group' | 'thread'
  platform: PlatformType
  parentName?: string // Guild name for Discord, null for WhatsApp
  metadata?: Record<string, any> // Platform-specific data
}

// ==================== Message Abstraction ====================

/**
 * Information about a message being replied to
 */
export interface IMessageReference {
  messageId: string
  author: string
  content: string // Truncated preview
}

/**
 * Attachment/media file
 */
export interface IAttachment {
  id: string
  name: string
  url: string
  size: number
  contentType?: string
  width?: number
  height?: number
}

/**
 * Reaction to a message
 */
export interface IReaction {
  emoji: string
  count: number
  name: string // Emoji name/shortcode
  users: string[] // User IDs who reacted
}

/**
 * Platform-agnostic message representation
 */
export interface IPlatformMessage {
  id: string
  channelId: string
  author: string
  authorId: string
  content: string
  timestamp: string // ISO 8601 format
  date: Date
  isBot: boolean
  attachments: IAttachment[]
  reactions: IReaction[]
  replyTo?: IMessageReference
  metadata?: Record<string, any> // Platform-specific data
}

// ==================== Message Sending ====================

/**
 * Options for sending a message
 */
export interface SendMessageOptions {
  content: string
  channelId: string
  replyToMessageId?: string
  attachments?: Array<{
    path?: string
    url?: string
    name: string
  }>
}

// ==================== Platform Client Interface ====================

/**
 * Core platform client interface
 * All platform implementations must implement this interface
 */
export interface IPlatformClient {
  readonly type: PlatformType
  readonly isConnected: boolean

  /**
   * Connect to the platform (authenticate and establish connection)
   */
  connect(): Promise<void>

  /**
   * Disconnect from the platform
   */
  disconnect(): Promise<void>

  /**
   * Get all accessible channels/chats
   */
  getChannels(): Promise<IPlatformChannel[]>

  /**
   * Get a specific channel by ID
   */
  getChannel(channelId: string): Promise<IPlatformChannel | null>

  /**
   * Get messages from a channel (most recent first)
   * @param limit - Maximum number of messages to fetch
   */
  getMessages(channelId: string, limit?: number): Promise<IPlatformMessage[]>

  /**
   * Get older messages before a specific message ID
   * @param beforeMessageId - Fetch messages before this message
   * @param limit - Maximum number of messages to fetch
   */
  getMessagesBefore(
    channelId: string,
    beforeMessageId: string,
    limit?: number
  ): Promise<IPlatformMessage[]>

  /**
   * Send a message to a channel
   */
  sendMessage(options: SendMessageOptions): Promise<IPlatformMessage>

  /**
   * Add a reaction to a message
   */
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>

  /**
   * Remove a reaction from a message
   */
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>

  /**
   * Delete a message (if supported and authorized)
   */
  deleteMessage(channelId: string, messageId: string): Promise<void>

  /**
   * Get users who reacted with a specific emoji
   */
  getReactionUsers(
    channelId: string,
    messageId: string,
    emoji: string
  ): Promise<Array<{ id: string; username: string }>>

  /**
   * Get the current user's info
   */
  getCurrentUser(): { id: string; username: string } | null

  /**
   * Get access to the native client for platform-specific operations
   * Use sparingly - prefer using the abstraction layer
   */
  getNativeClient(): any

  /**
   * Listen for new messages (real-time updates)
   */
  onMessage(callback: (message: IPlatformMessage) => void): void

  /**
   * Listen for message updates (edits, reactions, etc.)
   */
  onMessageUpdate(callback: (message: IPlatformMessage) => void): void

  /**
   * Listen for message deletions
   */
  onMessageDelete(callback: (channelId: string, messageId: string) => void): void
}

// ==================== Visit Tracking ====================

/**
 * Format for visit tracking keys: "platform:channelId"
 * Examples: "discord:123456789", "whatsapp:1234567890@s.whatsapp.net"
 */
export function createVisitKey(platform: PlatformType, channelId: string): string {
  return `${platform}:${channelId}`
}

/**
 * Parse a visit key into platform and channel ID
 */
export function parseVisitKey(key: string): { platform: PlatformType; channelId: string } | null {
  const match = key.match(/^(discord|whatsapp):(.+)$/)
  if (!match) return null
  return { platform: match[1] as PlatformType, channelId: match[2] }
}
