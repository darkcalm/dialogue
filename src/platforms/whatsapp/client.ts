/**
 * WhatsApp platform client implementation using Baileys
 */

import {
  WASocket,
  WAMessage,
  Chat,
  proto,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
import {
  IPlatformClient,
  IPlatformChannel,
  IPlatformMessage,
  SendMessageOptions,
} from '../types'
import {
  adaptWhatsAppChat,
  adaptWhatsAppMessage,
  isMessageFromMe,
  createDmJid,
} from './adapters'
import { createWhatsAppConnection, disconnectWhatsApp, store } from './auth'

export class WhatsAppPlatformClient implements IPlatformClient {
  readonly type = 'whatsapp' as const
  private sock: WASocket | null = null
  private _isConnected = false
  private _isReady = false

  // Event callbacks
  private messageCallbacks: Array<(message: IPlatformMessage) => void> = []
  private messageUpdateCallbacks: Array<(message: IPlatformMessage) => void> = []
  private messageDeleteCallbacks: Array<(channelId: string, messageId: string) => void> = []

  // Store chats for quick access
  private chatsCache: Map<string, Chat> = new Map()

  // Promise to track when initial sync is done
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(): Promise<void> {
    // Create a promise that resolves when we're ready to fetch chats
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve
    })

    this.sock = await createWhatsAppConnection({
      onConnected: () => {
        this._isConnected = true
        this.setupEventListeners()

        // Be more patient - history sync can take time
        console.log('🔍 Waiting for WhatsApp history sync...')
        console.log('💡 This can take 30-90 seconds depending on your message history')
        console.log('💡 Watch for "📦 Store: messaging-history.set" log')

        // Don't load too early - wait for history sync to actually complete
        setTimeout(() => {
          if (this.chatsCache.size === 0) {
            console.log('⏰ 30s: Still waiting for chats...')
            this.loadChatsFromStore()
          }
        }, 30000)

        setTimeout(() => {
          if (this.chatsCache.size === 0) {
            console.log('⏰ 60s: Attempting final load...')
            this.loadChatsFromStore()
          }
        }, 60000)
      },
      onDisconnected: () => {
        this._isConnected = false
      },
    })

    // Wait for initial sync to complete
    console.log('⏳ Waiting for WhatsApp to sync chats...')
    await this.readyPromise
    this._isReady = true
    console.log('✅ WhatsApp sync complete!')
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      await disconnectWhatsApp(this.sock)
      this.sock = null
      this._isConnected = false
    }
  }

  private setupEventListeners(): void {
    if (!this.sock) return

    // New message event
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Only handle new messages (not history)
      if (type === 'notify') {
        for (const msg of messages) {
          const chatId = msg.key.remoteJid || ''
          const platformMessage = adaptWhatsAppMessage(msg, chatId)

          // Notify message callbacks
          this.messageCallbacks.forEach(cb => cb(platformMessage))
        }
      }
    })

    // Message update event (for reactions, edits, etc.)
    this.sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (update.key.remoteJid) {
          // Fetch the updated message
          // Note: We'd need to store messages to get the full updated message
          // For now, we'll skip this
        }
      }
    })

    // Message delete event
    this.sock.ev.on('messages.delete', async (deletion) => {
      if (deletion.keys) {
        for (const key of deletion.keys) {
          if (key.remoteJid && key.id) {
            this.messageDeleteCallbacks.forEach(cb => cb(key.remoteJid!, key.id!))
          }
        }
      }
    })

    // Chats update event (to keep cache fresh)
    this.sock.ev.on('chats.set', ({ chats }) => {
      console.log(`📥 Received ${chats.length} chats from chats.set event`)
      chats.forEach(chat => {
        this.chatsCache.set(chat.id, chat)
      })

      // Mark as ready once we have chats
      if (this.readyResolve && chats.length > 0) {
        this.readyResolve()
        this.readyResolve = null
      }
    })

    this.sock.ev.on('chats.update', (updates) => {
      updates.forEach(update => {
        if (update.id) {
          const existing = this.chatsCache.get(update.id)
          if (existing) {
            this.chatsCache.set(update.id, { ...existing, ...update })
          }
        }
      })
    })

    // Listen for connection state changes
    this.sock.ev.on('connection.update', async (update) => {
      // When connection becomes open/ready, try to load chats from store
      if (update.connection === 'open') {
        console.log('🔍 Connection open, checking for chats in store...')

        // Give it a moment for store to be ready
        setTimeout(() => {
          this.loadChatsFromStore()
        }, 2000)
      }
    })

    // Handle case where history sync doesn't complete (resolve after a timeout)
    setTimeout(() => {
      if (this.readyResolve) {
        console.log('⏰ Final timeout (90s) reached, proceeding anyway...')
        console.log('💡 If no messages loaded, history sync may have failed')
        console.log('💡 New messages will still appear in real-time')
        this.loadChatsFromStore()
      }
    }, 90000) // 90 second final fallback - give history sync time to complete
  }

  /**
   * Try to load chats directly from the store or actively fetch them
   */
  private async loadChatsFromStore(): Promise<void> {
    if (!this.sock) return

    try {
      console.log('📂 Attempting to load chats from store...')

      // First check store
      let chats = store.getAllChats()
      console.log(`📥 Found ${chats.length} chats in store`)

      // If store is empty, try to actively fetch chats
      if (chats.length === 0) {
        console.log('🔍 Store empty, trying to fetch chats directly from WhatsApp...')

        try {
          // Try to get group chats
          const groups = await this.sock.groupFetchAllParticipating()
          console.log(`📱 Fetched ${Object.keys(groups).length} groups from WhatsApp`)

          // Convert groups to chats and add to cache
          Object.values(groups).forEach((group: any) => {
            const chat: Chat = {
              id: group.id,
              name: group.subject,
              conversationTimestamp: Date.now(),
              unreadCount: 0,
            }
            this.chatsCache.set(chat.id, chat)
            store.chats.set(chat.id, chat)
          })

          // Update chats array
          chats = store.getAllChats()
          console.log(`✅ After fetching groups: ${chats.length} total chats`)
          console.log(`💡 Note: Message history requires WhatsApp sync to complete`)
          console.log(`💡 New messages will appear in real-time as they arrive`)
        } catch (groupErr) {
          console.error('⚠️  Failed to fetch groups:', groupErr)
        }

        // Note: Individual DM chats might not be fetchable without message history
        // They should appear through messaging-history events or when you send/receive messages
      }

      if (chats.length > 0) {
        chats.forEach(chat => {
          this.chatsCache.set(chat.id, chat)
        })

        // Mark as ready
        if (this.readyResolve) {
          this.readyResolve()
          this.readyResolve = null
        }
      } else {
        console.log('⚠️  No chats found')
        console.log('💡 This account may have no group chats')
        console.log('💡 DM chats will appear when you send/receive messages')
        // Still mark as ready even with no chats
        if (this.readyResolve) {
          this.readyResolve()
          this.readyResolve = null
        }
      }
    } catch (error) {
      console.error('Error loading chats:', error)
      // Mark as ready anyway to prevent hanging
      if (this.readyResolve) {
        this.readyResolve()
        this.readyResolve = null
      }
    }
  }

  async getChannels(): Promise<IPlatformChannel[]> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp')
    }

    // Wait for ready if needed
    if (!this._isReady && this.readyPromise) {
      await this.readyPromise
    }

    // Use cached chats
    const chats = Array.from(this.chatsCache.values())

    // Convert to platform channels
    return chats.map(adaptWhatsAppChat)
  }

  async getChannel(channelId: string): Promise<IPlatformChannel | null> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp')
    }

    // Wait for ready if needed
    if (!this._isReady && this.readyPromise) {
      await this.readyPromise
    }

    // Check cache
    const cached = this.chatsCache.get(channelId)
    if (cached) {
      return adaptWhatsAppChat(cached)
    }

    return null
  }

  async getMessages(channelId: string, limit: number = 20): Promise<IPlatformMessage[]> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp')
    }

    try {
      console.log(`📥 Getting messages for ${channelId}...`)

      // Check store first
      let messages = store.getMessages(channelId)

      if (messages.length === 0) {
        console.log(`⚠️  No messages in store, attempting to fetch from WhatsApp...`)

        // Use fetchMessageHistory to actively fetch messages
        try {
          console.log(`🔍 Checking if fetchMessageHistory exists:`, typeof this.sock.fetchMessageHistory)

          if (typeof this.sock.fetchMessageHistory !== 'function') {
            console.log(`❌ fetchMessageHistory is not available on this Baileys version`)
            console.log(`💡 Available methods:`, Object.keys(this.sock).filter(k => typeof (this.sock as any)[k] === 'function').slice(0, 20))
            return []
          }

          // Create a message key for the chat
          const messageKey = {
            remoteJid: channelId,
            fromMe: false,
            id: 'DUMMY',
          }

          console.log(`📞 Calling fetchMessageHistory with:`, { limit, channelId })

          // Fetch message history (returns a sync ID)
          const syncId = await this.sock.fetchMessageHistory(limit, messageKey, undefined)
          console.log(`✅ Requested message history, sync ID: ${syncId}`)

          // Wait a moment for messages to arrive via events
          console.log(`⏳ Waiting 3 seconds for messages to arrive...`)
          await new Promise(resolve => setTimeout(resolve, 3000))

          // Check store again after fetch
          messages = store.getMessages(channelId)
          console.log(`📦 After fetch: ${messages.length} messages in store`)

          if (messages.length === 0) {
            console.log(`⚠️  Still no messages after fetch - history may not be available for this chat`)
          }
        } catch (fetchErr) {
          console.error('❌ fetchMessageHistory failed:', fetchErr)
          console.error('Error details:', fetchErr)
        }
      } else {
        console.log(`✅ Found ${messages.length} messages in store`)
      }

      if (messages.length === 0) {
        console.log(`💡 No message history available for this chat yet`)
        return []
      }

      // Take the most recent messages up to limit
      const recentMessages = messages.slice(-limit)

      // Convert to platform messages
      const platformMessages = recentMessages
        .filter((msg): msg is proto.IWebMessageInfo => msg !== undefined && msg !== null)
        .map(msg => adaptWhatsAppMessage(msg, channelId))

      // Sort by timestamp (oldest first)
      platformMessages.sort((a, b) => a.date.getTime() - b.date.getTime())

      console.log(`✅ Returning ${platformMessages.length} messages`)
      return platformMessages
    } catch (error) {
      console.error('Error fetching WhatsApp messages:', error)
      return []
    }
  }

  async getMessagesBefore(
    channelId: string,
    beforeMessageId: string,
    limit: number = 20
  ): Promise<IPlatformMessage[]> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp')
    }

    try {
      console.log(`📥 Fetching older messages before ${beforeMessageId}...`)

      // Get all current messages from store
      const currentMessages = store.getMessages(channelId)

      // Find the "before" message to get its timestamp
      const beforeMessage = currentMessages.find(m => m.key.id === beforeMessageId)

      if (!beforeMessage) {
        console.log(`⚠️  Could not find message ${beforeMessageId} in store`)
        return []
      }

      const beforeTimestamp = beforeMessage.messageTimestamp as number

      // Use fetchMessageHistory with the timestamp to get older messages
      try {
        const messageKey = {
          remoteJid: channelId,
          fromMe: beforeMessage.key.fromMe || false,
          id: beforeMessageId,
        }

        console.log(`🔄 Requesting ${limit} messages before timestamp ${beforeTimestamp}...`)
        const syncId = await this.sock.fetchMessageHistory(limit, messageKey, beforeTimestamp)
        console.log(`✅ Requested older messages, sync ID: ${syncId}`)

        // Wait for messages to arrive via events
        await new Promise(resolve => setTimeout(resolve, 2000))

        // Get updated messages from store
        const updatedMessages = store.getMessages(channelId)
        console.log(`📦 Store now has ${updatedMessages.length} total messages`)

        // Find newly added messages (those before the original message)
        const olderMessages = updatedMessages.filter(msg => {
          const msgTimestamp = msg.messageTimestamp as number
          return msgTimestamp < beforeTimestamp
        })

        // Sort by timestamp and take the most recent N
        olderMessages.sort((a, b) => {
          const aTime = a.messageTimestamp as number
          const bTime = b.messageTimestamp as number
          return bTime - aTime
        })

        const messagesToReturn = olderMessages.slice(0, limit)

        // Convert to platform messages
        const platformMessages = messagesToReturn
          .filter((msg): msg is proto.IWebMessageInfo => msg !== undefined && msg !== null)
          .map(msg => adaptWhatsAppMessage(msg, channelId))

        // Sort by timestamp (oldest first)
        platformMessages.sort((a, b) => a.date.getTime() - b.date.getTime())

        console.log(`✅ Returning ${platformMessages.length} older messages`)
        return platformMessages
      } catch (fetchErr) {
        console.error('⚠️  Failed to fetch older messages:', fetchErr)
        return []
      }
    } catch (error) {
      console.error('Error fetching older WhatsApp messages:', error)
      return []
    }
  }

  async sendMessage(options: SendMessageOptions): Promise<IPlatformMessage> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp')
    }

    const { content, channelId, replyToMessageId, attachments } = options

    // Build message content
    const messageContent: any = {}

    if (attachments && attachments.length > 0) {
      // TODO: Implement attachment sending
      // Would need to read file and send as media
      throw new Error('WhatsApp attachment sending not yet implemented')
    }

    // Text message
    if (content) {
      if (replyToMessageId) {
        // Send as reply
        messageContent.text = content
        // Note: Would need to fetch the original message for proper quoting
        // For now, send without quote context
      } else {
        // Regular text message
        messageContent.text = content
      }
    }

    // Send message
    const result = await this.sock.sendMessage(channelId, messageContent)

    // Convert the sent message to platform format
    if (result) {
      return adaptWhatsAppMessage(result, channelId)
    }

    throw new Error('Failed to send WhatsApp message')
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp')
    }

    try {
      await this.sock.sendMessage(channelId, {
        react: {
          text: emoji,
          key: {
            remoteJid: channelId,
            id: messageId,
          },
        },
      })
    } catch (error) {
      console.error('Error adding WhatsApp reaction:', error)
      throw error
    }
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp')
    }

    try {
      // Send empty reaction to remove
      await this.sock.sendMessage(channelId, {
        react: {
          text: '',
          key: {
            remoteJid: channelId,
            id: messageId,
          },
        },
      })
    } catch (error) {
      console.error('Error removing WhatsApp reaction:', error)
      throw error
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp')
    }

    try {
      await this.sock.sendMessage(channelId, {
        delete: {
          remoteJid: channelId,
          id: messageId,
          fromMe: true,
        },
      })
    } catch (error) {
      console.error('Error deleting WhatsApp message:', error)
      throw error
    }
  }

  async getReactionUsers(
    channelId: string,
    messageId: string,
    emoji: string
  ): Promise<Array<{ id: string; username: string }>> {
    // WhatsApp doesn't provide an easy way to get all users who reacted
    // Would need to track reactions as they come in
    return []
  }

  getCurrentUser(): { id: string; username: string } | null {
    if (!this.sock?.user) {
      return null
    }

    return {
      id: this.sock.user.id,
      username: this.sock.user.name || this.sock.user.id,
    }
  }

  getNativeClient(): WASocket {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp')
    }
    return this.sock
  }

  onMessage(callback: (message: IPlatformMessage) => void): void {
    this.messageCallbacks.push(callback)
  }

  onMessageUpdate(callback: (message: IPlatformMessage) => void): void {
    this.messageUpdateCallbacks.push(callback)
  }

  onMessageDelete(callback: (channelId: string, messageId: string) => void): void {
    this.messageDeleteCallbacks.push(callback)
  }
}
