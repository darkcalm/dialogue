/**
 * Discord platform client implementation
 */

import {
  Client,
  TextChannel,
  ThreadChannel,
  DMChannel,
  Message,
  Collection,
} from 'discord.js'
import {
  IPlatformClient,
  IPlatformChannel,
  IPlatformMessage,
  SendMessageOptions,
} from '../types'
import { adaptDiscordChannel, adaptDiscordMessage, adaptDiscordMessageSync } from './adapters'
import { createDiscordClient, connectDiscord, disconnectDiscord } from './auth'

export class DiscordPlatformClient implements IPlatformClient {
  readonly type = 'discord' as const
  private client: Client
  private _isConnected = false

  // Event callbacks
  private messageCallbacks: Array<(message: IPlatformMessage) => void> = []
  private messageUpdateCallbacks: Array<(message: IPlatformMessage) => void> = []
  private messageDeleteCallbacks: Array<(channelId: string, messageId: string) => void> = []
  private channelCreateCallbacks: Array<(channel: IPlatformChannel) => void> = []

  constructor() {
    this.client = createDiscordClient()
    this.setupEventListeners()
  }

  get isConnected(): boolean {
    return this._isConnected
  }

  private setupEventListeners(): void {
    // New message event
    this.client.on('messageCreate', async (message) => {
      if (this.messageCallbacks.length > 0) {
        const platformMessage = await adaptDiscordMessage(message)
        this.messageCallbacks.forEach(cb => cb(platformMessage))
      }
    })

    // Message update event
    this.client.on('messageUpdate', async (oldMessage, newMessage) => {
      if (this.messageUpdateCallbacks.length > 0 && newMessage instanceof Message) {
        const platformMessage = await adaptDiscordMessage(newMessage)
        this.messageUpdateCallbacks.forEach(cb => cb(platformMessage))
      }
    })

    // Message delete event
    this.client.on('messageDelete', (message) => {
      if (this.messageDeleteCallbacks.length > 0) {
        this.messageDeleteCallbacks.forEach(cb => cb(message.channelId, message.id))
      }
    })

    // Channel create event
    this.client.on('channelCreate', (channel) => {
      if (this.channelCreateCallbacks.length > 0) {
        if (channel instanceof TextChannel || channel instanceof ThreadChannel) {
          const platformChannel = adaptDiscordChannel(channel)
          this.channelCreateCallbacks.forEach(cb => cb(platformChannel))
        }
      }
    })
  }

  async connect(): Promise<void> {
    await connectDiscord(this.client)
    this._isConnected = true
  }

  async disconnect(): Promise<void> {
    await disconnectDiscord(this.client)
    this._isConnected = false
  }

  async getChannels(): Promise<IPlatformChannel[]> {
    const channels: IPlatformChannel[] = []

    // Get all guilds (servers)
    for (const guild of this.client.guilds.cache.values()) {
      // Fetch all channels in the guild
      const guildChannels = await guild.channels.fetch()

      for (const channel of guildChannels.values()) {
        if (channel && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
          channels.push(adaptDiscordChannel(channel))

          // For text channels, also fetch their threads (active and archived)
          if (channel instanceof TextChannel) {
            try {
              // Fetch all thread types in parallel for better performance
              const [activeResult, archivedPublicResult, archivedPrivateResult] = await Promise.allSettled([
                channel.threads.fetchActive(),
                channel.threads.fetchArchived({ type: 'public' }),
                channel.threads.fetchArchived({ type: 'private' }),
              ])

              // Process active threads
              if (activeResult.status === 'fulfilled') {
                for (const thread of activeResult.value.threads.values()) {
                  channels.push(adaptDiscordChannel(thread))
                }
              }

              // Process archived public threads
              if (archivedPublicResult.status === 'fulfilled') {
                for (const thread of archivedPublicResult.value.threads.values()) {
                  channels.push(adaptDiscordChannel(thread))
                }
              }

              // Process archived private threads
              if (archivedPrivateResult.status === 'fulfilled') {
                for (const thread of archivedPrivateResult.value.threads.values()) {
                  channels.push(adaptDiscordChannel(thread))
                }
              }
            } catch (error) {
              // Thread fetching may fail for channels without thread permissions
              console.error(`Error fetching threads for channel ${channel.name}:`, error)
            }
          }
        }
      }
    }

    // Get DM channels
    for (const dmChannel of this.client.channels.cache.values()) {
      if (dmChannel instanceof DMChannel) {
        channels.push(adaptDiscordChannel(dmChannel))
      }
    }

    return channels
  }

  async getChannel(channelId: string): Promise<IPlatformChannel | null> {
    try {
      const channel = await this.client.channels.fetch(channelId)
      if (channel && (channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
        return adaptDiscordChannel(channel)
      }
      return null
    } catch {
      return null
    }
  }

  async getThreadsForChannel(channelId: string): Promise<IPlatformChannel[]> {
    const threads: IPlatformChannel[] = []

    try {
      const channel = await this.client.channels.fetch(channelId)
      if (!channel || !(channel instanceof TextChannel)) {
        return []
      }

      // Fetch active threads
      const activeThreads = await channel.threads.fetchActive()
      for (const thread of activeThreads.threads.values()) {
        threads.push(adaptDiscordChannel(thread))
      }

      // Fetch archived threads (public)
      const archivedPublic = await channel.threads.fetchArchived({ type: 'public' })
      for (const thread of archivedPublic.threads.values()) {
        threads.push(adaptDiscordChannel(thread))
      }

      // Fetch archived threads (private)
      const archivedPrivate = await channel.threads.fetchArchived({ type: 'private' })
      for (const thread of archivedPrivate.threads.values()) {
        threads.push(adaptDiscordChannel(thread))
      }

      return threads
    } catch (error) {
      console.error(`Error fetching threads for channel ${channelId}:`, error)
      return []
    }
  }

  async getMessages(channelId: string, limit: number = 20): Promise<IPlatformMessage[]> {
    try {
      const channel = await this.client.channels.fetch(channelId)
      if (!channel || !channel.isTextBased()) {
        return []
      }

      if (!(channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
        return []
      }

      const messages = await channel.messages.fetch({ limit })
      const messagesArray = Array.from(messages.values()).reverse()

      const platformMessages: IPlatformMessage[] = []
      for (const msg of messagesArray) {
        const platformMsg = await adaptDiscordMessage(msg)
        platformMessages.push(platformMsg)
      }

      return platformMessages
    } catch (error) {
      console.error('Error fetching messages:', error)
      return []
    }
  }

  async getMessagesBefore(
    channelId: string,
    beforeMessageId: string,
    limit: number = 20
  ): Promise<IPlatformMessage[]> {
    try {
      const channel = await this.client.channels.fetch(channelId)
      if (!channel || !channel.isTextBased()) {
        return []
      }

      if (!(channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
        return []
      }

      const messages = await channel.messages.fetch({
        limit,
        before: beforeMessageId,
      })

      const messagesArray = Array.from(messages.values()).reverse()

      const platformMessages: IPlatformMessage[] = []
      for (const msg of messagesArray) {
        const platformMsg = await adaptDiscordMessage(msg)
        platformMessages.push(platformMsg)
      }

      return platformMessages
    } catch (error) {
      console.error('Error fetching messages before:', error)
      return []
    }
  }

  async sendMessage(options: SendMessageOptions): Promise<IPlatformMessage> {
    const channel = await this.client.channels.fetch(options.channelId)
    if (!channel || !channel.isTextBased()) {
      throw new Error('Channel not found or not text-based')
    }

    if (!(channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
      throw new Error('Invalid channel type')
    }

    // Build message options
    const messageOptions: any = {
      content: options.content,
    }

    // Add reply reference if specified
    if (options.replyToMessageId) {
      messageOptions.reply = {
        messageReference: options.replyToMessageId,
      }
    }

    // Add attachments if specified
    if (options.attachments && options.attachments.length > 0) {
      messageOptions.files = options.attachments.map(att => ({
        attachment: att.path || att.url,
        name: att.name,
      }))
    }

    const sentMessage = await channel.send(messageOptions)
    return await adaptDiscordMessage(sentMessage)
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) {
      throw new Error('Channel not found or not text-based')
    }

    if (!(channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
      throw new Error('Invalid channel type')
    }

    const message = await channel.messages.fetch(messageId)
    await message.react(emoji)
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) {
      throw new Error('Channel not found or not text-based')
    }

    if (!(channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
      throw new Error('Invalid channel type')
    }

    const message = await channel.messages.fetch(messageId)
    const reaction = message.reactions.cache.find(r => r.emoji.name === emoji)

    if (reaction && this.client.user) {
      await reaction.users.remove(this.client.user.id)
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) {
      throw new Error('Channel not found or not text-based')
    }

    if (!(channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
      throw new Error('Invalid channel type')
    }

    const message = await channel.messages.fetch(messageId)
    await message.delete()
  }

  async editMessage(channelId: string, messageId: string, newContent: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) {
      throw new Error('Channel not found or not text-based')
    }

    if (!(channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
      throw new Error('Invalid channel type')
    }

    const message = await channel.messages.fetch(messageId)
    await message.edit(newContent)
  }

  async getReactionUsers(
    channelId: string,
    messageId: string,
    emoji: string
  ): Promise<Array<{ id: string; username: string }>> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) {
      return []
    }

    if (!(channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
      return []
    }

    const message = await channel.messages.fetch(messageId)
    const reaction = message.reactions.cache.find(r => r.emoji.name === emoji)

    if (!reaction) {
      return []
    }

    const users = await reaction.users.fetch()
    return Array.from(users.values()).map(user => ({
      id: user.id,
      username: user.username,
    }))
  }

  getCurrentUser(): { id: string; username: string } | null {
    if (!this.client.user) {
      return null
    }

    return {
      id: this.client.user.id,
      username: this.client.user.username,
    }
  }

  getNativeClient(): Client {
    return this.client
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

  onChannelCreate(callback: (channel: IPlatformChannel) => void): void {
    this.channelCreateCallbacks.push(callback)
  }
}
