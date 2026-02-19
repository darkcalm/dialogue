/**
 * Shared Ink-based TUI App for Discord CLI tools
 * Single-column layout with view switching
 */

import React, { useReducer, useCallback, useEffect, useState } from 'react'
import { render, Box, Text, useApp, useInput, useStdout } from 'ink'
import { IPlatformClient } from '@/platforms/types'
type SectionName = 'new' | 'following' | 'unfollowed_new' | 'unfollowed'
import {
  ChannelInfo,
  MessageInfo,
  ReplyView,
  loadMessagesFromPlatform,
  loadOlderMessagesFromPlatform,
  markChannelVisited,
  extractUrls,
  openUrlInBrowser,
  formatDateHeader,
  rewriteMessageWithLLM,
  attachFile,
  downloadAttachmentsFromInfo,
  resolveEmoji,
  emojify,
  LLMContext,
  copyToClipboard,
  generateDiscordChannelLink,
  generateDiscordMessageLink,
} from '../shared'
import { upsertCachedMessage, deleteCachedMessage, getCachedMessages } from '../cache'

// ==================== Types ====================

export type ViewName =
  | 'unified'
  | 'react'
  | 'llmReview'
  | 'reactionUsers'

// For unified view, track expanded channels and their messages
export interface ExpandedChannelData {
  channelId: string
  messages: MessageInfo[]
  isLoading: boolean
  hasMoreOlderMessages: boolean
}

// Flat item types for unified navigation
export type FlatItem =
  | { type: 'header'; sectionName: string; displayIndex: number }
  | { type: 'channel'; channelId: string; displayIndex: number }
  | { type: 'message'; channelId: string; messageIndex: number; messageId: string }
  | { type: 'draft'; channelId: string; draftId: string }
  | { type: 'input'; channelId: string }

// Focus mode in unified view
export type UnifiedFocusMode = 'navigation' | 'compose' | 'reader'

// Number of messages to show by default (non-reader mode)
const DEFAULT_VISIBLE_MESSAGES = 5

export interface AppState {
  view: ViewName
  channels: ChannelInfo[]
  channelDisplayItems: string[] // For inbox grouped display
  selectedChannelIndex: number // Legacy - kept for compatibility
  selectedChannel: ChannelInfo | null

  // Unified view state - flat navigation model
  expandedChannels: Set<string> // Channel IDs that are expanded
  expandedChannelData: Map<string, ExpandedChannelData> // Messages for each expanded channel
  replyViewsByChannel: Map<string, ReplyView[]>
  flatItems: FlatItem[] // Computed flat list of all visible items
  selectedFlatIndex: number // Position in flat list
  focusMode: UnifiedFocusMode // Are we navigating or composing?
  readerFocusChannel: string | null // Channel ID in reader focus mode
  channelMessageOffsets: Map<string, number> // Scroll offset for messages in reader mode
  readerSelectedMessageOffset: number // Which message within visible window is selected (0 to DEFAULT_VISIBLE_MESSAGES-1)
  selectedMessageIndex: number // Deprecated - use flatItems instead
  messageScrollIndex: number

  messages: MessageInfo[],
  hasMoreOlderMessages: boolean
  isLoadingOlderMessages: boolean

  inputText: string
  inputCursorPos: number
  replyingToMessageId: string | null
  reactingToMessageId: string | null
  editingMessageId: string | null
  editingChannelId: string | null
  activeReplyViewId: string | null
  activeReplyViewChannelId: string | null
  activeReplyTargetChannelId: string | null
  attachedFiles: Array<{ path: string; name: string }>
  llmOriginalText: string
  llmProcessedText: string

  statusText: string
  loading: boolean

  // For message detail modal (v key)
  messageDetail: {
    author: string
    timestamp: string
    content: string
    reactions?: Array<{ emoji: string; count: number; users: string[] }>
  } | null

  // Terminal dimensions
  rows: number
  cols: number

  // Viewport scrolling
  viewportOffset: number // How many lines we've scrolled down
}

type Action =
  | { type: 'SET_CHANNELS'; channels: ChannelInfo[]; displayItems?: string[] }
  | { type: 'SELECT_CHANNEL_INDEX'; index: number }
  | { type: 'SET_SELECTED_CHANNEL'; channel: ChannelInfo | null }
  | { type: 'SET_VIEW'; view: ViewName }
  | {
      type: 'SET_MESSAGES'
      messages: MessageInfo[]
    }
  | {
      type: 'REFRESH_MESSAGES'
      messages: MessageInfo[]
    }
  | { type: 'PREPEND_MESSAGES'; messages: MessageInfo[]; count: number }
  | { type: 'SELECT_MESSAGE_INDEX'; index: number }
  | { type: 'SCROLL_MESSAGES'; delta: number }
  | { type: 'SET_INPUT_TEXT'; text: string }
  | { type: 'SET_INPUT_CURSOR_POS'; pos: number }
  | { type: 'SET_REPLYING_TO'; messageId: string | null }
  | { type: 'SET_REACTING_TO'; messageId: string | null }
  | { type: 'SET_EDITING'; messageId: string | null; channelId: string | null; originalContent?: string }
  | { type: 'ADD_ATTACHMENT'; file: { path: string; name: string } }
  | { type: 'CLEAR_ATTACHMENTS' }
  | { type: 'SET_LLM_TEXTS'; original: string; processed: string }
  | { type: 'CLEAR_LLM_TEXTS' }
  | { type: 'SET_STATUS'; text: string }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_LOADING_OLDER'; loading: boolean }
  | { type: 'SET_HAS_MORE_OLDER'; hasMore: boolean }
  | { type: 'SET_MESSAGE_DETAIL'; detail: { author: string; timestamp: string; content: string; reactions?: Array<{ emoji: string; count: number; users: string[] }> } | null }
  | { type: 'RESET_MESSAGE_STATE' }
  | { type: 'SET_DIMENSIONS'; rows: number; cols: number }
  // Unified view actions
  | { type: 'TOGGLE_CHANNEL_EXPAND'; channelId: string }
  | { type: 'SET_EXPANDED_CHANNEL_DATA'; channelId: string; data: ExpandedChannelData }
  | { type: 'SET_FOCUS_MODE'; mode: UnifiedFocusMode }
  | { type: 'SET_READER_FOCUS'; channelId: string | null }
  | { type: 'SCROLL_CHANNEL_MESSAGES'; channelId: string; delta: number }
  | { type: 'SET_READER_SELECTED_MESSAGE_OFFSET'; offset: number }
  | { type: 'COLLAPSE_ALL_CHANNELS' }
  | { type: 'EXPAND_CHANNEL'; channelId: string }
  | { type: 'SET_EXPANDED_CHANNELS'; expandedChannels: Set<string>; expandedChannelData: Map<string, ExpandedChannelData> }
  | { type: 'SELECT_FLAT_INDEX'; index: number }
  | { type: 'SET_FLAT_ITEMS'; items: FlatItem[] }
  | { type: 'MARK_CHANNEL_READ'; channelId: string }
  | { type: 'SCROLL_VIEWPORT'; delta: number }
  | { type: 'SET_VIEWPORT_OFFSET'; offset: number }
  | { type: 'SET_REPLY_VIEWS'; replyViews: Map<string, ReplyView[]> }
  | { type: 'REMOVE_REPLY_VIEW'; channelId: string; replyViewId: string }
  | { type: 'SET_ACTIVE_REPLY_VIEW'; replyViewId: string | null; channelId: string | null; targetChannelId: string | null }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_CHANNELS':
      return {
        ...state,
        channels: action.channels,
        channelDisplayItems:
          action.displayItems ||
          action.channels.map(
            (c) => `${c.guildName ? `${c.guildName} / ` : ''}${c.name}`
          ),
      }
    case 'SELECT_CHANNEL_INDEX':
      return {
        ...state,
        selectedChannelIndex: Math.max(
          0,
          Math.min(action.index, state.channelDisplayItems.length - 1)
        ),
      }
    case 'SET_SELECTED_CHANNEL':
      return {
        ...state,
        selectedChannel: action.channel,
      }
    case 'SET_VIEW':
      return { ...state, view: action.view }
    case 'SET_MESSAGES':
      return {
        ...state,
        messages: action.messages,
        messageScrollIndex: Math.max(0, action.messages.length - 5),
        selectedMessageIndex:
          action.messages.length > 0 ? action.messages.length - 1 : -1,
        hasMoreOlderMessages: true,
      }
    case 'REFRESH_MESSAGES': {
      // Preserve selected message index when refreshing after an action
      const clampedIndex = Math.min(
        state.selectedMessageIndex,
        action.messages.length - 1
      )
      return {
        ...state,
        messages: action.messages,
        selectedMessageIndex: clampedIndex >= 0 ? clampedIndex : action.messages.length - 1,
      }
    }
    case 'PREPEND_MESSAGES':
      return {
        ...state,
        messages: action.messages,
        messageScrollIndex: state.messageScrollIndex + action.count,
        selectedMessageIndex:
          state.selectedChannelIndex >= 0
            ? state.selectedChannelIndex + action.count
            : -1,
      }
    case 'SELECT_MESSAGE_INDEX': {
      const newIndex = Math.max(
        -1,
        Math.min(action.index, state.messages.length - 1)
      )
      let newScrollIndex = state.messageScrollIndex
      const visibleCount = Math.floor((state.rows - 4) / 4) // Approximate lines per message
      if (newIndex < newScrollIndex) {
        newScrollIndex = newIndex
      } else if (newIndex >= newScrollIndex + visibleCount) {
        newScrollIndex = newIndex - visibleCount + 1
      }
      return {
        ...state,
        selectedMessageIndex: newIndex,
        messageScrollIndex: Math.max(0, newScrollIndex),
      }
    }
    case 'SCROLL_MESSAGES':
      return {
        ...state,
        messageScrollIndex: Math.max(
          0,
          Math.min(
            state.messageScrollIndex + action.delta,
            state.messages.length - 1
          )
        ),
      }
    case 'SET_INPUT_TEXT':
      return {
        ...state,
        inputText: action.text,
        inputCursorPos: action.text.length,
      }
    case 'SET_INPUT_CURSOR_POS':
      return { ...state, inputCursorPos: action.pos }
    case 'SET_REPLYING_TO':
      return { ...state, replyingToMessageId: action.messageId }
    case 'SET_REACTING_TO':
      return { ...state, reactingToMessageId: action.messageId }
    case 'SET_EDITING':
      return {
        ...state,
        editingMessageId: action.messageId,
        editingChannelId: action.channelId,
        inputText: action.originalContent || '',
        inputCursorPos: action.originalContent?.length || 0
      }
    case 'ADD_ATTACHMENT':
      return { ...state, attachedFiles: [...state.attachedFiles, action.file] }
    case 'CLEAR_ATTACHMENTS':
      return { ...state, attachedFiles: [] }
    case 'SET_LLM_TEXTS':
      return {
        ...state,
        llmOriginalText: action.original,
        llmProcessedText: action.processed,
      }
    case 'CLEAR_LLM_TEXTS':
      return { ...state, llmOriginalText: '', llmProcessedText: '' }
    case 'SET_STATUS':
      return { ...state, statusText: action.text }
    case 'SET_LOADING':
      return { ...state, loading: action.loading }
    case 'SET_LOADING_OLDER':
      return { ...state, isLoadingOlderMessages: action.loading }
    case 'SET_HAS_MORE_OLDER':
      return { ...state, hasMoreOlderMessages: action.hasMore }
    case 'SET_MESSAGE_DETAIL':
      return { ...state, messageDetail: action.detail }
    case 'RESET_MESSAGE_STATE':
      return {
        ...state,
        inputText: '',
        inputCursorPos: 0,
        replyingToMessageId: null,
        reactingToMessageId: null,
        editingMessageId: null,
        editingChannelId: null,
        attachedFiles: [],
        llmOriginalText: '',
        llmProcessedText: '',
        activeReplyViewId: null,
        activeReplyViewChannelId: null,
        activeReplyTargetChannelId: null,
      }
    case 'SET_DIMENSIONS':
      return { ...state, rows: action.rows, cols: action.cols }
    case 'SET_REPLY_VIEWS':
      return { ...state, replyViewsByChannel: action.replyViews }
    case 'REMOVE_REPLY_VIEW': {
      const updatedReplies = new Map(state.replyViewsByChannel)
      const current = updatedReplies.get(action.channelId) || []
      const remaining = current.filter((reply) => reply.id !== action.replyViewId)
      if (remaining.length > 0) {
        updatedReplies.set(action.channelId, remaining)
      } else {
        updatedReplies.delete(action.channelId)
      }
      return { ...state, replyViewsByChannel: updatedReplies }
    }
    case 'SET_ACTIVE_REPLY_VIEW':
      return {
        ...state,
        activeReplyViewId: action.replyViewId,
        activeReplyViewChannelId: action.channelId,
        activeReplyTargetChannelId: action.targetChannelId,
      }
    // Unified view reducers
    case 'TOGGLE_CHANNEL_EXPAND': {
      const newExpanded = new Set(state.expandedChannels)
      if (newExpanded.has(action.channelId)) {
        newExpanded.delete(action.channelId)
      } else {
        newExpanded.add(action.channelId)
      }
      return { ...state, expandedChannels: newExpanded }
    }
    case 'EXPAND_CHANNEL': {
      const newExpanded = new Set(state.expandedChannels)
      newExpanded.add(action.channelId)
      return { ...state, expandedChannels: newExpanded }
    }
    case 'COLLAPSE_ALL_CHANNELS':
      return { ...state, expandedChannels: new Set(), focusMode: 'navigation', readerFocusChannel: null }
    case 'SET_EXPANDED_CHANNEL_DATA': {
      const newData = new Map(state.expandedChannelData)
      newData.set(action.channelId, action.data)
      return { ...state, expandedChannelData: newData }
    }
    case 'SET_FOCUS_MODE':
      return { ...state, focusMode: action.mode }
    case 'SET_READER_FOCUS': {
      if (action.channelId === null) {
        return { ...state, readerFocusChannel: null, focusMode: 'navigation' }
      }
      // Initialize scroll offset for this channel if not set
      const newOffsets = new Map(state.channelMessageOffsets)
      const data = state.expandedChannelData.get(action.channelId)
      const totalMsgs = data?.messages.length || 0
      if (!newOffsets.has(action.channelId)) {
        // Default to showing the most recent messages (start from index 0)
        newOffsets.set(action.channelId, 0)
      }
      // Default to selecting the last visible message (most recent)
      const visibleCount = Math.min(DEFAULT_VISIBLE_MESSAGES, totalMsgs)
      return {
        ...state,
        readerFocusChannel: action.channelId,
        focusMode: 'reader',
        channelMessageOffsets: newOffsets,
        readerSelectedMessageOffset: visibleCount - 1,
      }
    }
    case 'SCROLL_CHANNEL_MESSAGES': {
      const data = state.expandedChannelData.get(action.channelId)
      if (!data) return state
      const currentOffset = state.channelMessageOffsets.get(action.channelId) || 0
      const newOffset = Math.max(0, Math.min(currentOffset + action.delta, data.messages.length - DEFAULT_VISIBLE_MESSAGES))
      const newOffsets = new Map(state.channelMessageOffsets)
      newOffsets.set(action.channelId, newOffset)
      return { ...state, channelMessageOffsets: newOffsets }
    }
    case 'SET_READER_SELECTED_MESSAGE_OFFSET':
      return { ...state, readerSelectedMessageOffset: action.offset }
    case 'SET_EXPANDED_CHANNELS':
      return {
        ...state,
        expandedChannels: action.expandedChannels,
        expandedChannelData: action.expandedChannelData,
      }
    case 'SELECT_FLAT_INDEX':
      return {
        ...state,
        selectedFlatIndex: Math.max(0, Math.min(action.index, state.flatItems.length - 1)),
      }
    case 'SET_FLAT_ITEMS':
      return { ...state, flatItems: action.items }
    case 'MARK_CHANNEL_READ': {
      // Update channel group from 'new' to 'following' and clear newMessageCount
      // Also update the display item to remove the (N new) indicator
      const channelIndex = state.channels.findIndex(c => c.id === action.channelId)
      if (channelIndex === -1) return state

      const channel = state.channels[channelIndex] as ChannelInfo & { group?: string; newMessageCount?: number }
      if (channel.group !== 'new') return state // Already read

      const updatedChannel = { ...channel, group: 'following' as const, newMessageCount: undefined }
      const newChannels = [...state.channels]
      newChannels[channelIndex] = updatedChannel

      // Update display item to remove "(N new)" suffix
      const newDisplayItems = [...state.channelDisplayItems]
      const displayIdx = state.channelDisplayItems.findIndex(item =>
        !item.startsWith('══════') && item.includes(channel.name)
      )
      if (displayIdx >= 0) {
        // Remove the "(N new)" part from the display string
        newDisplayItems[displayIdx] = newDisplayItems[displayIdx].replace(/\s*\(\d+\s*new\)\s*$/, '')
      }

      return { ...state, channels: newChannels, channelDisplayItems: newDisplayItems }
    }
    case 'SCROLL_VIEWPORT':
      return {
        ...state,
        viewportOffset: Math.max(0, state.viewportOffset + action.delta),
      }
    case 'SET_VIEWPORT_OFFSET':
      return {
        ...state,
        viewportOffset: Math.max(0, action.offset),
      }
    default:
      return state
  }
}

// ==================== Helper Functions ====================

// Build flat items array for unified navigation
function buildFlatItems(
  displayItems: string[],
  channels: ChannelInfo[],
  expandedChannels: Set<string>,
  expandedChannelData: Map<string, ExpandedChannelData>,
  replyViewsByChannel: Map<string, ReplyView[]>,
  getChannelFromDisplayIndex: (index: number, channels: ChannelInfo[]) => ChannelInfo | null,
  readerFocusChannel: string | null,
  channelMessageOffsets: Map<string, number>
): FlatItem[] {
  const items: FlatItem[] = []

  for (let i = 0; i < displayItems.length; i++) {
    const item = displayItems[i]
    const isHeader = item.startsWith('══════')

    if (isHeader) {
      items.push({ type: 'header', sectionName: item, displayIndex: i })
    } else {
      const channel = getChannelFromDisplayIndex(i, channels)
      if (channel) {
        items.push({ type: 'channel', channelId: channel.id, displayIndex: i })

        // If expanded, add messages and input line
        if (expandedChannels.has(channel.id)) {
          const data = expandedChannelData.get(channel.id)
          if (data && !data.isLoading && data.messages.length > 0) {
            // Determine which messages to show
            const isReaderFocused = readerFocusChannel === channel.id
            const offset = channelMessageOffsets.get(channel.id) || 0

            // In reader mode or small message count: show slice based on offset
            // Otherwise show last 5 messages
            let startIdx: number
            let endIdx: number

            if (isReaderFocused || data.messages.length <= DEFAULT_VISIBLE_MESSAGES) {
              startIdx = offset
              endIdx = Math.min(offset + DEFAULT_VISIBLE_MESSAGES, data.messages.length)
            } else {
              // Default: show newest 5 messages
              startIdx = 0
              endIdx = Math.min(DEFAULT_VISIBLE_MESSAGES, data.messages.length)
            }

            for (let msgIdx = endIdx - 1; msgIdx >= startIdx; msgIdx--) {
              const msg = data.messages[msgIdx]
              items.push({
                type: 'message',
                channelId: channel.id,
                messageIndex: msgIdx,
                messageId: msg.id,
              })
            }
          }
          const replies = replyViewsByChannel.get(channel.id) || []
          for (const reply of replies) {
            items.push({ type: 'draft', channelId: channel.id, draftId: reply.id })
          }
          // Add input line for expanded channel
          items.push({ type: 'input', channelId: channel.id })
        }
      }
    }
  }

  return items
}

// Find the flat index for a channel's input line
function findInputIndexForChannel(flatItems: FlatItem[], channelId: string): number {
  return flatItems.findIndex(item => item.type === 'input' && item.channelId === channelId)
}

// Get the channel ID that a flat item belongs to (or the nearest one for headers)
function getChannelIdFromFlatItem(item: FlatItem): string | null {
  if (item.type === 'channel' || item.type === 'message' || item.type === 'input' || item.type === 'draft') {
    return item.channelId // Corrected to use item.channelId for ChannelInfo
  }
  return null
}

function formatReplyViewDetail(replyView: ReplyView): {
  author: string
  timestamp: string
  content: string
} {
  const archiveLines = replyView.archiveHighlights.length > 0
    ? replyView.archiveHighlights.map((hit) => {
        const channelLabel = hit.channelName ? `#${hit.channelName}` : hit.channelId
        const snippet = hit.content.replace(/\s+/g, ' ').slice(0, 200)
        return `- ${hit.author} (${channelLabel}): ${snippet}`
      })
    : ['- (none)']

  const webLines = replyView.webSearchResults.length > 0
    ? replyView.webSearchResults.map((item) => `- ${item.title}: ${item.snippet} (${item.url})`)
    : ['- (none)']

  const attachmentLines = replyView.attachments && replyView.attachments.length > 0
    ? replyView.attachments.map((file) => `- ${file.name}: ${file.path}`)
    : ['- (none)']

  const content = [
    `Target: ${replyView.targetGuildName ? `${replyView.targetGuildName} / ` : ''}#${replyView.targetChannelName || replyView.targetChannelId}`,
    `Source: ${replyView.sourceAuthor} @ ${replyView.sourceTimestamp}`,
    `Scores: interestingness ${replyView.interestingnessScore.toFixed(2)} · novelty ${replyView.noveltyScore.toFixed(2)} · curiosity ${replyView.curiosityScore.toFixed(2)} · recency ${replyView.recencyScore.toFixed(2)}`,
    '',
    'Draft:',
    replyView.draft.trim(),
    '',
    'Archive Highlights:',
    ...archiveLines,
    '',
    'Web Search Results:',
    ...webLines,
    '',
    'Tools Used:',
    replyView.toolsUsed.length > 0 ? `- ${replyView.toolsUsed.join(', ')}` : '- (none)',
    '',
    'Skills Used:',
    replyView.skillsUsed.length > 0 ? `- ${replyView.skillsUsed.join(', ')}` : '- (none)',
    '',
    'Attachments:',
    ...attachmentLines,
  ].join('\n')

  return {
    author: `Reply view for ${replyView.sourceAuthor}`,
    timestamp: `interestingness ${replyView.interestingnessScore.toFixed(2)}`,
    content,
  }
}

// ==================== Components ====================

// Simple TextInput component using useInput
interface SimpleTextInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  placeholder?: string
  focus?: boolean
  cursorPos?: number
  onCursorChange?: (pos: number) => void
}

function SimpleTextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus = true,
  cursorPos = 0,
  onCursorChange,
}: SimpleTextInputProps) {
  useInput(
    (input, key) => {
      if (!focus) return

      if (key.return && onSubmit) {
        onSubmit(value)
        return
      }

      // Arrow key navigation
      if (key.leftArrow) {
        onCursorChange?.(Math.max(0, cursorPos - 1))
        return
      }
      if (key.rightArrow) {
        onCursorChange?.(Math.min(value.length, cursorPos + 1))
        return
      }

      if (key.backspace || key.delete) {
        if (cursorPos > 0) {
          onChange(value.slice(0, cursorPos - 1) + value.slice(cursorPos))
          onCursorChange?.(cursorPos - 1)
        }
        return
      }

      // Ignore control keys (except arrows which we handled)
      if (key.ctrl || key.meta || key.escape || key.upArrow || key.downArrow) {
        return
      }

      // Add regular input at cursor position
      if (input && !key.return) {
        onChange(value.slice(0, cursorPos) + input + value.slice(cursorPos))
        onCursorChange?.(cursorPos + 1)
      }
    },
    { isActive: focus }
  )

  const displayValue = value || placeholder || ''
  const showPlaceholder = !value && placeholder
  const charAtCursor = displayValue[cursorPos] || ' '

  return (
    <Text color={showPlaceholder ? 'gray' : 'white'}>
      {displayValue.slice(0, cursorPos)}
      {focus ? (
        <Text inverse color="cyan">
          {charAtCursor}
        </Text>
      ) : (
        charAtCursor !== ' ' && charAtCursor
      )}
      {displayValue.slice(cursorPos + (charAtCursor !== ' ' || focus ? 1 : 0))}
    </Text>
  )
}

interface StatusBarProps {
  text: string
  loading?: boolean
}

function StatusBar({ text, loading }: StatusBarProps) {
  return (
    <Box width="100%" height={1}>
      <Text inverse color="blue">
        {loading ? '⏳ ' : ''}
        {text.padEnd(100)}
      </Text>
    </Box>
  )
}

interface ChannelsViewProps {
  items: string[]
  selectedIndex: number
  rows: number
}

function ChannelsView({ items, selectedIndex, rows }: ChannelsViewProps) {
  const visibleCount = rows - 4
  const startIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(visibleCount / 2),
      items.length - visibleCount
    )
  )
  const visibleItems = items.slice(startIndex, startIndex + visibleCount)

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visibleItems.map((item, idx) => {
        const actualIndex = startIndex + idx
        const isHeader = item.startsWith('══════')
        const isSelected = actualIndex === selectedIndex && !isHeader
        return (
          <Text
            key={actualIndex}
            inverse={isSelected}
            color={
              isSelected ? 'green' : isHeader ? 'yellow' : 'blackBright'
            }
            dimColor={isHeader}
          >
            {isSelected ? '▶ ' : '  '}
            {item}
          </Text>
        )
      })}
    </Box>
  )
}

interface MessagesViewProps {
  messages: MessageInfo[]
  selectedIndex: number
  scrollIndex: number
  rows: number
}

function MessagesView({
  messages,
  selectedIndex,
  scrollIndex,
  rows,
}: MessagesViewProps) {
  if (messages.length === 0) {
    return <Text color="gray">No recent messages</Text>
  }

  const linesPerMessage = 4
  const visibleCount = Math.max(1, Math.floor((rows - 4) / linesPerMessage))
  const visibleMessages = messages.slice(
    scrollIndex,
    scrollIndex + visibleCount
  )

  let lastDateStr = ''

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visibleMessages.map((msg, idx) => {
        const actualIndex = scrollIndex + idx
        const isSelected = actualIndex === selectedIndex
        const prefix = isSelected ? '▶ ' : '  '

        const currentDateStr = msg.date.toDateString()
        const showDateHeader = currentDateStr !== lastDateStr
        lastDateStr = currentDateStr

        const attachmentIndicator = msg.hasAttachments
          ? ` 📎(${msg.attachmentCount})`
          : ''

        const reactionsText =
          Array.isArray(msg.reactions) && msg.reactions.length > 0
          ? msg.reactions.map((r) => `${r.emoji}${r.count}`).join(' ')
            : ''

        // Check if next message has a date header
        const nextMsg = visibleMessages[idx + 1]
        const nextMsgDateStr =
          nextMsg && nextMsg.date.toDateString() === currentDateStr
        const nextHasDateHeader = nextMsg && !nextMsgDateStr

        const showSeparator = !showDateHeader && !nextHasDateHeader

        return (
          <Box key={msg.id} flexDirection="column">
            {showDateHeader && (
              <Text color="cyan" dimColor>
                ━━━ {formatDateHeader(msg.date)} ━━━
              </Text>
            )}
            {msg.replyTo && (
              <Text color="gray">
                {prefix} ↳ Replying to {msg.replyTo.author}:{' '}
                {msg.replyTo.content}
              </Text>
            )}
            <Text
              inverse={isSelected}
              color={isSelected ? 'blue' : 'blackBright'}
            >
              {prefix}[{msg.timestamp}] {msg.author}
              {attachmentIndicator}: {msg.content.split('\n')[0]}
            </Text>
            {msg.content
              .split('\n')
              .slice(1)
              .map((line, i) => (
                <Text key={i} color="gray">
                  {'  '}
                  {line}
                </Text>
              ))}
            {reactionsText && (
              <Text color="yellow">
                {'    '}
                {reactionsText}
              </Text>
            )}
            {showSeparator && <Text color="gray">───</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

interface ComposeViewProps {
  inputText: string
  cursorPos: number
  onInputChange: (text: string) => void
  onCursorChange: (pos: number) => void
  onSubmit: (text: string) => void
  replyingTo: string | null
  attachedFiles: Array<{ path: string; name: string }>
}

function ComposeView({
  inputText,
  cursorPos,
  onInputChange,
  onCursorChange,
  onSubmit,
  replyingTo,
  attachedFiles,
}: ComposeViewProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {replyingTo && <Text color="cyan">↳ Replying to message...</Text>}
      {attachedFiles.length > 0 && (
        <Box flexDirection="column">
          <Text color="cyan">Attached files:</Text>
          {attachedFiles.map((file, idx) => (
            <Text key={idx} color="cyan">
              {' '}
              📎 {file.name}
            </Text>
          ))}
        </Box>
      )}
      <Box>
        <Text color="gray">Message: </Text>
        <SimpleTextInput
          value={inputText}
          cursorPos={cursorPos}
          onChange={onInputChange}
          onCursorChange={onCursorChange}
          onSubmit={onSubmit}
          placeholder="Type your message..."
        />
      </Box>
    </Box>
  )
}

interface ReactViewProps {
  inputText: string
  cursorPos: number
  onInputChange: (text: string) => void
  onCursorChange: (pos: number) => void
  onSubmit: (text: string) => void
}

function ReactView({
  inputText,
  cursorPos,
  onInputChange,
  onCursorChange,
  onSubmit,
}: ReactViewProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color="yellow">Add reaction to message:</Text>
      <Box>
        <Text color="gray">Emoji: </Text>
        <SimpleTextInput
          value={inputText}
          cursorPos={cursorPos}
          onChange={onInputChange}
          onCursorChange={onCursorChange}
          onSubmit={onSubmit}
          placeholder="Enter emoji (e.g., 👍 or :thumbsup:)"
          focus={true}
        />
      </Box>
    </Box>
  )
}

interface LlmReviewViewProps {
  originalText: string
  processedText: string
}

function LlmReviewView({ originalText, processedText }: LlmReviewViewProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color="magenta" bold>
        LLM Review - Choose version to send:
      </Text>
      <Box flexDirection="column">
        <Text color="cyan" bold>
          Original (o to send, O to edit):
        </Text>
        <Text>{originalText}</Text>
      </Box>
      <Box flexDirection="column">
        <Text color="green" bold>
          Processed (p to send, e to edit):
        </Text>
        <Text>{processedText}</Text>
      </Box>
      <Text color="gray" dimColor>Press Esc to cancel</Text>
    </Box>
  )
}

interface MessageDetailViewProps {
  message: {
    author: string
    timestamp: string
    content: string
    reactions?: Array<{ emoji: string; count: number; users: string[] }>
  }
}

function MessageDetailView({ message }: MessageDetailViewProps) {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text color="cyan" bold>
        [{message.timestamp}] {message.author}
      </Text>
      <Box flexDirection="column">
         {message.content.split('\n').map((line, i) => (
           <Text key={i}>{line}</Text>
         ))}
       </Box>
       {message.reactions && message.reactions.length > 0 && (
         <Box flexDirection="column">
          <Text color="yellow" bold>Reactions:</Text>
          {message.reactions.map((r, i) => (
            <Text key={i}>  {r.emoji} {r.count} — {r.users.length > 0 ? r.users.join(', ') : 'unknown'}</Text>
          ))}
        </Box>
      )}
      <Text color="gray" dimColor>Press Esc or q to close</Text>
    </Box>
  )
}

// ==================== Unified View ====================

interface UnifiedViewProps {
  displayItems: string[]
  channels: ChannelInfo[]
  flatItems: FlatItem[]
  selectedFlatIndex: number
  expandedChannels: Set<string>
  expandedChannelData: Map<string, ExpandedChannelData>
  replyViewsByChannel: Map<string, ReplyView[]>
  focusMode: UnifiedFocusMode
  readerFocusChannel: string | null
  readerSelectedMessageOffset: number
  channelMessageOffsets: Map<string, number>
  replyViewMode: boolean
  inputText: string
  inputCursorPos: number
  onInputChange: (text: string) => void
  onCursorChange: (pos: number) => void
  onSubmitUnified: (text: string) => void // Renamed prop
  replyingToMessageId: string | null
  reactingToMessageId: string | null
  editingMessageId: string | null
  rows: number
  cols: number
  viewportOffset: number
  getChannelFromDisplayIndex: (index: number, channels: ChannelInfo[]) => ChannelInfo | null
}

function UnifiedView({
  displayItems,
  channels,
  flatItems,
  selectedFlatIndex,
  expandedChannels,
  expandedChannelData,
  replyViewsByChannel,
  focusMode,
  readerFocusChannel,
  readerSelectedMessageOffset,
  channelMessageOffsets,
  replyViewMode,
  inputText,
  inputCursorPos,
  onInputChange,
  onCursorChange,
  onSubmitUnified, // Renamed prop
  replyingToMessageId,
  reactingToMessageId,
  editingMessageId,
  rows,
  cols,
  viewportOffset,
  getChannelFromDisplayIndex,
}: UnifiedViewProps) {
  const allRenderedItems: React.ReactNode[] = []
  let flatIdx = 0

  for (let i = 0; i < displayItems.length; i++) {
    const displayItem = displayItems[i]
    const isHeader = displayItem.startsWith('══════')

    if (isHeader) {
      if (flatIdx < flatItems.length && flatItems[flatIdx].type === 'header') {
        const isSelected = flatIdx === selectedFlatIndex && focusMode === 'navigation'
        allRenderedItems.push(
          <Text key={`h-${i}`} color={isSelected ? 'green' : 'yellow'} dimColor={!isSelected} inverse={isSelected}>
            {isSelected ? '▶ ' : '  '}{displayItem}
          </Text>
        )
        flatIdx++
      }
    } else {
      const channel = getChannelFromDisplayIndex(i, channels)
      if (!channel) continue

      if (flatIdx < flatItems.length && flatItems[flatIdx].type === 'channel') {
        const isSelected = flatIdx === selectedFlatIndex && focusMode === 'navigation'
        const isExpanded = expandedChannels.has(channel.id)
        const isReaderFocus = readerFocusChannel === channel.id
        const expandIcon = isExpanded ? '▼' : '▶'
        const readerIndicator = isReaderFocus ? ' 📖' : ''

        allRenderedItems.push(
          <Text
            key={`c-${channel.id}`}
            inverse={isSelected}
            color={isSelected ? 'green' : isReaderFocus ? 'magenta' : isExpanded ? 'cyan' : 'blackBright'}
          >
            {isSelected ? '▶ ' : '  '}
            {expandIcon} {displayItem}{readerIndicator}
          </Text>
        )
        flatIdx++
      }

      if (expandedChannels.has(channel.id)) {
        const data = expandedChannelData.get(channel.id)

        if (data?.isLoading) {
          allRenderedItems.push(
            <Text key={`load-${channel.id}`} color="gray">
              {'    '}⏳ Loading messages...
            </Text>
          )
        } else if (data && data.messages.length === 0 && !replyViewMode) {
          allRenderedItems.push(
            <Text key={`empty-${channel.id}`} color="gray">
              {'    '}(no messages)
            </Text>
          )
        } else if (data && !data.isLoading && data.messages.length > 0) {
          while (flatIdx < flatItems.length) {
            const currentItem = flatItems[flatIdx]
            if (currentItem.type !== 'message' || currentItem.channelId !== channel.id) break
            const isNavSelected = flatIdx === selectedFlatIndex && focusMode === 'navigation'
            const isReaderChannel = readerFocusChannel === channel.id
            const readerOffset = channelMessageOffsets.get(channel.id) || 0
            const endIdx = Math.min(readerOffset + DEFAULT_VISIBLE_MESSAGES, data.messages.length)
            const isReaderSelected = isReaderChannel && currentItem.messageIndex === (endIdx - 1) - readerSelectedMessageOffset
            const isSelected = isNavSelected || isReaderSelected
            const msg = data.messages[currentItem.messageIndex]
            if (msg) {
              const attachmentIndicator = msg.hasAttachments
                ? ` 📎(${msg.attachmentCount})`
                : ''
              const reactionsText =
                Array.isArray(msg.reactions) && msg.reactions.length > 0
                ? ' ' + msg.reactions.map((r) => `${r.emoji}${r.count}`).join(' ')
                  : ''

              const prefix = `    ${isSelected ? '▶ ' : '  '}[${msg.timestamp}] ${msg.author}${attachmentIndicator}: `
              const firstLine = msg.content.split('\n')[0]
              const maxContentLen = Math.max(10, cols - prefix.length - reactionsText.length - 4)
              const truncatedContent = firstLine.length > maxContentLen ? firstLine.slice(0, maxContentLen - 1) + '…' : firstLine

              allRenderedItems.push(
                <Text
                  key={`msg-${channel.id}-${msg.id}`}
                  inverse={isSelected}
                  color={isSelected ? (isReaderSelected ? 'magenta' : 'blue') : 'gray'}
                >
                  {'    '}
                  {isSelected ? '▶ ' : '  '}
                  [{msg.timestamp}] {msg.author}
                  {attachmentIndicator}: {truncatedContent}
                  {reactionsText}
                </Text>
              )
            }
            flatIdx++
          }
        }

        while (flatIdx < flatItems.length) {
          const currentItem = flatItems[flatIdx]
          if (currentItem.type !== 'draft' || currentItem.channelId !== channel.id) break
          const draft = replyViewsByChannel.get(channel.id)?.find((entry) => entry.id === currentItem.draftId)
          const isSelected = flatIdx === selectedFlatIndex && focusMode === 'navigation'
          if (draft) {
            const interestLabel = `${draft.interestingnessScore.toFixed(2)} interest`
            const firstLine = draft.draft.split('\n')[0]
            const prefix = `    ${isSelected ? '▶ ' : '  '}💡 Reply (${interestLabel}): `
            const maxContentLen = Math.max(10, cols - prefix.length - 2)
            const truncatedContent = firstLine.length > maxContentLen ? firstLine.slice(0, maxContentLen - 1) + '…' : firstLine
            allRenderedItems.push(
              <Text key={`draft-${draft.id}`} inverse={isSelected} color={isSelected ? 'magenta' : 'cyan'}>
                {'    '}
                {isSelected ? '▶ ' : '  '}
                💡 Reply ({interestLabel}): {truncatedContent}
              </Text>
            )
          }
          flatIdx++
        }

        if (flatIdx < flatItems.length && flatItems[flatIdx].type === 'input') {
          const isSelected = flatIdx === selectedFlatIndex
          const isComposing = isSelected && focusMode === 'compose'
          const isInputSelected = isSelected && focusMode === 'navigation'

          allRenderedItems.push(
            <Box key={`input-${channel.id}`} flexDirection="column">
              {replyingToMessageId && isSelected && !editingMessageId && !reactingToMessageId && (
                <Text color="cyan">{'    '}↳ Replying...</Text>
              )}
              {reactingToMessageId && isSelected && (
                <Text color="magenta">{'    '}😀 React with emoji...</Text>
              )}
              {editingMessageId && isSelected && !reactingToMessageId && (
                <Text color="yellow">{'    '}✏ Editing message...</Text>
              )}
              <Box>
                <Text color={isComposing ? 'green' : isInputSelected ? 'cyan' : 'gray'}>
                  {'    '}
                  {isComposing ? (reactingToMessageId ? '😀 ' : editingMessageId ? '✏ ' : '✎ ') : isInputSelected ? '▶ ' : '  '}
                </Text>
                {isComposing ? (
                  <SimpleTextInput
                    value={inputText}
                    cursorPos={inputCursorPos}
                    onChange={onInputChange}
                    onCursorChange={onCursorChange}
                    onSubmit={onSubmitUnified}
                    placeholder={reactingToMessageId ? "Type emoji (e.g., 👍 or :thumbsup:)..." : editingMessageId ? "Edit message (Enter=save, Esc=cancel)..." : "Type message (Enter=send, Esc=cancel)..."}
                    focus={true}
                  />
                ) : (
                  <Text color={isInputSelected ? 'cyan' : 'gray'} dimColor={!isInputSelected} inverse={isInputSelected}>
                    [press i to compose]
                  </Text>
                )}
              </Box>
            </Box>
          )
          flatIdx++
        }
      }
    }
  }

  // Calculate visible window (rows - 3 accounts for title, status, and help bars)
  const visibleHeight = Math.max(1, rows - 3)
  const visibleItems = allRenderedItems.slice(viewportOffset, viewportOffset + visibleHeight)

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visibleItems}
    </Box>
  )
}

interface HelpBarProps {
  bindings: Array<{ key: string; label: string }>
}

function HelpBar({ bindings }: HelpBarProps) {
  return (
    <Box width="100%" height={1}>
      <Text color="gray">
        {bindings.map((b) => `${b.key}=${b.label}`).join(' · ')}
      </Text>
    </Box>
  )
}

// ==================== Main App ====================

export interface AppProps {
  client: IPlatformClient | null
  initialChannels: ChannelInfo[]
  initialDisplayItems?: string[]
  title: string
  /** Function to load messages for a given channel */
  getMessagesForChannel: (channel: ChannelInfo, limit: number) => Promise<MessageInfo[]>
  getOlderMessagesForChannel: (channel: ChannelInfo, oldestMessageId: string, limit: number) => Promise<{ messages: MessageInfo[]; newCount: number; hasMore: boolean }>
  /** Channels with new messages (will be auto-expanded and loaded on startup) */
  channelsWithNewMessages?: ChannelInfo[]
  replyViewsByChannel?: Map<string, ReplyView[]>
  replyViewMode?: boolean
  onRemoveReplyView?: (replyViewId: string) => void | Promise<void>
  onChannelSelect?: (channel: ChannelInfo) => void
  getChannelFromDisplayIndex?: (
    index: number,
    channels: ChannelInfo[]
  ) => ChannelInfo | null
  onExit?: () => void
  // Inbox-specific callbacks
  onRefreshChannels?: () => Promise<{
    channels: ChannelInfo[]
    displayItems: string[]
    replyViewsByChannel?: Map<string, ReplyView[]>
  }>
  onFollowChannel?: (
    channel: ChannelInfo
  ) => Promise<{ channels: ChannelInfo[]; displayItems: string[]; replyViewsByChannel?: Map<string, ReplyView[]> }>
  onUnfollowChannel?: (
    channel: ChannelInfo
  ) => Promise<{ channels: ChannelInfo[]; displayItems: string[]; replyViewsByChannel?: Map<string, ReplyView[]> }>
  onToggleSection?: (
    section: SectionName
  ) => Promise<{ channels: ChannelInfo[]; displayItems: string[]; replyViewsByChannel?: Map<string, ReplyView[]> }>
}

export function App({
  client,
  initialChannels,
  initialDisplayItems,
  title,
  getMessagesForChannel, // New prop
  getOlderMessagesForChannel, // New prop
  channelsWithNewMessages = [],
  replyViewsByChannel: initialReplyViewsByChannel = new Map(),
  replyViewMode = false,
  onRemoveReplyView,
  onChannelSelect,
  getChannelFromDisplayIndex: getChannelFromDisplayIndexProp,
  onExit,
  onRefreshChannels,
  onFollowChannel,
  onUnfollowChannel,
  onToggleSection,
}: AppProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()

  // Default getChannelFromDisplayIndex if not provided
  const getChannelFromDisplayIndex = getChannelFromDisplayIndexProp || ((index: number, channels: ChannelInfo[]) => channels[index] || null)

  // Find first non-header index
  const findFirstNonHeaderIndex = (items: string[]) => {
    for (let i = 0; i < items.length; i++) {
      if (!items[i].startsWith('══════')) return i
    }
    return 0
  }

  const displayItems = initialDisplayItems ||
    initialChannels.map((c) => `${c.guildName ? `${c.guildName} / ` : ''}${c.name}`)

  const initialReplyViews = new Map(initialReplyViewsByChannel)

  // Build initial flat items (no channels expanded initially)
  const initialFlatItems = buildFlatItems(
    displayItems,
    initialChannels,
    new Set<string>(),
    new Map<string, ExpandedChannelData>(),
    initialReplyViews,
    getChannelFromDisplayIndex,
    null,
    new Map<string, number>()
  )

  // Find first non-header in flat items
  const findFirstSelectableIndex = (items: FlatItem[]) => {
    for (let i = 0; i < items.length; i++) {
      if (items[i].type !== 'header') return i
    }
    return 0
  }

  const initialState: AppState = {
    view: 'unified',
    channels: initialChannels,
    channelDisplayItems: displayItems,
    selectedChannelIndex: findFirstNonHeaderIndex(displayItems),
    selectedChannel: initialChannels[0] || null,

    // Unified view state - flat navigation
    expandedChannels: new Set<string>(),
    expandedChannelData: new Map<string, ExpandedChannelData>(),
    replyViewsByChannel: initialReplyViews,
    flatItems: initialFlatItems,
    selectedFlatIndex: findFirstSelectableIndex(initialFlatItems),
    focusMode: 'navigation' as UnifiedFocusMode,
    readerFocusChannel: null,
    channelMessageOffsets: new Map<string, number>(),
    readerSelectedMessageOffset: 0,
    selectedMessageIndex: -1,
    messageScrollIndex: 0,

    messages: [],
    hasMoreOlderMessages: true,
    isLoadingOlderMessages: false,
    inputText: '',
    inputCursorPos: 0,
    replyingToMessageId: null,
    reactingToMessageId: null,
    editingMessageId: null,
    editingChannelId: null,
    activeReplyViewId: null,
    activeReplyViewChannelId: null,
    activeReplyTargetChannelId: null,
    attachedFiles: [],
    llmOriginalText: '',
    llmProcessedText: '',
    statusText: `${title}`,
    loading: false,
    messageDetail: null,
    rows: stdout?.rows || 24,
    cols: stdout?.columns || 80,
    viewportOffset: 0,
  }

  const [state, dispatch] = useReducer(reducer, initialState)

  // Update dimensions on resize
  useEffect(() => {
    const handleResize = () => {
      if (stdout) {
        dispatch({
          type: 'SET_DIMENSIONS',
          rows: stdout.rows,
          cols: stdout.columns,
        })
      }
    }
    stdout?.on('resize', handleResize)
    return () => {
      stdout?.off('resize', handleResize)
    }
  }, [stdout])

  // Enable mouse click to move focus (disabled when message detail is open for text selection)
  useEffect(() => {
    const stdin = process.stdin
    if (!stdin.setRawMode) return

    if (state.messageDetail) {
      process.stdout.write('\x1b[?1006l')
      process.stdout.write('\x1b[?1000l')
      return () => {
        process.stdout.write('\x1b[?1000h')
        process.stdout.write('\x1b[?1006h')
      }
    }

    process.stdout.write('\x1b[?1000h')
    process.stdout.write('\x1b[?1006h')

    const handleData = (data: Buffer) => {
      const str = data.toString()
      const sgrMatch = str.match(/\x1b\[<(\d+);\d+;(\d+)([Mm])/)
      if (!sgrMatch) return
      const button = parseInt(sgrMatch[1], 10)
      const y = parseInt(sgrMatch[2], 10)
      const isRelease = sgrMatch[3] === 'm'

      if (button === 0 && isRelease) {
        const flatIndex = (y - 2) + state.viewportOffset
        if (flatIndex >= 0 && flatIndex < state.flatItems.length) {
          dispatch({ type: 'SELECT_FLAT_INDEX', index: flatIndex })
        }
      }
    }

    stdin.on('data', handleData)
    return () => {
      stdin.off('data', handleData)
      process.stdout.write('\x1b[?1006l')
      process.stdout.write('\x1b[?1000l')
    }
  }, [state.flatItems.length, state.viewportOffset, state.messageDetail])

  // Rebuild flat items when channels, expanded state, or data changes
  useEffect(() => {
    const newFlatItems = buildFlatItems(
      state.channelDisplayItems,
      state.channels,
      state.expandedChannels,
      state.expandedChannelData,
      state.replyViewsByChannel,
      getChannelFromDisplayIndex,
      state.readerFocusChannel,
      state.channelMessageOffsets
    )
    dispatch({ type: 'SET_FLAT_ITEMS', items: newFlatItems })
  }, [state.channelDisplayItems, state.channels, state.expandedChannels, state.expandedChannelData, state.replyViewsByChannel, getChannelFromDisplayIndex, state.readerFocusChannel, state.channelMessageOffsets])

  // Auto-scroll viewport to keep selected item visible
  useEffect(() => {
    const visibleHeight = Math.max(1, state.rows - 3)
    const selectedIndex = state.selectedFlatIndex

    // If selected item is above viewport, scroll up to show it
    if (selectedIndex < state.viewportOffset) {
      dispatch({ type: 'SET_VIEWPORT_OFFSET', offset: selectedIndex })
    }
    // If selected item is below viewport, scroll down to show it
    else if (selectedIndex >= state.viewportOffset + visibleHeight) {
      dispatch({ type: 'SET_VIEWPORT_OFFSET', offset: selectedIndex - visibleHeight + 1 })
    }
  }, [state.selectedFlatIndex, state.viewportOffset, state.rows])

  // Load messages for channels with new messages on startup
  const loadMessagesForChannelInternal = useCallback(
    async (channel: ChannelInfo): Promise<MessageInfo[]> => {
      // Use the prop function provided by inbox.ts
      return getMessagesForChannel(channel, 100)
    },
    [getMessagesForChannel]
  )

  const findReplyView = useCallback(
    (channelId: string, replyViewId: string) => {
      return state.replyViewsByChannel.get(channelId)?.find((draft) => draft.id === replyViewId) || null
    },
    [state.replyViewsByChannel]
  )

  const startReplyCompose = useCallback(
    (replyView: ReplyView, replyViewChannelId: string) => {
      dispatch({ type: 'RESET_MESSAGE_STATE' })
      const inputIdx = findInputIndexForChannel(state.flatItems, replyViewChannelId)
      if (inputIdx !== -1) {
        dispatch({ type: 'SELECT_FLAT_INDEX', index: inputIdx })
      }
      const channel = state.channels.find(c => c.id === replyViewChannelId)
      if (channel) {
        dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
      }
      dispatch({ type: 'SET_INPUT_TEXT', text: replyView.draft })
      dispatch({ type: 'SET_INPUT_CURSOR_POS', pos: replyView.draft.length })
      dispatch({
        type: 'SET_ACTIVE_REPLY_VIEW',
        replyViewId: replyView.id,
        channelId: replyViewChannelId,
        targetChannelId: replyView.targetChannelId,
      })
      if (replyView.attachments && replyView.attachments.length > 0) {
        dispatch({ type: 'CLEAR_ATTACHMENTS' })
        replyView.attachments.forEach((file) => dispatch({ type: 'ADD_ATTACHMENT', file }))
      }
      dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
    },
    [state.channels, state.flatItems]
  )

  const discardReplyView = useCallback(
    async (replyViewId: string, channelId: string) => {
      dispatch({ type: 'REMOVE_REPLY_VIEW', channelId, replyViewId })
      if (onRemoveReplyView) {
        await onRemoveReplyView(replyViewId)
      }
    },
    [onRemoveReplyView]
  )

  useEffect(() => {
    const autoExpand = async () => {
      const channelIds = new Set<string>()
      for (const channel of channelsWithNewMessages) channelIds.add(channel.id)
      for (const channelId of state.replyViewsByChannel.keys()) channelIds.add(channelId)
      if (channelIds.size === 0) return

      const updatedExpanded = new Set(state.expandedChannels)
      const updatedData = new Map(state.expandedChannelData)

      for (const channelId of channelIds) {
        const channel = state.channels.find((c) => c.id === channelId)
        if (!channel) continue
        if (!updatedExpanded.has(channelId)) {
          updatedExpanded.add(channelId)
          updatedData.set(channelId, {
            channelId,
            messages: [],
            isLoading: replyViewMode ? false : true,
            hasMoreOlderMessages: true,
          })
        }
      }

      dispatch({ type: 'SET_EXPANDED_CHANNELS', expandedChannels: updatedExpanded, expandedChannelData: updatedData })

      if (!replyViewMode) {
        for (const channelId of channelIds) {
          const channel = state.channels.find((c) => c.id === channelId)
          if (!channel) continue
          try {
            const messages = await loadMessagesForChannelInternal(channel)
            dispatch({
              type: 'SET_EXPANDED_CHANNEL_DATA',
              channelId: channel.id,
              data: {
                channelId: channel.id,
                messages,
                isLoading: false,
                hasMoreOlderMessages: true,
              },
            })
          } catch {
            dispatch({
              type: 'SET_EXPANDED_CHANNEL_DATA',
              channelId: channel.id,
              data: {
                channelId: channel.id,
                messages: [],
                isLoading: false,
                hasMoreOlderMessages: true,
              },
            })
          }
        }
      }
    }

    void autoExpand()
  }, [channelsWithNewMessages, state.replyViewsByChannel, state.channels, state.expandedChannels, state.expandedChannelData, loadMessagesForChannelInternal, replyViewMode])



  // Subscribe to real-time message events and update cache + UI
  useEffect(() => {
    if (!client) return // Archive-only mode - no real-time updates

    const platform = client.type

    // Handle new messages
    client.onMessage((msg) => {
      upsertCachedMessage(platform, msg.channelId, msg)

      // If this channel is expanded in unified view, update its messages
      if (state.expandedChannels.has(msg.channelId)) {
        const cached = getCachedMessages(platform, msg.channelId)
        if (cached) {
          dispatch({
            type: 'SET_EXPANDED_CHANNEL_DATA',
            channelId: msg.channelId,
            data: {
              channelId: msg.channelId,
              messages: cached.messages,
              isLoading: false,
              hasMoreOlderMessages: true,
            },
          })
        }
      }
    })

    // Handle message updates (edits, reactions)
    client.onMessageUpdate((msg) => {
      upsertCachedMessage(platform, msg.channelId, msg)

      // If this channel is expanded in unified view, update its messages
      if (state.expandedChannels.has(msg.channelId)) {
        const cached = getCachedMessages(platform, msg.channelId)
        if (cached) {
          dispatch({
            type: 'SET_EXPANDED_CHANNEL_DATA',
            channelId: msg.channelId,
            data: {
              channelId: msg.channelId,
              messages: cached.messages,
              isLoading: false,
              hasMoreOlderMessages: true,
            },
          })
        }
      }
    })

    // Handle message deletions
    client.onMessageDelete((channelId, messageId) => {
      deleteCachedMessage(platform, channelId, messageId)

      // If this channel is expanded in unified view, update its messages
      if (state.expandedChannels.has(channelId)) {
        const cached = getCachedMessages(platform, channelId)
        if (cached) {
          dispatch({
            type: 'SET_EXPANDED_CHANNEL_DATA',
            channelId: channelId,
            data: {
              channelId: channelId,
              messages: cached.messages,
              isLoading: false,
              hasMoreOlderMessages: true,
            },
          })
        }
      }
    })
  }, [client]) // Only register once per client

  // Refresh channel list (for inbox)
  const refreshChannels = useCallback(async () => {
    if (!onRefreshChannels) return

    dispatch({ type: 'SET_LOADING', loading: true })
    dispatch({ type: 'SET_STATUS', text: 'Refreshing inbox...' })
    try {
      const { channels, displayItems, replyViewsByChannel } = await onRefreshChannels()
      dispatch({ type: 'SET_CHANNELS', channels, displayItems })
      if (replyViewsByChannel) {
        dispatch({ type: 'SET_REPLY_VIEWS', replyViews: replyViewsByChannel })
      }
      // Reset selection to first non-header
      let newIndex = 0
      for (let i = 0; i < displayItems.length; i++) {
        if (!displayItems[i].startsWith('══════')) {
          newIndex = i
          break
        }
      }
      dispatch({ type: 'SELECT_CHANNEL_INDEX', index: newIndex })
    } catch (err) {
      dispatch({
        type: 'SET_STATUS',
        text: `❌ Error refreshing: ${
          err instanceof Error ? err.message : 'Unknown'
        }`,
      })
    }
    dispatch({ type: 'SET_LOADING', loading: false })
  }, [onRefreshChannels])

  // Follow a channel (add to following)
  const followChannel = useCallback(async () => {
    if (!onFollowChannel) return

    const channel = getChannelFromDisplayIndex
      ? getChannelFromDisplayIndex(state.selectedChannelIndex, state.channels)
      : state.channels[state.selectedChannelIndex]

    if (!channel) return

    dispatch({ type: 'SET_LOADING', loading: true })
    dispatch({ type: 'SET_STATUS', text: 'Following channel...' })
    try {
      const { channels, displayItems } = await onFollowChannel(channel)
      dispatch({ type: 'SET_CHANNELS', channels, displayItems })
      dispatch({
        type: 'SET_STATUS',
        text: `✓ Following ${channel.name}`,
      })
    } catch (err) {
      dispatch({
        type: 'SET_STATUS',
        text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
      })
    }
    dispatch({ type: 'SET_LOADING', loading: false })
  }, [onFollowChannel, getChannelFromDisplayIndex, state.selectedChannelIndex, state.channels])

  // Unfollow a channel (move to unfollowed)
  const unfollowChannel = useCallback(async () => {
    if (!onUnfollowChannel) return

    const channel = getChannelFromDisplayIndex
      ? getChannelFromDisplayIndex(state.selectedChannelIndex, state.channels)
      : state.channels[state.selectedChannelIndex]

    if (!channel) return

    dispatch({ type: 'SET_LOADING', loading: true })
    dispatch({ type: 'SET_STATUS', text: 'Unfollowing channel...' })
    try {
      const { channels, displayItems } = await onUnfollowChannel(channel)
      dispatch({ type: 'SET_CHANNELS', channels, displayItems })
      dispatch({
        type: 'SET_STATUS',
        text: `✓ Unfollowed ${channel.name}`,
      })
    } catch (err) {
      dispatch({
        type: 'SET_STATUS',
        text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
      })
    }
    dispatch({ type: 'SET_LOADING', loading: false })
  }, [onUnfollowChannel, getChannelFromDisplayIndex, state.selectedChannelIndex, state.channels])

  // Load messages for selected channel
  const loadMessages = useCallback(
    async (channel: ChannelInfo) => {
      dispatch({ type: 'SET_LOADING', loading: true })
      dispatch({
        type: 'SET_STATUS',
        text: `Loading messages from ${channel.name}...`,
      })
      try {
        let messages: MessageInfo[] = await getMessagesForChannel(channel, 100) // Use the prop
        
        dispatch({ type: 'SET_MESSAGES', messages })
        dispatch({
          type: 'SET_STATUS',
          text: `${channel.guildName ? `${channel.guildName} / ` : ''}${
            channel.name
          } - ↑↓ select${client ? ' · d=del r=reply e=react i=new' : ''} ←=back`,
        })
      } catch (err) {
        dispatch({
          type: 'SET_STATUS',
          text: `❌ Error loading messages: ${
            err instanceof Error ? err.message : 'Unknown'
          }`,
        })
      }
      dispatch({ type: 'SET_LOADING', loading: false })
    },
    [client, getMessagesForChannel]
  )

  // Refresh messages after an action (preserves selection)
  const refreshMessages = useCallback(
    async (channel: ChannelInfo) => {
      try {
        let messages: MessageInfo[] = await getMessagesForChannel(channel, 100) // Use the prop
        dispatch({ type: 'REFRESH_MESSAGES', messages })
      } catch {
        // Silently fail refresh - user already saw the action confirmation
      }
    },
    [client, getMessagesForChannel]
  )

  // Load older messages
  const loadOlder = useCallback(async () => {
    if (
      state.isLoadingOlderMessages ||
      !state.hasMoreOlderMessages ||
      state.messages.length === 0
    )
      return

    if (!client) { // Only allow loading older from live client
      dispatch({ type: 'SET_HAS_MORE_OLDER', hasMore: false })
      dispatch({ type: 'SET_STATUS', text: 'Not in live mode - all messages loaded' })
      return
    }

    dispatch({ type: 'SET_LOADING_OLDER', loading: true })
    dispatch({ type: 'SET_STATUS', text: 'Loading older messages...' })

    const oldestId = state.messages[0].id

    try {
      const { messages, newCount, hasMore } = await getOlderMessagesForChannel( // Use the prop
        state.selectedChannel!,
        oldestId,
        20
      )

      if (newCount === 0) {
        dispatch({ type: 'SET_HAS_MORE_OLDER', hasMore: false })
        dispatch({ type: 'SET_STATUS', text: 'No more older messages' })
      } else {
        dispatch({
          type: 'PREPEND_MESSAGES',
          messages,
          count: newCount,
        })
        dispatch({ type: 'SET_HAS_MORE_OLDER', hasMore })
        dispatch({
          type: 'SET_STATUS',
          text: `Loaded ${newCount} older messages`,
        })
      }
    } catch (err) {
      dispatch({
        type: 'SET_STATUS',
        text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
      })
    }

    dispatch({ type: 'SET_LOADING_OLDER', loading: false })
  }, [client, state, getOlderMessagesForChannel])

  // Send or edit message or add reaction
  const sendMessage = useCallback(
    async (text: string) => {
      if (!state.selectedChannel || !text.trim()) return

      // Archive-only mode: no sending
      if (!client) {
        dispatch({ type: 'SET_STATUS', text: '❌ Archive mode - read only' })
        return
      }

      // Handle reacting to a message
      if (state.reactingToMessageId) {
        const emoji = text.trim()
        dispatch({ type: 'SET_STATUS', text: `Adding reaction ${emoji}...` })
        try {
          // Get message info
          const channelData = state.expandedChannelData.get(state.selectedChannel.id)
          const msgInfo = channelData?.messages.find(m => m.id === state.reactingToMessageId)

          if (!msgInfo) {
            dispatch({ type: 'SET_STATUS', text: '❌ Message not found' })
            dispatch({ type: 'RESET_MESSAGE_STATE' })
            dispatch({ type: 'SET_FOCUS_MODE', mode: 'navigation' })
            return
          }

          // Try to resolve emoji for Discord
          let resolvedEmoji = emoji
          if (client.type === 'discord') {
            const nativeClient = client.getNativeClient()
            const channel = await nativeClient.channels.fetch(state.selectedChannel.id)
            if (channel) {
              const resolved = await resolveEmoji(emoji, channel)
              if (resolved) {
                resolvedEmoji = resolved
              }
            }
          }

          await client.addReaction(state.selectedChannel.id, msgInfo.id, resolvedEmoji)
          dispatch({ type: 'SET_STATUS', text: `✅ Reaction ${emoji} added!` })
          dispatch({ type: 'RESET_MESSAGE_STATE' })
          dispatch({ type: 'SET_FOCUS_MODE', mode: 'navigation' })

          // Refresh messages
          const messages = await loadMessagesForChannelInternal(state.selectedChannel)
          dispatch({
            type: 'SET_EXPANDED_CHANNEL_DATA',
            channelId: state.selectedChannel.id,
            data: {
              channelId: state.selectedChannel.id,
              messages,
              isLoading: false,
              hasMoreOlderMessages: true,
            },
          })
        } catch (err) {
          dispatch({
            type: 'SET_STATUS',
            text: `❌ Reaction error: ${err instanceof Error ? err.message : 'Unknown'}`,
          })
          dispatch({ type: 'RESET_MESSAGE_STATE' })
          dispatch({ type: 'SET_FOCUS_MODE', mode: 'navigation' })
        }
        return
      }

      // Handle editing existing message
      if (state.editingMessageId && state.editingChannelId) {
        dispatch({ type: 'SET_LOADING', loading: true })
        dispatch({ type: 'SET_STATUS', text: 'Editing message...' })
        try {
          await client.editMessage(state.editingChannelId, state.editingMessageId, text.trim())
          dispatch({ type: 'RESET_MESSAGE_STATE' })
          dispatch({ type: 'SET_FOCUS_MODE', mode: 'navigation' })
          dispatch({ type: 'SET_STATUS', text: '✅ Message edited!' })

          // Refresh messages for this channel
          const channel = state.channels.find(c => c.id === state.editingChannelId)
          if (channel) {
            const messages = await loadMessagesForChannelInternal(channel)
            dispatch({
              type: 'SET_EXPANDED_CHANNEL_DATA',
              channelId: channel.id,
              data: {
                channelId: channel.id,
                messages,
                isLoading: false,
                hasMoreOlderMessages: true,
              },
            })
          }
        } catch (err) {
          dispatch({
            type: 'SET_STATUS',
            text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
          })
        }
        dispatch({ type: 'SET_LOADING', loading: false })
        return
      }

      dispatch({ type: 'SET_LOADING', loading: true })
      dispatch({ type: 'SET_STATUS', text: 'Sending message...' })

      try {
        // Parse /attach commands (supports escaped spaces like "file\ name.txt")
        let messageText = text
        const attachRegex = /\/attach\s+((?:\\\s|\S)+)/g
        const attachmentPaths: string[] = []
        let match
        while ((match = attachRegex.exec(text)) !== null) {
          attachmentPaths.push(match[1])
          messageText = messageText.replace(match[0], '').trim()
        }

        // Check for LLM rewrite (llm:// prefix or \\:llm suffix)
        if (
          messageText.startsWith('llm://') ||
          messageText.endsWith('\\\\:llm')
        ) {
          const cleanText = messageText
            .replace(/^llm:\/\//, '')
            .replace(/\\\\:llm$/, '')
            .trim()
          // Build context for LLM from expanded channel data
          const channelData = state.expandedChannelData.get(state.selectedChannel.id)
          const llmContext: LLMContext = {
            channelName: state.selectedChannel?.name,
            guildName: state.selectedChannel?.guildName,
            recentMessages: channelData?.messages.slice(-10).map((m) => ({
              author: m.author,
              content: m.content,
            })),
          }
          const processed = await rewriteMessageWithLLM(cleanText, llmContext)
          dispatch({ type: 'SET_LLM_TEXTS', original: cleanText, processed })
          dispatch({ type: 'SET_VIEW', view: 'llmReview' })
          dispatch({
            type: 'SET_STATUS',
            text: 'LLM Review - p=processed o=original e=edit Esc=cancel',
          })
          dispatch({ type: 'SET_LOADING', loading: false })
          return
        }

        // Build attachments array
        const attachments: Array<{ path: string; name: string }> = []
        for (const file of state.attachedFiles) {
          attachments.push(file)
        }
        for (const filePath of attachmentPaths) {
          attachFile(filePath, attachments)
        }

        // Send message via platform client
        const targetChannelId = state.activeReplyTargetChannelId || state.selectedChannel.id
        await client.sendMessage({
          content: messageText,
          channelId: targetChannelId,
          replyToMessageId: state.replyingToMessageId || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        })

        if (state.activeReplyViewId && state.activeReplyViewChannelId) {
          await discardReplyView(state.activeReplyViewId, state.activeReplyViewChannelId)
        }

        dispatch({ type: 'RESET_MESSAGE_STATE' })
        dispatch({ type: 'SET_FOCUS_MODE', mode: 'navigation' })
        dispatch({ type: 'SET_STATUS', text: '✅ Message sent!' })

        // Refresh messages for this channel
        const messages = await loadMessagesForChannelInternal(state.selectedChannel)
        dispatch({
          type: 'SET_EXPANDED_CHANNEL_DATA',
          channelId: state.selectedChannel.id,
          data: {
            channelId: state.selectedChannel.id,
            messages,
            isLoading: false,
            hasMoreOlderMessages: true,
          },
        })
      } catch (err) {
        dispatch({
          type: 'SET_STATUS',
          text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
        })
      }

      dispatch({ type: 'SET_LOADING', loading: false })
    },
    [
      client,
      state.selectedChannel,
      state.attachedFiles,
      state.replyingToMessageId,
      state.reactingToMessageId,
      state.editingMessageId,
      state.editingChannelId,
      state.activeReplyTargetChannelId,
      state.activeReplyViewId,
      state.activeReplyViewChannelId,
      state.channels,
      state.expandedChannelData,
      loadMessagesForChannelInternal,
      discardReplyView,
    ]
  )

  // Delete message
  const deleteMessage = useCallback(async () => {
    if (state.selectedMessageIndex < 0 || !state.selectedChannel) return

    // Archive-only mode: no deleting
    if (!client) {
      dispatch({ type: 'SET_STATUS', text: '❌ Archive mode - read only' })
      return
    }

    const msgInfo = state.messages[state.selectedMessageIndex]
    const currentUser = client.getCurrentUser()

    if (!currentUser) {
      dispatch({ type: 'SET_STATUS', text: '❌ User not found' })
      return
    }

    if (msgInfo.authorId !== currentUser.id) {
      dispatch({
        type: 'SET_STATUS',
        text: '❌ Can only delete your own messages',
      })
      return
    }

    try {
      await client.deleteMessage(state.selectedChannel.id, msgInfo.id)
      dispatch({ type: 'SET_STATUS', text: '✅ Message deleted' })
      await loadMessagesForChannelInternal(state.selectedChannel) // Updated
    } catch (err) {
      dispatch({
        type: 'SET_STATUS',
        text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
      })
    }
  }, [client, state, loadMessagesForChannelInternal]) // Updated

  // Add reaction
  const addReaction = useCallback(
    async (emoji: string) => {
      if (state.selectedMessageIndex < 0 || !state.selectedChannel) return

      // Archive-only mode: no reactions
      if (!client) {
        dispatch({ type: 'SET_STATUS', text: '❌ Archive mode - read only' })
        return
      }

      // Get message from expanded channel data (unified view)
      const channelData = state.expandedChannelData.get(state.selectedChannel.id)
      if (!channelData || !channelData.messages[state.selectedMessageIndex]) {
        dispatch({ type: 'SET_STATUS', text: '❌ Message not found' })
        return
      }
      const msgInfo = channelData.messages[state.selectedMessageIndex]

      dispatch({ type: 'SET_STATUS', text: `Adding reaction ${emoji}...` })

      try {
        // Try to resolve emoji for Discord (use native client for platform-specific logic)
        let resolvedEmoji = emoji
        if (client.type === 'discord') {
          const nativeClient = client.getNativeClient()
          const channel = await nativeClient.channels.fetch(state.selectedChannel.id)
          if (channel) {
            const resolved = await resolveEmoji(emoji, channel)
            if (resolved) {
              resolvedEmoji = resolved
            }
          }
        }

        await client.addReaction(state.selectedChannel.id, msgInfo.id, resolvedEmoji)
        dispatch({ type: 'SET_STATUS', text: `✅ Reaction ${emoji} added!` })
        dispatch({ type: 'SET_VIEW', view: 'unified' })
        dispatch({ type: 'SET_INPUT_TEXT', text: '' })
        // Refresh messages for both legacy view and expanded channel data
        await loadMessagesForChannelInternal(state.selectedChannel) // Updated
        const messages = await loadMessagesForChannelInternal(state.selectedChannel)
        dispatch({
          type: 'SET_EXPANDED_CHANNEL_DATA',
          channelId: state.selectedChannel.id,
          data: {
            channelId: state.selectedChannel.id,
            messages,
            isLoading: false,
            hasMoreOlderMessages: true,
          },
        })
      } catch (err) {
        dispatch({
          type: 'SET_STATUS',
          text: `❌ Reaction error: ${err instanceof Error ? err.message : 'Unknown'}`,
        })
        dispatch({ type: 'SET_VIEW', view: 'unified' })
        dispatch({ type: 'SET_INPUT_TEXT', text: '' })
      }
    },
    [client, state.selectedMessageIndex, state.selectedChannel, state.expandedChannelData, loadMessagesForChannelInternal]
  )

  // Open URLs from message
  const openUrls = useCallback(async () => {
    if (state.selectedMessageIndex < 0) return

    const msgInfo = state.messages[state.selectedMessageIndex]
    const urls = extractUrls(msgInfo.content)

    if (urls.length === 0) {
      dispatch({ type: 'SET_STATUS', text: 'No URLs in this message' })
      return
    }

    for (const url of urls) {
      await openUrlInBrowser(url)
    }
    dispatch({ type: 'SET_STATUS', text: `Opened ${urls.length} URL(s)` })
  }, [state])

  // Download attachments
  const downloadAttachments = useCallback(async () => {
    if (state.selectedMessageIndex < 0) return

    const msgInfo = state.messages[state.selectedMessageIndex]

    if (!msgInfo.hasAttachments || msgInfo.attachments.length === 0) {
      dispatch({ type: 'SET_STATUS', text: 'No attachments on this message' })
      return
    }

    dispatch({ type: 'SET_LOADING', loading: true })
    try {
      await downloadAttachmentsFromInfo(msgInfo.attachments, (status) => {
        dispatch({ type: 'SET_STATUS', text: status })
      })
    } catch (err) {
      dispatch({
        type: 'SET_STATUS',
        text: `❌ Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      })
    }
    dispatch({ type: 'SET_LOADING', loading: false })
  }, [state])

  // Toggle channel expand/collapse and load messages
  const toggleChannelExpand = useCallback(
    async (channel: ChannelInfo) => {
      const isExpanded = state.expandedChannels.has(channel.id)

      if (isExpanded) {
        // Collapse
        dispatch({ type: 'TOGGLE_CHANNEL_EXPAND', channelId: channel.id })
      } else {
        // Expand and load messages
        dispatch({ type: 'EXPAND_CHANNEL', channelId: channel.id })
        dispatch({
          type: 'SET_EXPANDED_CHANNEL_DATA',
          channelId: channel.id,
          data: {
            channelId: channel.id,
            messages: [],
            isLoading: replyViewMode ? false : true,
            hasMoreOlderMessages: true,
          },
        })

        if (!replyViewMode) {
          // Mark as visited
          markChannelVisited(channel.id, undefined, client?.type || 'discord')

          try {
            const messages = await loadMessagesForChannelInternal(channel)
            dispatch({
              type: 'SET_EXPANDED_CHANNEL_DATA',
              channelId: channel.id,
              data: {
                channelId: channel.id,
                messages,
                isLoading: false,
                hasMoreOlderMessages: true,
              },
            })
          } catch {
            dispatch({
              type: 'SET_EXPANDED_CHANNEL_DATA',
              channelId: channel.id,
              data: {
                channelId: channel.id,
                messages: [],
                isLoading: false,
                hasMoreOlderMessages: false,
              },
            })
          }
        } else {
          dispatch({
            type: 'SET_EXPANDED_CHANNEL_DATA',
            channelId: channel.id,
            data: {
              channelId: channel.id,
              messages: [],
              isLoading: false,
              hasMoreOlderMessages: false,
            },
          })
        }
      }
    },
    [state.expandedChannels, loadMessagesForChannelInternal, client?.type, replyViewMode]
  )

  // Refresh all expanded channels
  const refreshAllChannels = useCallback(async () => {
    dispatch({ type: 'SET_LOADING', loading: true })
    dispatch({ type: 'SET_STATUS', text: 'Refreshing...' })

    // First refresh the channel list
    if (onRefreshChannels) {
      const { channels, displayItems: newDisplayItems, replyViewsByChannel } = await onRefreshChannels()
      dispatch({ type: 'SET_CHANNELS', channels, displayItems: newDisplayItems })
      if (replyViewsByChannel) {
        dispatch({ type: 'SET_REPLY_VIEWS', replyViews: replyViewsByChannel })
      }
    }

    // Then refresh messages for expanded channels
    if (!replyViewMode) {
      for (const channelId of state.expandedChannels) {
        const channel = state.channels.find((c) => c.id === channelId)
        if (channel) {
          try {
            const messages = await loadMessagesForChannelInternal(channel)
            dispatch({
              type: 'SET_EXPANDED_CHANNEL_DATA',
              channelId: channel.id,
              data: {
                channelId: channel.id,
                messages,
                isLoading: false,
                hasMoreOlderMessages: true,
              },
            })
          } catch {
            // Keep existing data on error
          }
        }
      }
    }

    dispatch({ type: 'SET_LOADING', loading: false })
    dispatch({
      type: 'SET_STATUS',
      text: `${title}`,
    })
  }, [state.expandedChannels, state.channels, loadMessagesForChannelInternal, onRefreshChannels, title, replyViewMode])
  
  // ==================== KEYBOARD INPUT HANDLING ====================
  useInput(
    useCallback(
      (input, key) => {
        if (state.loading) return // Ignore input when loading

        // Global hotkeys (always active)

        // Viewport scrolling (works in all modes)
        if (key.ctrl && input === 'u') {
          // Scroll up half a page
          const halfPage = Math.floor((state.rows - 3) / 2)
          dispatch({ type: 'SCROLL_VIEWPORT', delta: -halfPage })
          return
        }
        if (key.ctrl && input === 'd') {
          // Scroll down half a page
          const halfPage = Math.floor((state.rows - 3) / 2)
          dispatch({ type: 'SCROLL_VIEWPORT', delta: halfPage })
          return
        }
        if (key.pageUp) {
          // Scroll up one page
          const fullPage = state.rows - 3
          dispatch({ type: 'SCROLL_VIEWPORT', delta: -fullPage })
          return
        }
        if (key.pageDown) {
          // Scroll down one page
          const fullPage = state.rows - 3
          dispatch({ type: 'SCROLL_VIEWPORT', delta: fullPage })
          return
        }

        if (key.escape) {
          if (state.messageDetail) {
            dispatch({ type: 'SET_MESSAGE_DETAIL', detail: null })
            return
          }
          if (state.view === 'llmReview') {
            dispatch({ type: 'SET_VIEW', view: 'unified' })
            dispatch({ type: 'CLEAR_LLM_TEXTS' })
            dispatch({ type: 'SET_STATUS', text: `${title}` })
            return
          }
          if (state.focusMode === 'compose') {
            if (state.activeReplyViewId && state.activeReplyViewChannelId) {
              void discardReplyView(state.activeReplyViewId, state.activeReplyViewChannelId)
            }
            dispatch({ type: 'RESET_MESSAGE_STATE' })
            dispatch({ type: 'SET_FOCUS_MODE', mode: 'navigation' })
            dispatch({ type: 'SET_STATUS', text: `${title}` })
            return
          }
          if (state.readerFocusChannel) {
            dispatch({ type: 'SET_READER_FOCUS', channelId: null })
            return
          }
          // Default escape - exit app
          exit()
          if (onExit) onExit()
          return
        }

        // --- View-specific input ---
        switch (state.view) {
          case 'unified':
            // --- Navigation mode ---
            if (state.focusMode === 'navigation') {
              // Flat list navigation
              if (key.upArrow) {
                dispatch({ type: 'SELECT_FLAT_INDEX', index: state.selectedFlatIndex - 1 })
                return
              }
              if (key.downArrow) {
                dispatch({ type: 'SELECT_FLAT_INDEX', index: state.selectedFlatIndex + 1 })
                return
              }

              const selectedFlatItem = state.flatItems[state.selectedFlatIndex]

              // Enter key on channel or header
              if (key.return || key.tab) {
                if (selectedFlatItem?.type === 'header' && onToggleSection) {
                  const header = selectedFlatItem.sectionName
                  let sectionName: SectionName | null = null
                  if (header.includes('UNFOLLOWED NEW')) sectionName = 'unfollowed_new'
                  else if (header.includes('UNFOLLOWED')) sectionName = 'unfollowed'
                  else if (header.includes('NEW')) sectionName = 'new'
                  else if (header.includes('FOLLOWING')) sectionName = 'following'
                  if (sectionName) {
                    void onToggleSection(sectionName).then(({ channels, displayItems }) => {
                      dispatch({ type: 'SET_CHANNELS', channels, displayItems })
                    })
                  }
                  return
                }
                if (selectedFlatItem?.type === 'channel') {
                  const channel = state.channels.find(c => c.id === selectedFlatItem.channelId)
                  if (channel) {
                    toggleChannelExpand(channel)
                  }
                  return
                }
                if (selectedFlatItem?.type === 'message') {
                  const channelData = state.expandedChannelData.get(selectedFlatItem.channelId)
                  const msg = channelData?.messages[selectedFlatItem.messageIndex]
                  if (msg) {
                    dispatch({ type: 'SET_MESSAGE_DETAIL', detail: {
                      author: msg.author,
                      timestamp: msg.timestamp,
                      content: msg.content,
                      reactions: Array.isArray(msg.reactions) && msg.reactions.length > 0 ? msg.reactions : undefined
                    }})
                  }
                  return
                }
                if (selectedFlatItem?.type === 'draft') {
                  const replyView = findReplyView(selectedFlatItem.channelId, selectedFlatItem.draftId)
                  if (replyView) {
                    startReplyCompose(replyView, selectedFlatItem.channelId)
                  }
                  return
                }
                if (selectedFlatItem?.type === 'input') {
                  // Enter compose mode
                  const channel = state.channels.find(c => c.id === selectedFlatItem.channelId)
                  if (channel) {
                    dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
                  }
                  dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
                  return
                }
              }
              // Other unified view navigation keys
              if (input === 'r') {
                refreshAllChannels()
                return
              }
              if (input === 'i') {
                // Enter compose mode for the currently selected channel/input line
                if (selectedFlatItem?.type === 'draft') {
                  const replyView = findReplyView(selectedFlatItem.channelId, selectedFlatItem.draftId)
                  if (replyView) {
                    startReplyCompose(replyView, selectedFlatItem.channelId)
                  }
                  return
                }
                const inputIdx = findInputIndexForChannel(state.flatItems, getChannelIdFromFlatItem(selectedFlatItem!)!)
                if (inputIdx !== -1) {
                  dispatch({ type: 'SELECT_FLAT_INDEX', index: inputIdx })
                  const channel = state.channels.find(c => c.id === getChannelIdFromFlatItem(selectedFlatItem!)!)
                  if (channel) {
                    dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
                  }
                  dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
                }
                return
              }
              if (input === 'x') {
                if (selectedFlatItem?.type === 'draft') {
                  void discardReplyView(selectedFlatItem.draftId, selectedFlatItem.channelId)
                  dispatch({ type: 'SET_STATUS', text: '🗑️ Reply view discarded' })
                }
                return
              }
              if (input === 'F') { // Shift+F
                const selectedChannelId = getChannelIdFromFlatItem(selectedFlatItem!)
                const channel = state.channels.find(c => c.id === selectedChannelId)
                const channelGroup = (channel as any)?.group

                // Follow if in unfollowed sections, unfollow if in followed sections
                if (channel && (channelGroup === 'unfollowed' || channelGroup === 'unfollowed_new') && onFollowChannel) {
                  void onFollowChannel(channel).then(({ channels, displayItems }) => {
                    dispatch({ type: 'SET_CHANNELS', channels, displayItems })
                  })
                } else if (channel && (channelGroup === 'following' || channelGroup === 'new') && onUnfollowChannel) {
                  void onUnfollowChannel(channel).then(({ channels, displayItems }) => {
                    dispatch({ type: 'SET_CHANNELS', channels, displayItems })
                  })
                }
                return
              }
              if (input === 'j') {
                const selectedChannelId = getChannelIdFromFlatItem(selectedFlatItem!)
                if (selectedChannelId) {
                  dispatch({ type: 'SET_READER_FOCUS', channelId: selectedChannelId })
                }
                return
              }
              if (input === 'o') { // Open URLs
                const selectedChannelId = getChannelIdFromFlatItem(selectedFlatItem!)
                const channelData = state.expandedChannelData.get(selectedChannelId!)
                if (selectedFlatItem?.type === 'message' && channelData) {
                  const msg = channelData.messages[selectedFlatItem.messageIndex]
                  if (msg) {
                    const urls = extractUrls(msg.content)
                    if (urls.length === 0) {
                      dispatch({ type: 'SET_STATUS', text: 'No URLs in this message' })
                    } else {
                      for (const url of urls) {
                        openUrlInBrowser(url)
                      }
                      dispatch({ type: 'SET_STATUS', text: `Opened ${urls.length} URL${urls.length > 1 ? 's' : ''}` })
                    }
                  }
                }
                return
              }
              if (input === 'a') { // Download attachments
                const selectedChannelId = getChannelIdFromFlatItem(selectedFlatItem!)
                const channelData = state.expandedChannelData.get(selectedChannelId!)
                if (selectedFlatItem?.type === 'message' && channelData) {
                  const msg = channelData.messages[selectedFlatItem.messageIndex]
                  if (msg) {
                    if (!msg.attachments || msg.attachments.length === 0) {
                      dispatch({ type: 'SET_STATUS', text: 'No attachments on this message' })
                    } else {
                      dispatch({ type: 'SET_LOADING', loading: true })
                      void downloadAttachmentsFromInfo(msg.attachments, (status) => {
                        dispatch({ type: 'SET_STATUS', text: status })
                      }).catch((err) => {
                        dispatch({ type: 'SET_STATUS', text: `❌ Download failed: ${err instanceof Error ? err.message : 'Unknown error'}` })
                      }).finally(() => {
                        dispatch({ type: 'SET_LOADING', loading: false })
                      })
                    }
                  }
                }
                return
              }
              if (input === 'v') {
                if (selectedFlatItem?.type === 'message') {
                  const channelData = state.expandedChannelData.get(selectedFlatItem.channelId)
                  const msg = channelData?.messages[selectedFlatItem.messageIndex]
                  if (msg) {
                    dispatch({ type: 'SET_MESSAGE_DETAIL', detail: {
                      author: msg.author,
                      timestamp: msg.timestamp,
                      content: msg.content,
                      reactions: Array.isArray(msg.reactions) && msg.reactions.length > 0 ? msg.reactions : undefined
                    }})
                  }
                }
                if (selectedFlatItem?.type === 'draft') {
                  const replyView = findReplyView(selectedFlatItem.channelId, selectedFlatItem.draftId)
                  if (replyView) {
                    const detail = formatReplyViewDetail(replyView)
                    dispatch({ type: 'SET_MESSAGE_DETAIL', detail })
                  }
                }
                return
              }
              if (input === 'd') {
                // Delete message
                if (selectedFlatItem?.type === 'message' && client) {
                  const channelData = state.expandedChannelData.get(selectedFlatItem.channelId)
                  const msg = channelData?.messages[selectedFlatItem.messageIndex]
                  const currentUser = client.getCurrentUser()
                  if (msg && currentUser && msg.authorId === currentUser.id) {
                    dispatch({ type: 'SET_STATUS', text: '🗑️  Deleting message...' })
                    void (async () => {
                      try {
                        await client.deleteMessage(selectedFlatItem.channelId, msg.id)
                        // Clear from cache immediately
                        deleteCachedMessage(client.type, selectedFlatItem.channelId, msg.id)
                        dispatch({ type: 'SET_STATUS', text: '✅ Message deleted' })
                        // Refresh channel messages from cache
                        const channel = state.channels.find(c => c.id === selectedFlatItem.channelId)
                        if (channel) {
                          const cached = getCachedMessages(client.type, channel.id)
                          if (cached) {
                            dispatch({
                              type: 'SET_EXPANDED_CHANNEL_DATA',
                              channelId: channel.id,
                              data: {
                                channelId: channel.id,
                                messages: cached.messages,
                                isLoading: false,
                                hasMoreOlderMessages: true,
                              },
                            })
                          }
                        }
                      } catch (err) {
                        dispatch({
                          type: 'SET_STATUS',
                          text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
                        })
                      }
                    })()
                  } else if (msg && currentUser && msg.authorId !== currentUser.id) {
                    dispatch({ type: 'SET_STATUS', text: '❌ Can only delete your own messages' })
                  }
                }
                return
              }
              if (input === 'r' || input === 'R') {
                // Reply to message
                if (selectedFlatItem?.type === 'message') {
                  const channelData = state.expandedChannelData.get(selectedFlatItem.channelId)
                  const msg = channelData?.messages[selectedFlatItem.messageIndex]
                  if (msg) {
                    dispatch({ type: 'SET_REPLYING_TO', messageId: msg.id })
                    const channel = state.channels.find(c => c.id === selectedFlatItem.channelId)
                    if (channel) {
                      dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
                    }
                    const inputIdx = findInputIndexForChannel(state.flatItems, selectedFlatItem.channelId)
                    if (inputIdx !== -1) {
                      dispatch({ type: 'SELECT_FLAT_INDEX', index: inputIdx })
                    }
                    dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
                  }
                }
                return
              }
              if (input === 'e') {
                // React to message
                if (selectedFlatItem?.type === 'message' && client) {
                  const channelData = state.expandedChannelData.get(selectedFlatItem.channelId)
                  const msg = channelData?.messages[selectedFlatItem.messageIndex]
                  if (msg) {
                    const channel = state.channels.find(c => c.id === selectedFlatItem.channelId)
                    if (channel) {
                      dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
                    }
                    dispatch({ type: 'SET_REACTING_TO', messageId: msg.id })
                    const inputIdx = findInputIndexForChannel(state.flatItems, selectedFlatItem.channelId)
                    if (inputIdx !== -1) {
                      dispatch({ type: 'SELECT_FLAT_INDEX', index: inputIdx })
                    }
                    dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
                    dispatch({ type: 'SET_STATUS', text: 'Enter emoji to react (e.g., 👍 or :thumbsup:)' })
                  }
                }
                return
              }
              if (input === 't') {
                // Edit message
                if (selectedFlatItem?.type === 'message' && client) {
                  const channelData = state.expandedChannelData.get(selectedFlatItem.channelId)
                  const msg = channelData?.messages[selectedFlatItem.messageIndex]
                  const currentUser = client.getCurrentUser()
                  if (msg && currentUser && msg.authorId === currentUser.id) {
                    const channel = state.channels.find(c => c.id === selectedFlatItem.channelId)
                    if (channel) {
                      dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
                    }
                    dispatch({
                      type: 'SET_EDITING',
                      messageId: msg.id,
                      channelId: selectedFlatItem.channelId,
                      originalContent: msg.content
                    })
                    const inputIdx = findInputIndexForChannel(state.flatItems, selectedFlatItem.channelId)
                    if (inputIdx !== -1) {
                      dispatch({ type: 'SELECT_FLAT_INDEX', index: inputIdx })
                    }
                    dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
                  } else if (msg && currentUser && msg.authorId !== currentUser.id) {
                    dispatch({ type: 'SET_STATUS', text: '❌ Can only edit your own messages' })
                  }
                }
                return
              }
              if (input === 'k') {
                const selectedChannelId = getChannelIdFromFlatItem(selectedFlatItem!)
                if (selectedChannelId) {
                  markChannelVisited(selectedChannelId, undefined, client?.type || 'discord')
                  if (onRefreshChannels) {
                    void onRefreshChannels().then(({ channels, displayItems }) => {
                      dispatch({ type: 'SET_CHANNELS', channels, displayItems })
                    })
                  }
                }
                return
              }
              if (input === 'c') {
                // Copy Discord link for selected message or channel
                if (selectedFlatItem?.type === 'message') {
                  const channelData = state.expandedChannelData.get(selectedFlatItem.channelId)
                  const msg = channelData?.messages[selectedFlatItem.messageIndex]
                  const channel = state.channels.find(c => c.id === selectedFlatItem.channelId)
                  if (msg && channel) {
                    const link = generateDiscordMessageLink(channel.id, msg.id, channel.guildId)
                    void copyToClipboard(link).then(() => {
                      dispatch({ type: 'SET_STATUS', text: `📋 Copied message link: ${link}` })
                    }).catch((err) => {
                      dispatch({ type: 'SET_STATUS', text: `❌ Failed to copy: ${err instanceof Error ? err.message : 'Unknown error'}` })
                    })
                  }
                } else if (selectedFlatItem?.type === 'channel') {
                  const channel = state.channels.find(c => c.id === selectedFlatItem.channelId)
                  if (channel) {
                    const link = generateDiscordChannelLink(channel.id, channel.guildId)
                    void copyToClipboard(link).then(() => {
                      dispatch({ type: 'SET_STATUS', text: `📋 Copied channel link: ${link}` })
                    }).catch((err) => {
                      dispatch({ type: 'SET_STATUS', text: `❌ Failed to copy: ${err instanceof Error ? err.message : 'Unknown error'}` })
                    })
                  }
                }
                return
              }
            }
            // --- Compose mode (handled by SimpleTextInput) ---
            // --- Reader mode ---
            if (state.focusMode === 'reader' && state.readerFocusChannel) {
              const channelData = state.expandedChannelData.get(state.readerFocusChannel)
              if (!channelData || channelData.messages.length === 0) return

              const totalMessages = channelData.messages.length
              const visibleCount = Math.min(DEFAULT_VISIBLE_MESSAGES, totalMessages)

              if (key.upArrow) {
                // Scroll message list up
                if (state.readerSelectedMessageOffset > 0) {
                  dispatch({ type: 'SET_READER_SELECTED_MESSAGE_OFFSET', offset: state.readerSelectedMessageOffset - 1 })
                } else {
                  // Try to scroll the channel's message window up (show older messages)
                  dispatch({ type: 'SCROLL_CHANNEL_MESSAGES', channelId: state.readerFocusChannel, delta: 1 })
                }
                return
              }
              if (key.downArrow) {
                // Scroll message list down
                if (state.readerSelectedMessageOffset < visibleCount - 1) {
                  dispatch({ type: 'SET_READER_SELECTED_MESSAGE_OFFSET', offset: state.readerSelectedMessageOffset + 1 })
                } else {
                  // Try to scroll the channel's message window down (show newer messages)
                  dispatch({ type: 'SCROLL_CHANNEL_MESSAGES', channelId: state.readerFocusChannel, delta: -1 })
                }
                return
              }
              if (input === 'h') { // Go to previous channel in reader mode
                const currentChannelIdx = state.channels.findIndex(c => c.id === state.readerFocusChannel)
                if (currentChannelIdx > 0) {
                  const prevChannel = state.channels[currentChannelIdx - 1]
                  dispatch({ type: 'SET_READER_FOCUS', channelId: prevChannel.id })
                }
                return
              }
              if (input === 'l') { // Go to next channel in reader mode
                const currentChannelIdx = state.channels.findIndex(c => c.id === state.readerFocusChannel)
                if (currentChannelIdx < state.channels.length - 1) {
                  const nextChannel = state.channels[currentChannelIdx + 1]
                  dispatch({ type: 'SET_READER_FOCUS', channelId: nextChannel.id })
                }
                return
              }
              const readerOffset = state.channelMessageOffsets.get(state.readerFocusChannel) || 0
              const endIdx = Math.min(readerOffset + DEFAULT_VISIBLE_MESSAGES, channelData.messages.length)
              const selectedMsg = channelData.messages[(endIdx - 1) - state.readerSelectedMessageOffset]

              if (input === 'a' && selectedMsg) {
                if (!selectedMsg.hasAttachments || selectedMsg.attachments.length === 0) {
                  dispatch({ type: 'SET_STATUS', text: 'No attachments on this message' })
                } else {
                  dispatch({ type: 'SET_LOADING', loading: true })
                  void downloadAttachmentsFromInfo(selectedMsg.attachments, (status) => {
                    dispatch({ type: 'SET_STATUS', text: status })
                  }).catch((err) => {
                    dispatch({ type: 'SET_STATUS', text: `❌ Download failed: ${err instanceof Error ? err.message : 'Unknown error'}` })
                  }).finally(() => {
                    dispatch({ type: 'SET_LOADING', loading: false })
                  })
                }
                return
              }
              if (input === 'o' && selectedMsg) {
                const urls = extractUrls(selectedMsg.content)
                if (urls.length === 0) {
                  dispatch({ type: 'SET_STATUS', text: 'No URLs in this message' })
                } else {
                  for (const url of urls) {
                    openUrlInBrowser(url)
                  }
                  dispatch({ type: 'SET_STATUS', text: `Opened ${urls.length} URL${urls.length > 1 ? 's' : ''}` })
                }
                return
              }
              if (input === 'v' && selectedMsg) {
                dispatch({ type: 'SET_MESSAGE_DETAIL', detail: {
                  author: selectedMsg.author,
                  timestamp: selectedMsg.timestamp,
                  content: selectedMsg.content,
                  reactions: Array.isArray(selectedMsg.reactions) && selectedMsg.reactions.length > 0 ? selectedMsg.reactions : undefined
                }})
                return
              }
              if (input === 'd' && selectedMsg && client) {
                // Delete message in reader mode
                const currentUser = client.getCurrentUser()
                if (currentUser && selectedMsg.authorId === currentUser.id) {
                  dispatch({ type: 'SET_STATUS', text: '🗑️  Deleting message...' })
                  void (async () => {
                    try {
                      await client.deleteMessage(state.readerFocusChannel!, selectedMsg.id)
                      // Clear from cache immediately
                      deleteCachedMessage(client.type, state.readerFocusChannel!, selectedMsg.id)
                      dispatch({ type: 'SET_STATUS', text: '✅ Message deleted' })
                      // Refresh channel messages from cache
                      const channel = state.channels.find(c => c.id === state.readerFocusChannel)
                      if (channel) {
                        const cached = getCachedMessages(client.type, channel.id)
                        if (cached) {
                          dispatch({
                            type: 'SET_EXPANDED_CHANNEL_DATA',
                            channelId: channel.id,
                            data: {
                              channelId: channel.id,
                              messages: cached.messages,
                              isLoading: false,
                              hasMoreOlderMessages: true,
                            },
                          })
                        }
                      }
                    } catch (err) {
                      dispatch({
                        type: 'SET_STATUS',
                        text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
                      })
                    }
                  })()
                } else if (currentUser && selectedMsg.authorId !== currentUser.id) {
                  dispatch({ type: 'SET_STATUS', text: '❌ Can only delete your own messages' })
                }
                return
              }
              if ((input === 'r' || input === 'R') && selectedMsg) {
                // Reply to message in reader mode
                dispatch({ type: 'SET_REPLYING_TO', messageId: selectedMsg.id })
                const channel = state.channels.find(c => c.id === state.readerFocusChannel)
                if (channel) {
                  dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
                }
                const inputIdx = findInputIndexForChannel(state.flatItems, state.readerFocusChannel!)
                if (inputIdx !== -1) {
                  dispatch({ type: 'SELECT_FLAT_INDEX', index: inputIdx })
                }
                dispatch({ type: 'SET_READER_FOCUS', channelId: null })
                dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
                return
              }
              if (input === 'e' && selectedMsg && client) {
                // React to message in reader mode
                const channel = state.channels.find(c => c.id === state.readerFocusChannel)
                if (channel) {
                  dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
                }
                dispatch({ type: 'SET_REACTING_TO', messageId: selectedMsg.id })
                const inputIdx = findInputIndexForChannel(state.flatItems, state.readerFocusChannel!)
                if (inputIdx !== -1) {
                  dispatch({ type: 'SELECT_FLAT_INDEX', index: inputIdx })
                }
                dispatch({ type: 'SET_READER_FOCUS', channelId: null })
                dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
                dispatch({ type: 'SET_STATUS', text: 'Enter emoji to react (e.g., 👍 or :thumbsup:)' })
                return
              }
              if (input === 't' && selectedMsg && client) {
                // Edit message in reader mode
                const currentUser = client.getCurrentUser()
                if (currentUser && selectedMsg.authorId === currentUser.id) {
                  const channel = state.channels.find(c => c.id === state.readerFocusChannel)
                  if (channel) {
                    dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
                  }
                  dispatch({
                    type: 'SET_EDITING',
                    messageId: selectedMsg.id,
                    channelId: state.readerFocusChannel,
                    originalContent: selectedMsg.content
                  })
                  const inputIdx = findInputIndexForChannel(state.flatItems, state.readerFocusChannel!)
                  if (inputIdx !== -1) {
                    dispatch({ type: 'SELECT_FLAT_INDEX', index: inputIdx })
                  }
                  dispatch({ type: 'SET_READER_FOCUS', channelId: null })
                  dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
                } else if (currentUser && selectedMsg.authorId !== currentUser.id) {
                  dispatch({ type: 'SET_STATUS', text: '❌ Can only edit your own messages' })
                }
                return
              }
              if (input === 'k') {
                // Mark channel as read in reader mode
                if (state.readerFocusChannel) {
                  markChannelVisited(state.readerFocusChannel, undefined, client?.type || 'discord')
                  if (onRefreshChannels) {
                    void onRefreshChannels().then(({ channels, displayItems }) => {
                      dispatch({ type: 'SET_CHANNELS', channels, displayItems })
                    })
                  }
                }
                return
              }
              if (input === 'c') {
                // Copy Discord link for selected message in reader mode
                if (selectedMsg && state.readerFocusChannel) {
                  const channel = state.channels.find(c => c.id === state.readerFocusChannel)
                  if (channel) {
                    const link = generateDiscordMessageLink(channel.id, selectedMsg.id, channel.guildId)
                    void copyToClipboard(link).then(() => {
                      dispatch({ type: 'SET_STATUS', text: `📋 Copied message link: ${link}` })
                    }).catch((err) => {
                      dispatch({ type: 'SET_STATUS', text: `❌ Failed to copy: ${err instanceof Error ? err.message : 'Unknown error'}` })
                    })
                  }
                }
                return
              }
              if (input === 'f') {
                // Follow/unfollow channel in reader mode
                const channel = state.channels.find(c => c.id === state.readerFocusChannel)
                if (channel?.isFollowing && onUnfollowChannel) {
                  void onUnfollowChannel(channel).then(({ channels, displayItems }) => {
                    dispatch({ type: 'SET_CHANNELS', channels, displayItems })
                  })
                } else if (channel && onFollowChannel) {
                  void onFollowChannel(channel).then(({ channels, displayItems }) => {
                    dispatch({ type: 'SET_CHANNELS', channels, displayItems })
                  })
                }
                return
              }
              if (input === 'j') {
                // Exit reader mode (same as Esc but more explicit)
                dispatch({ type: 'SET_READER_FOCUS', channelId: null })
                return
              }
              if (input === 'q') {
                dispatch({ type: 'SET_MESSAGE_DETAIL', detail: null })
              }
            }
            break
          case 'llmReview':
            if (input === 'o') {
              sendMessage(state.llmOriginalText)
              return
            }
            if (input === 'p') {
              sendMessage(state.llmProcessedText)
              return
            }
            if (input === 'e' || input === 'O') {
              const editText = input === 'e' ? state.llmProcessedText : state.llmOriginalText
              dispatch({ type: 'SET_INPUT_TEXT', text: editText })
              dispatch({ type: 'SET_VIEW', view: 'unified' })
              if (state.selectedChannel) {
                const inputIdx = findInputIndexForChannel(state.flatItems, state.selectedChannel.id)
                if (inputIdx !== -1) {
                  dispatch({ type: 'SELECT_FLAT_INDEX', index: inputIdx })
                }
              }
              dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
              return
            }
            break
        }
      },
      [state, exit, sendMessage, refreshAllChannels, onFollowChannel, onUnfollowChannel, onToggleSection, title, client?.type, addReaction, startReplyCompose, findReplyView, discardReplyView]
    ),
  )

  const commonHelpBindings = [
    { key: '↑↓', label: 'navigate' },
    { key: 'Ctrl+U/D', label: 'scroll' },
    { key: 'Esc', label: 'back/exit' },
    { key: 'R', label: 'refresh' },
  ]
  const hasDrafts = Array.from(state.replyViewsByChannel.values()).some((drafts) => drafts.length > 0)
  let helpBindings: Array<{ key: string; label: string }> = []
  if (state.view === 'unified') {
    if (state.focusMode === 'navigation') {
      if (replyViewMode) {
        helpBindings = [
          ...commonHelpBindings,
          { key: 'Enter/Tab', label: 'edit reply' },
          { key: 'i', label: 'edit reply' },
          { key: 'v', label: 'view details' },
        ]
        if (hasDrafts) {
          helpBindings.push({ key: 'x', label: 'discard reply' })
        }
      } else {
        helpBindings = [
          ...commonHelpBindings,
          { key: 'Enter/Tab', label: 'expand' },
          { key: 'i', label: 'compose' },
          { key: 'd', label: 'delete' },
          { key: 'r', label: 'reply' },
          { key: 'e', label: 'react' },
          { key: 't', label: 'edit' },
          { key: 'v', label: 'view' },
          { key: 'o', label: 'open URL' },
          { key: 'a', label: 'download' },
          { key: 'c', label: 'copy link' },
          { key: 'F', label: 'follow/unfollow' },
          { key: 'j', label: 'reader mode' },
          { key: 'k', label: 'mark read' }
        ]
        if (hasDrafts) {
          helpBindings.push({ key: 'x', label: 'discard reply' })
        }
      }
    } else if (state.focusMode === 'compose') {
      const actionLabel = state.editingMessageId ? 'save edit' : 'send'
      helpBindings = [{ key: 'Enter', label: actionLabel }, { key: 'Esc', label: 'cancel' }]
    } else if (state.focusMode === 'reader') {
      helpBindings = [
        { key: '↑↓', label: 'scroll' },
        { key: 'hl', label: 'prev/next channel' },
        { key: 'd', label: 'delete' },
        { key: 'r', label: 'reply' },
        { key: 'e', label: 'react' },
        { key: 't', label: 'edit' },
        { key: 'v', label: 'view' },
        { key: 'o', label: 'open URL' },
        { key: 'a', label: 'download' },
        { key: 'c', label: 'copy link' },
        { key: 'F', label: 'follow/unfollow' },
        { key: 'j', label: 'exit reader' },
        { key: 'k', label: 'mark read' },
      ]
    }
  } else if (state.view === 'llmReview') {
    helpBindings = [{ key: 'o', label: 'send original' }, { key: 'p', label: 'send processed' }, { key: 'e', label: 'edit processed' }, { key: 'O', label: 'edit original' }, { key: 'Esc', label: 'cancel' }]
  }

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box height={1} width="100%">
        <Text bold>{title}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {state.view === 'unified' && (
          <UnifiedView
            displayItems={state.channelDisplayItems}
            channels={state.channels}
            flatItems={state.flatItems}
            selectedFlatIndex={state.selectedFlatIndex}
            expandedChannels={state.expandedChannels}
            expandedChannelData={state.expandedChannelData}
            replyViewsByChannel={state.replyViewsByChannel}
            focusMode={state.focusMode}
            readerFocusChannel={state.readerFocusChannel}
            readerSelectedMessageOffset={state.readerSelectedMessageOffset}
            channelMessageOffsets={state.channelMessageOffsets}
            replyViewMode={replyViewMode}
            inputText={state.inputText}
            inputCursorPos={state.inputCursorPos}
            onInputChange={(text) => dispatch({ type: 'SET_INPUT_TEXT', text })}
            onCursorChange={(pos) =>
              dispatch({ type: 'SET_INPUT_CURSOR_POS', pos })
            }
            onSubmitUnified={sendMessage}
            replyingToMessageId={state.replyingToMessageId}
            reactingToMessageId={state.reactingToMessageId}
            editingMessageId={state.editingMessageId}
            rows={state.rows}
            cols={state.cols}
            viewportOffset={state.viewportOffset}
            getChannelFromDisplayIndex={getChannelFromDisplayIndex}
          />
        )}
        {state.view === 'llmReview' && (
          <LlmReviewView
            originalText={state.llmOriginalText}
            processedText={state.llmProcessedText}
          />
        )}
        {state.messageDetail && <MessageDetailView message={state.messageDetail} />}
      </Box>
      <HelpBar bindings={helpBindings} />
    </Box>
  )
}
// This is the missing export
export const renderApp = (props: AppProps) => {
  process.stdout.write('\x1b[2J\x1b[H')
  return render(<App {...props} />)
}
