/**
 * In-memory cache for messages and channels
 * Provides cache-first loading with background updates via subscriptions
 */

import { IPlatformMessage, IPlatformChannel, PlatformType } from '@/platforms/types'
import { MessageInfo, platformMessageToMessageInfo } from './shared'

// ==================== Types ====================

export type ChannelKey = `${PlatformType}:${string}`

export interface MessageCacheEntry {
  messages: MessageInfo[]
  byId: Map<string, MessageInfo>
  fetchedAt: number
  hasMoreBefore: boolean
}

export interface ChannelMetaCacheEntry {
  channel: IPlatformChannel
  fetchedAt: number
  unreadCount?: number
  lastMessageTimestamp?: number
}

// ==================== Constants ====================

const MAX_MESSAGES_PER_CHANNEL = 200
const CACHE_TTL_MS = 60_000 // 1 minute staleness threshold
const MAX_CACHED_CHANNELS = 50

// ==================== Cache State ====================

const messageCache = new Map<ChannelKey, MessageCacheEntry>()
const channelCache = new Map<ChannelKey, ChannelMetaCacheEntry>()
const channelAccessOrder: ChannelKey[] = [] // LRU tracking

// ==================== Helpers ====================

export function createChannelKey(platform: PlatformType, channelId: string): ChannelKey {
  return `${platform}:${channelId}`
}

function updateAccessOrder(key: ChannelKey): void {
  const idx = channelAccessOrder.indexOf(key)
  if (idx > -1) {
    channelAccessOrder.splice(idx, 1)
  }
  channelAccessOrder.push(key)

  // Evict oldest if over limit
  while (channelAccessOrder.length > MAX_CACHED_CHANNELS) {
    const evictKey = channelAccessOrder.shift()
    if (evictKey) {
      messageCache.delete(evictKey)
      channelCache.delete(evictKey)
    }
  }
}

// ==================== Message Cache API ====================

/**
 * Get cached messages for a channel
 */
export function getCachedMessages(
  platform: PlatformType,
  channelId: string
): MessageCacheEntry | null {
  const key = createChannelKey(platform, channelId)
  const entry = messageCache.get(key)
  if (entry) {
    updateAccessOrder(key)
  }
  return entry || null
}

/**
 * Check if cache is stale
 */
export function isCacheStale(
  platform: PlatformType,
  channelId: string
): boolean {
  const entry = getCachedMessages(platform, channelId)
  if (!entry) return true
  return Date.now() - entry.fetchedAt > CACHE_TTL_MS
}

/**
 * Set messages for a channel (initial load or refresh)
 */
export function setCachedMessages(
  platform: PlatformType,
  channelId: string,
  messages: IPlatformMessage[] | MessageInfo[],
  hasMoreBefore: boolean = true
): void {
  const key = createChannelKey(platform, channelId)
  updateAccessOrder(key)

  // Convert to MessageInfo if needed
  const messageInfos: MessageInfo[] = messages.map(msg => {
    if ('hasAttachments' in msg) {
      return msg as MessageInfo
    }
    return platformMessageToMessageInfo(msg as IPlatformMessage)
  })

  // Sort by timestamp (oldest first)
  messageInfos.sort((a, b) => a.date.getTime() - b.date.getTime())

  // Build lookup map
  const byId = new Map<string, MessageInfo>()
  messageInfos.forEach(msg => byId.set(msg.id, msg))

  messageCache.set(key, {
    messages: messageInfos,
    byId,
    fetchedAt: Date.now(),
    hasMoreBefore,
  })
}

/**
 * Prepend older messages (pagination)
 */
export function prependCachedMessages(
  platform: PlatformType,
  channelId: string,
  olderMessages: IPlatformMessage[] | MessageInfo[],
  hasMoreBefore: boolean
): number {
  const key = createChannelKey(platform, channelId)
  const existing = messageCache.get(key)

  if (!existing) {
    setCachedMessages(platform, channelId, olderMessages, hasMoreBefore)
    return olderMessages.length
  }

  // Convert to MessageInfo if needed
  const messageInfos: MessageInfo[] = olderMessages.map(msg => {
    if ('hasAttachments' in msg) {
      return msg as MessageInfo
    }
    return platformMessageToMessageInfo(msg as IPlatformMessage)
  })

  // Filter duplicates
  const newMessages = messageInfos.filter(msg => !existing.byId.has(msg.id))
  if (newMessages.length === 0) {
    existing.hasMoreBefore = hasMoreBefore
    return 0
  }

  // Sort and prepend
  newMessages.sort((a, b) => a.date.getTime() - b.date.getTime())
  newMessages.forEach(msg => existing.byId.set(msg.id, msg))

  existing.messages = [...newMessages, ...existing.messages]
  existing.hasMoreBefore = hasMoreBefore

  // Trim to max size (remove oldest)
  while (existing.messages.length > MAX_MESSAGES_PER_CHANNEL) {
    const removed = existing.messages.shift()
    if (removed) {
      existing.byId.delete(removed.id)
    }
  }

  return newMessages.length
}

/**
 * Add/update a single message (real-time event)
 */
export function upsertCachedMessage(
  platform: PlatformType,
  channelId: string,
  message: IPlatformMessage | MessageInfo
): void {
  const key = createChannelKey(platform, channelId)
  const existing = messageCache.get(key)

  if (!existing) {
    // No cache for this channel yet, skip
    return
  }

  const msgInfo: MessageInfo = 'hasAttachments' in message
    ? (message as MessageInfo)
    : platformMessageToMessageInfo(message as IPlatformMessage)

  const existingIdx = existing.messages.findIndex(m => m.id === msgInfo.id)
  if (existingIdx >= 0) {
    // Update existing
    existing.messages[existingIdx] = msgInfo
    existing.byId.set(msgInfo.id, msgInfo)
  } else {
    // Insert new (append to end - real-time messages are latest)
    existing.messages.push(msgInfo)
    existing.byId.set(msgInfo.id, msgInfo)

    // Re-sort to maintain order
    existing.messages.sort((a, b) => a.date.getTime() - b.date.getTime())

    // Trim to max size (remove oldest)
    while (existing.messages.length > MAX_MESSAGES_PER_CHANNEL) {
      const removed = existing.messages.shift()
      if (removed) {
        existing.byId.delete(removed.id)
      }
    }
  }
}

/**
 * Delete a message from cache
 */
export function deleteCachedMessage(
  platform: PlatformType,
  channelId: string,
  messageId: string
): void {
  const key = createChannelKey(platform, channelId)
  const existing = messageCache.get(key)

  if (!existing) return

  const idx = existing.messages.findIndex(m => m.id === messageId)
  if (idx >= 0) {
    existing.messages.splice(idx, 1)
  }
  existing.byId.delete(messageId)
}

// ==================== Channel Cache API ====================

/**
 * Cache channel metadata
 */
export function setCachedChannels(
  platform: PlatformType,
  channels: IPlatformChannel[]
): void {
  channels.forEach(channel => {
    const key = createChannelKey(platform, channel.id)
    channelCache.set(key, {
      channel,
      fetchedAt: Date.now(),
    })
  })
}

/**
 * Get cached channel
 */
export function getCachedChannel(
  platform: PlatformType,
  channelId: string
): ChannelMetaCacheEntry | null {
  const key = createChannelKey(platform, channelId)
  return channelCache.get(key) || null
}

/**
 * Update channel metadata (e.g., unread count)
 */
export function updateCachedChannel(
  platform: PlatformType,
  channelId: string,
  updates: Partial<Pick<ChannelMetaCacheEntry, 'unreadCount' | 'lastMessageTimestamp'>>
): void {
  const key = createChannelKey(platform, channelId)
  const existing = channelCache.get(key)
  if (existing) {
    Object.assign(existing, updates)
  }
}

// ==================== Cache Management ====================

/**
 * Clear all caches
 */
export function clearAllCaches(): void {
  messageCache.clear()
  channelCache.clear()
  channelAccessOrder.length = 0
}

/**
 * Clear cache for a specific channel
 */
export function clearChannelCache(platform: PlatformType, channelId: string): void {
  const key = createChannelKey(platform, channelId)
  messageCache.delete(key)
  channelCache.delete(key)
  const idx = channelAccessOrder.indexOf(key)
  if (idx > -1) {
    channelAccessOrder.splice(idx, 1)
  }
}

/**
 * Get cache stats for debugging
 */
export function getCacheStats(): {
  channelsCached: number
  totalMessages: number
} {
  let totalMessages = 0
  messageCache.forEach(entry => {
    totalMessages += entry.messages.length
  })

  return {
    channelsCached: messageCache.size,
    totalMessages,
  }
}
