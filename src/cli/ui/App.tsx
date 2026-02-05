/**
 * Shared Ink-based TUI App for Discord CLI tools
 * Single-column layout with view switching
 */

import React, { useReducer, useCallback, useEffect, useState } from 'react'
import { render, Box, Text, useApp, useInput, useStdout } from 'ink'
import { IPlatformClient } from '@/platforms/types'
import type { SectionName } from '../inbox'
import {
  ChannelInfo,
  MessageInfo,
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
} from '../shared'
import { upsertCachedMessage, deleteCachedMessage, getCachedMessages } from '../cache'
import { getMessagesFromArchive, MessageRecord } from '../db'

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
  flatItems: FlatItem[] // Computed flat list of all visible items
  selectedFlatIndex: number // Position in flat list
  focusMode: UnifiedFocusMode // Are we navigating or composing?
  readerFocusChannel: string | null // Channel ID in reader focus mode
  channelMessageOffsets: Map<string, number> // Scroll offset for messages in reader mode
  selectedMessageIndex: number // Deprecated - use flatItems instead
  messageScrollIndex: number

  messages: MessageInfo[]
  hasMoreOlderMessages: boolean
  isLoadingOlderMessages: boolean

  inputText: string
  inputCursorPos: number
  replyingToMessageId: string | null
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
    reactions?: string
  } | null

  // Terminal dimensions
  rows: number
  cols: number
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
  | { type: 'ADD_ATTACHMENT'; file: { path: string; name: string } }
  | { type: 'CLEAR_ATTACHMENTS' }
  | { type: 'SET_LLM_TEXTS'; original: string; processed: string }
  | { type: 'CLEAR_LLM_TEXTS' }
  | { type: 'SET_STATUS'; text: string }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_LOADING_OLDER'; loading: boolean }
  | { type: 'SET_HAS_MORE_OLDER'; hasMore: boolean }
  | { type: 'SET_MESSAGE_DETAIL'; detail: { author: string; timestamp: string; content: string; reactions?: string } | null }
  | { type: 'RESET_MESSAGE_STATE' }
  | { type: 'SET_DIMENSIONS'; rows: number; cols: number }
  // Unified view actions
  | { type: 'TOGGLE_CHANNEL_EXPAND'; channelId: string }
  | { type: 'SET_EXPANDED_CHANNEL_DATA'; channelId: string; data: ExpandedChannelData }
  | { type: 'SET_FOCUS_MODE'; mode: UnifiedFocusMode }
  | { type: 'SET_READER_FOCUS'; channelId: string | null }
  | { type: 'SCROLL_CHANNEL_MESSAGES'; channelId: string; delta: number }
  | { type: 'COLLAPSE_ALL_CHANNELS' }
  | { type: 'EXPAND_CHANNEL'; channelId: string }
  | { type: 'SET_EXPANDED_CHANNELS'; expandedChannels: Set<string>; expandedChannelData: Map<string, ExpandedChannelData> }
  | { type: 'SELECT_FLAT_INDEX'; index: number }
  | { type: 'SET_FLAT_ITEMS'; items: FlatItem[] }

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
          state.selectedMessageIndex >= 0
            ? state.selectedMessageIndex + action.count
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
        attachedFiles: [],
        llmOriginalText: '',
        llmProcessedText: '',
      }
    case 'SET_DIMENSIONS':
      return { ...state, rows: action.rows, cols: action.cols }
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
      if (!newOffsets.has(action.channelId)) {
        // Default to showing the most recent messages
        const data = state.expandedChannelData.get(action.channelId)
        const totalMsgs = data?.messages.length || 0
        newOffsets.set(action.channelId, Math.max(0, totalMsgs - DEFAULT_VISIBLE_MESSAGES))
      }
      return {
        ...state,
        readerFocusChannel: action.channelId,
        focusMode: 'reader',
        channelMessageOffsets: newOffsets,
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
              // Default: show last 5 messages
              startIdx = Math.max(0, data.messages.length - DEFAULT_VISIBLE_MESSAGES)
              endIdx = data.messages.length
            }

            for (let msgIdx = startIdx; msgIdx < endIdx; msgIdx++) {
              const msg = data.messages[msgIdx]
              items.push({
                type: 'message',
                channelId: channel.id,
                messageIndex: msgIdx,
                messageId: msg.id,
              })
            }
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
  if (item.type === 'channel' || item.type === 'message' || item.type === 'input') {
    return item.channelId
  }
  return null
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
          msg.reactions && msg.reactions.length > 0
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
      <Text color="gray">Press Esc to cancel</Text>
    </Box>
  )
}

interface MessageDetailViewProps {
  message: {
    author: string
    timestamp: string
    content: string
    reactions?: string
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
      <Box marginY={1} flexDirection="column">
        {message.content.split('\n').map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      {message.reactions && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow" bold>Reactions:</Text>
          <Text>{message.reactions}</Text>
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
  focusMode: UnifiedFocusMode
  readerFocusChannel: string | null
  inputText: string
  inputCursorPos: number
  onInputChange: (text: string) => void
  onCursorChange: (pos: number) => void
  onSubmit: (text: string) => void
  replyingToMessageId: string | null
  rows: number
  getChannelFromDisplayIndex: (index: number, channels: ChannelInfo[]) => ChannelInfo | null
}

function UnifiedView({
  displayItems,
  channels,
  flatItems,
  selectedFlatIndex,
  expandedChannels,
  expandedChannelData,
  focusMode,
  readerFocusChannel,
  inputText,
  inputCursorPos,
  onInputChange,
  onCursorChange,
  onSubmit,
  replyingToMessageId,
  rows,
  getChannelFromDisplayIndex,
}: UnifiedViewProps) {
  const visibleCount = rows - 4

  // Calculate scroll offset to keep selected item visible
  const scrollOffset = Math.max(0, selectedFlatIndex - Math.floor(visibleCount / 2))

  // Render items with loading/empty states for expanded channels
  const renderedItems: React.ReactNode[] = []
  let flatIdx = 0

  for (let i = 0; i < displayItems.length; i++) {
    const displayItem = displayItems[i]
    const isHeader = displayItem.startsWith('══════')

    if (isHeader) {
      // Find the corresponding flat item
      if (flatIdx < flatItems.length && flatItems[flatIdx].type === 'header') {
        if (flatIdx - scrollOffset >= 0 && flatIdx - scrollOffset < visibleCount) {
          const isSelected = flatIdx === selectedFlatIndex && focusMode === 'navigation'
          renderedItems.push(
            <Text key={`h-${i}`} color={isSelected ? 'green' : 'yellow'} dimColor={!isSelected} inverse={isSelected}>
              {isSelected ? '▶ ' : '  '}{displayItem}
            </Text>
          )
        }
        flatIdx++
      }
    } else {
      const channel = getChannelFromDisplayIndex(i, channels)
      if (!channel) continue

      // Channel line
      if (flatIdx < flatItems.length && flatItems[flatIdx].type === 'channel') {
        if (flatIdx - scrollOffset >= 0 && flatIdx - scrollOffset < visibleCount) {
          const isSelected = flatIdx === selectedFlatIndex && focusMode === 'navigation'
          const isExpanded = expandedChannels.has(channel.id)
          const isReaderFocus = readerFocusChannel === channel.id
          const expandIcon = isExpanded ? '▼' : '▶'
          const readerIndicator = isReaderFocus ? ' 📖' : ''

          renderedItems.push(
            <Text
              key={`c-${channel.id}`}
              inverse={isSelected}
              color={isSelected ? 'green' : isReaderFocus ? 'magenta' : isExpanded ? 'cyan' : 'blackBright'}
            >
              {isSelected ? '▶ ' : '  '}
              {expandIcon} {displayItem}{readerIndicator}
            </Text>
          )
        }
        flatIdx++
      }

      // If expanded, render messages and input
      if (expandedChannels.has(channel.id)) {
        const data = expandedChannelData.get(channel.id)

        if (data?.isLoading) {
          // Show loading state (not in flatItems, inject directly)
          if (flatIdx - scrollOffset >= 0 && flatIdx - scrollOffset < visibleCount) {
            renderedItems.push(
              <Text key={`load-${channel.id}`} color="gray">
                {'    '}⏳ Loading messages...
              </Text>
            )
          }
        } else if (data && data.messages.length === 0) {
          // Show empty state
          if (flatIdx - scrollOffset >= 0 && flatIdx - scrollOffset < visibleCount) {
            renderedItems.push(
              <Text key={`empty-${channel.id}`} color="gray">
                {'    '}(no messages)
              </Text>
            )
          }
        } else if (data) {
          // Render messages based on flatItems (which respects the scroll offset)
          while (flatIdx < flatItems.length) {
            const currentItem = flatItems[flatIdx]
            // Stop if not a message or belongs to different channel
            if (currentItem.type !== 'message') break
            if (currentItem.channelId !== channel.id) break

            if (flatIdx - scrollOffset >= 0 && flatIdx - scrollOffset < visibleCount) {
              const isSelected = flatIdx === selectedFlatIndex && focusMode === 'navigation'
              const msg = data.messages[currentItem.messageIndex]
              if (msg) {
                const attachmentIndicator = msg.hasAttachments
                  ? ` 📎(${msg.attachmentCount})`
                  : ''
                const reactionsText =
                  msg.reactions && msg.reactions.length > 0
                    ? ' ' + msg.reactions.map((r) => `${r.emoji}${r.count}`).join(' ')
                    : ''

                renderedItems.push(
                  <Text
                    key={`msg-${channel.id}-${msg.id}`}
                    inverse={isSelected}
                    color={isSelected ? 'blue' : 'gray'}
                  >
                    {'    '}
                    {isSelected ? '▶ ' : '  '}
                    [{msg.timestamp}] {msg.author}
                    {attachmentIndicator}: {msg.content.split('\n')[0].slice(0, 60)}
                    {msg.content.split('\n')[0].length > 60 ? '...' : ''}
                    {reactionsText}
                  </Text>
                )
              }
            }
            flatIdx++
          }
        }

        // Input line for this channel
        if (flatIdx < flatItems.length && flatItems[flatIdx].type === 'input') {
          if (flatIdx - scrollOffset >= 0 && flatIdx - scrollOffset < visibleCount) {
            const isSelected = flatIdx === selectedFlatIndex
            const isComposing = isSelected && focusMode === 'compose'
            const isInputSelected = isSelected && focusMode === 'navigation'

            renderedItems.push(
              <Box key={`input-${channel.id}`} flexDirection="column">
                {replyingToMessageId && isSelected && (
                  <Text color="cyan">{'    '}↳ Replying...</Text>
                )}
                <Box>
                  <Text color={isComposing ? 'green' : isInputSelected ? 'cyan' : 'gray'}>
                    {'    '}
                    {isComposing ? '✎ ' : isInputSelected ? '▶ ' : '  '}
                  </Text>
                  {isComposing ? (
                    <SimpleTextInput
                      value={inputText}
                      cursorPos={inputCursorPos}
                      onChange={onInputChange}
                      onCursorChange={onCursorChange}
                      onSubmit={onSubmit}
                      placeholder="Type message (Enter=send, Esc=cancel)..."
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
          }
          flatIdx++
        }
      }
    }
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {renderedItems}
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
  /** If true, read messages from archive database instead of live API */
  useArchiveForMessages?: boolean
  /** Channels with new messages (will be auto-expanded and loaded on startup) */
  channelsWithNewMessages?: ChannelInfo[]
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
  }>
  onFollowChannel?: (
    channel: ChannelInfo
  ) => Promise<{ channels: ChannelInfo[]; displayItems: string[] }>
  onUnfollowChannel?: (
    channel: ChannelInfo
  ) => Promise<{ channels: ChannelInfo[]; displayItems: string[] }>
  onToggleSection?: (
    section: SectionName
  ) => Promise<{ channels: ChannelInfo[]; displayItems: string[] }>
}

export function App({
  client,
  initialChannels,
  initialDisplayItems,
  title,
  useArchiveForMessages = false,
  channelsWithNewMessages = [],
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

  // Build initial flat items (no channels expanded initially)
  const initialFlatItems = buildFlatItems(
    displayItems,
    initialChannels,
    new Set<string>(),
    new Map<string, ExpandedChannelData>(),
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
    flatItems: initialFlatItems,
    selectedFlatIndex: findFirstSelectableIndex(initialFlatItems),
    focusMode: 'navigation' as UnifiedFocusMode,
    readerFocusChannel: null,
    channelMessageOffsets: new Map<string, number>(),
    selectedMessageIndex: -1,
    messageScrollIndex: 0,

    messages: [],
    hasMoreOlderMessages: true,
    isLoadingOlderMessages: false,
    inputText: '',
    inputCursorPos: 0,
    replyingToMessageId: null,
    attachedFiles: [],
    llmOriginalText: '',
    llmProcessedText: '',
    statusText: `${title} - ↑↓ navigate · Enter/Tab expand · R refresh · i compose · Esc exit`,
    loading: false,
    messageDetail: null,
    rows: stdout?.rows || 24,
    cols: stdout?.columns || 80,
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

  // Rebuild flat items when channels, expanded state, or data changes
  useEffect(() => {
    const newFlatItems = buildFlatItems(
      state.channelDisplayItems,
      state.channels,
      state.expandedChannels,
      state.expandedChannelData,
      getChannelFromDisplayIndex,
      state.readerFocusChannel,
      state.channelMessageOffsets
    )
    dispatch({ type: 'SET_FLAT_ITEMS', items: newFlatItems })
  }, [state.channelDisplayItems, state.channels, state.expandedChannels, state.expandedChannelData, getChannelFromDisplayIndex, state.readerFocusChannel, state.channelMessageOffsets])

  // Load messages for channels with new messages on startup
  const loadMessagesForChannel = useCallback(
    async (channel: ChannelInfo): Promise<MessageInfo[]> => {
      if (useArchiveForMessages) {
        const archiveMessages = await getMessagesFromArchive(channel.id, 100)
        return archiveMessages.reverse().map((record: MessageRecord) => ({
          id: record.id,
          author: record.authorName,
          authorId: record.authorId,
          content: record.content,
          timestamp: record.timestamp,
          date: new Date(record.timestamp),
          isBot: record.isBot,
          hasAttachments: (record.attachments?.length || 0) > 0,
          attachmentCount: record.attachments?.length || 0,
          attachments: record.attachments || [],
          reactions: record.reactions || [],
          replyTo: record.replyToId
            ? { author: '', content: `(reply to ${record.replyToId})` }
            : undefined,
        }))
      } else if (client) {
        return await loadMessagesFromPlatform(client, channel.id, 100)
      }
      return []
    },
    [client, useArchiveForMessages]
  )

  // Auto-expand channels with new messages on startup
  const [hasLoadedInitialChannels, setHasLoadedInitialChannels] = useState(false)
  useEffect(() => {
    if (hasLoadedInitialChannels || channelsWithNewMessages.length === 0) return
    setHasLoadedInitialChannels(true)

    const loadAllNewChannels = async () => {
      dispatch({ type: 'SET_LOADING', loading: true })
      dispatch({ type: 'SET_STATUS', text: 'Loading new messages...' })

      const expandedSet = new Set<string>()
      const dataMap = new Map<string, ExpandedChannelData>()

      for (const channel of channelsWithNewMessages) {
        expandedSet.add(channel.id)
        dataMap.set(channel.id, {
          channelId: channel.id,
          messages: [],
          isLoading: true,
          hasMoreOlderMessages: true,
        })
      }

      dispatch({ type: 'SET_EXPANDED_CHANNELS', expandedChannels: expandedSet, expandedChannelData: dataMap })

      // Load messages for each channel
      for (const channel of channelsWithNewMessages) {
        try {
          const messages = await loadMessagesForChannel(channel)
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
      }

      dispatch({ type: 'SET_LOADING', loading: false })
      dispatch({
        type: 'SET_STATUS',
        text: `${title} - ↑↓ navigate · Enter/Tab expand · R refresh · i compose · Esc exit`,
      })
    }

    void loadAllNewChannels()
  }, [channelsWithNewMessages, hasLoadedInitialChannels, loadMessagesForChannel, title])

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
      const { channels, displayItems } = await onRefreshChannels()
      dispatch({ type: 'SET_CHANNELS', channels, displayItems })
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
  // Convert archive MessageRecord to MessageInfo
  const archiveRecordToMessageInfo = (record: MessageRecord): MessageInfo => ({
    id: record.id,
    author: record.authorName,
    authorId: record.authorId,
    content: record.content,
    timestamp: record.timestamp,
    date: new Date(record.timestamp),
    isBot: record.isBot,
    hasAttachments: (record.attachments?.length || 0) > 0,
    attachmentCount: record.attachments?.length || 0,
    attachments: record.attachments || [],
    reactions: record.reactions || [],
    replyTo: record.replyToId ? { author: '', content: `(reply to ${record.replyToId})` } : undefined,
  })

  const loadMessages = useCallback(
    async (channel: ChannelInfo) => {
      dispatch({ type: 'SET_LOADING', loading: true })
      dispatch({
        type: 'SET_STATUS',
        text: `Loading messages from ${channel.name}...`,
      })
      try {
        let messages: MessageInfo[]

        if (useArchiveForMessages) {
          // Archive mode: load from database
          const archiveMessages = await getMessagesFromArchive(channel.id, 100)
          messages = archiveMessages.reverse().map(archiveRecordToMessageInfo)
        } else if (client) {
          // Live mode: fetch from platform
          messages = await loadMessagesFromPlatform(client, channel.id, 100)
        } else {
          messages = []
        }

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
    [client, useArchiveForMessages]
  )

  // Refresh messages after an action (preserves selection)
  const refreshMessages = useCallback(
    async (channel: ChannelInfo) => {
      try {
        let messages: MessageInfo[]
        if (useArchiveForMessages) {
          const archiveMessages = await getMessagesFromArchive(channel.id, 100)
          messages = archiveMessages.reverse().map(archiveRecordToMessageInfo)
        } else if (client) {
          messages = await loadMessagesFromPlatform(client, channel.id, 100)
        } else {
          return
        }
        dispatch({ type: 'REFRESH_MESSAGES', messages })
      } catch {
        // Silently fail refresh - user already saw the action confirmation
      }
    },
    [client, useArchiveForMessages]
  )

  // Load older messages
  const loadOlder = useCallback(async () => {
    if (
      state.isLoadingOlderMessages ||
      !state.hasMoreOlderMessages ||
      state.messages.length === 0
    )
      return

    // Archive mode doesn't support loading older (already loaded all)
    if (useArchiveForMessages || !client) {
      dispatch({ type: 'SET_HAS_MORE_OLDER', hasMore: false })
      dispatch({ type: 'SET_STATUS', text: 'Archive mode - all messages loaded' })
      return
    }

    dispatch({ type: 'SET_LOADING_OLDER', loading: true })
    dispatch({ type: 'SET_STATUS', text: 'Loading older messages...' })

    const oldestId = state.messages[0].id

    try {
      const { messages, newCount, hasMore } = await loadOlderMessagesFromPlatform(
        client,
        state.selectedChannel!.id,
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
  }, [client, state])

  // Send message
  const sendMessage = useCallback(
    async (text: string) => {
      if (!state.selectedChannel || !text.trim()) return

      // Archive-only mode: no sending
      if (!client) {
        dispatch({ type: 'SET_STATUS', text: '❌ Archive mode - read only' })
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
          // Build context for LLM
          const llmContext: LLMContext = {
            channelName: state.selectedChannel?.name,
            guildName: state.selectedChannel?.guildName,
            recentMessages: state.messages.slice(-10).map((m) => ({
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
        await client.sendMessage({
          content: messageText,
          channelId: state.selectedChannel.id,
          replyToMessageId: state.replyingToMessageId || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        })

        dispatch({ type: 'RESET_MESSAGE_STATE' })
        dispatch({ type: 'SET_VIEW', view: 'unified' })
        dispatch({ type: 'SET_STATUS', text: '✅ Message sent!' })

        // Reload messages
        await loadMessages(state.selectedChannel)
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
      loadMessages,
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
      await refreshMessages(state.selectedChannel)
    } catch (err) {
      dispatch({
        type: 'SET_STATUS',
        text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
      })
    }
  }, [client, state, refreshMessages])

  // Add reaction
  const addReaction = useCallback(
    async (emoji: string) => {
      if (state.selectedMessageIndex < 0 || !state.selectedChannel) return

      // Archive-only mode: no reactions
      if (!client) {
        dispatch({ type: 'SET_STATUS', text: '❌ Archive mode - read only' })
        return
      }

      const msgInfo = state.messages[state.selectedMessageIndex]

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
        dispatch({ type: 'SET_STATUS', text: '✅ Reaction added!' })
        dispatch({ type: 'SET_VIEW', view: 'unified' })
        dispatch({ type: 'SET_INPUT_TEXT', text: '' })
        // Refresh both legacy messages and expanded channel data
        await refreshMessages(state.selectedChannel)
        const messages = await loadMessagesForChannel(state.selectedChannel)
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
    },
    [client, state, refreshMessages, loadMessagesForChannel]
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
            isLoading: true,
            hasMoreOlderMessages: true,
          },
        })

        // Mark as visited
        markChannelVisited(channel.id, undefined, client?.type || 'discord')

        try {
          const messages = await loadMessagesForChannel(channel)
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
      }
    },
    [state.expandedChannels, loadMessagesForChannel, client?.type]
  )

  // Refresh all expanded channels
  const refreshAllChannels = useCallback(async () => {
    dispatch({ type: 'SET_LOADING', loading: true })
    dispatch({ type: 'SET_STATUS', text: 'Refreshing...' })

    // First refresh the channel list
    if (onRefreshChannels) {
      const { channels, displayItems: newDisplayItems } = await onRefreshChannels()
      dispatch({ type: 'SET_CHANNELS', channels, displayItems: newDisplayItems })
    }

    // Then refresh messages for expanded channels
    for (const channelId of state.expandedChannels) {
      const channel = state.channels.find((c) => c.id === channelId)
      if (channel) {
        try {
          const messages = await loadMessagesForChannel(channel)
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

    dispatch({ type: 'SET_LOADING', loading: false })
    dispatch({
      type: 'SET_STATUS',
      text: `${title} - ↑↓ navigate · Enter/Tab expand · R refresh · i compose · Esc exit`,
    })
  }, [state.expandedChannels, state.channels, loadMessagesForChannel, onRefreshChannels, title])

  // Send message in unified view (inline compose)
  const sendMessageUnified = useCallback(
    async (text: string) => {
      // Use selectedChannel which is set when entering compose mode
      const channel = state.selectedChannel
      if (!channel || !text.trim()) return

      if (!client) {
        dispatch({ type: 'SET_STATUS', text: '❌ Archive mode - read only' })
        return
      }

      dispatch({ type: 'SET_LOADING', loading: true })
      dispatch({ type: 'SET_STATUS', text: 'Sending message...' })

      try {
        let messageText = text
        const attachRegex = /\/attach\s+((?:\\\s|\S)+)/g
        const attachmentPaths: string[] = []
        let match
        while ((match = attachRegex.exec(text)) !== null) {
          attachmentPaths.push(match[1])
          messageText = messageText.replace(match[0], '').trim()
        }

        if (messageText.startsWith('llm://') || messageText.endsWith('\\\\:llm')) {
          const cleanText = messageText.replace(/^llm:\/\//, '').replace(/\\\\:llm$/, '').trim()
          // Build context for LLM from expanded channel data
          const channelData = state.expandedChannelData.get(channel.id)
          const llmContext: LLMContext = {
            channelName: channel.name,
            guildName: channel.guildName,
            recentMessages: channelData?.messages.slice(-10).map((m) => ({
              author: m.author,
              content: m.content,
            })),
          }
          const processed = await rewriteMessageWithLLM(cleanText, llmContext)
          dispatch({ type: 'SET_LLM_TEXTS', original: cleanText, processed })
          dispatch({ type: 'SET_VIEW', view: 'llmReview' })
          dispatch({ type: 'SET_LOADING', loading: false })
          return
        }

        const attachments: Array<{ path: string; name: string }> = []
        for (const file of state.attachedFiles) {
          attachments.push(file)
        }
        for (const filePath of attachmentPaths) {
          attachFile(filePath, attachments)
        }

        await client.sendMessage({
          content: messageText,
          channelId: channel.id,
          replyToMessageId: state.replyingToMessageId || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        })

        dispatch({ type: 'RESET_MESSAGE_STATE' })
        dispatch({ type: 'SET_FOCUS_MODE', mode: 'navigation' })
        dispatch({ type: 'SET_STATUS', text: '✅ Message sent!' })

        // Refresh messages for this channel
        const messages = await loadMessagesForChannel(channel)
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
      } catch (err) {
        dispatch({
          type: 'SET_STATUS',
          text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
        })
      }

      dispatch({ type: 'SET_LOADING', loading: false })
    },
    [client, state.selectedChannel, state.attachedFiles, state.replyingToMessageId, loadMessagesForChannel]
  )

  // Key handling
  useInput(async (input, key) => {
    // Global: Ctrl+C exits
    if (key.ctrl && input === 'c') {
      onExit?.()
      exit()
      return
    }

    const { view, focusMode } = state

    // ==================== Unified View ====================
    if (view === 'unified') {
      const currentFlatItem = state.flatItems[state.selectedFlatIndex]

      // Handle compose mode
      if (focusMode === 'compose') {
        if (key.escape) {
          dispatch({ type: 'RESET_MESSAGE_STATE' })
          dispatch({ type: 'SET_FOCUS_MODE', mode: 'navigation' })
          dispatch({
            type: 'SET_STATUS',
            text: `${title} - ↑↓ navigate · Enter/Tab expand · R refresh · i compose · Esc exit`,
          })
          return
        }
        // Let TextInput handle other keys
        return
      }

      // Reader mode: up/down only scrolls channel messages
      if (state.readerFocusChannel) {
        const readerData = state.expandedChannelData.get(state.readerFocusChannel)
        const readerOffset = state.channelMessageOffsets.get(state.readerFocusChannel) || 0
        const totalMessages = readerData?.messages.length || 0

        if (key.upArrow || input === 'k') {
          // Scroll up (show older messages)
          if (readerOffset > 0) {
            dispatch({ type: 'SCROLL_CHANNEL_MESSAGES', channelId: state.readerFocusChannel, delta: -1 })
            const newOffset = readerOffset - 1
            dispatch({ type: 'SET_STATUS', text: `Reader: messages ${newOffset + 1}-${Math.min(newOffset + DEFAULT_VISIBLE_MESSAGES, totalMessages)} of ${totalMessages}` })
          } else {
            dispatch({ type: 'SET_STATUS', text: `Reader: at oldest messages (1-${Math.min(DEFAULT_VISIBLE_MESSAGES, totalMessages)} of ${totalMessages})` })
          }
          return
        }
        if (key.downArrow || input === 'j') {
          // Scroll down (show newer messages)
          const maxOffset = Math.max(0, totalMessages - DEFAULT_VISIBLE_MESSAGES)
          if (readerOffset < maxOffset) {
            dispatch({ type: 'SCROLL_CHANNEL_MESSAGES', channelId: state.readerFocusChannel, delta: 1 })
            const newOffset = readerOffset + 1
            dispatch({ type: 'SET_STATUS', text: `Reader: messages ${newOffset + 1}-${Math.min(newOffset + DEFAULT_VISIBLE_MESSAGES, totalMessages)} of ${totalMessages}` })
          } else {
            dispatch({ type: 'SET_STATUS', text: `Reader: at newest messages (${readerOffset + 1}-${totalMessages} of ${totalMessages})` })
          }
          return
        }
        // Enter exits reader mode
        if (key.return) {
          dispatch({ type: 'SET_READER_FOCUS', channelId: null })
          dispatch({ type: 'SET_STATUS', text: `${title} - ↑↓ navigate · Tab expand · Enter reader mode · i compose` })
          return
        }
        // Escape also exits reader mode
        if (key.escape) {
          dispatch({ type: 'SET_READER_FOCUS', channelId: null })
          dispatch({ type: 'SET_STATUS', text: `${title} - ↑↓ navigate · Tab expand · Enter reader mode · i compose` })
          return
        }
        // Block other navigation in reader mode
        return
      }

      // Navigation mode - flat navigation
      if (key.upArrow || input === 'k') {
        const newIndex = state.selectedFlatIndex - 1
        if (newIndex >= 0) {
          dispatch({ type: 'SELECT_FLAT_INDEX', index: newIndex })
        }
        return
      }
      if (key.downArrow || input === 'j') {
        const newIndex = state.selectedFlatIndex + 1
        if (newIndex < state.flatItems.length) {
          dispatch({ type: 'SELECT_FLAT_INDEX', index: newIndex })
        }
        return
      }

      // Page scrolling - Ctrl+U/D for half page, Ctrl+B/F or Page Up/Down for full page
      const pageSize = Math.max(1, state.rows - 6)
      const halfPage = Math.max(1, Math.floor(pageSize / 2))

      // Half page up (Ctrl+U)
      if (key.ctrl && input === 'u') {
        const newIndex = Math.max(0, state.selectedFlatIndex - halfPage)
        dispatch({ type: 'SELECT_FLAT_INDEX', index: newIndex })
        return
      }
      // Half page down (Ctrl+D)
      if (key.ctrl && input === 'd') {
        const newIndex = Math.min(state.flatItems.length - 1, state.selectedFlatIndex + halfPage)
        dispatch({ type: 'SELECT_FLAT_INDEX', index: newIndex })
        return
      }
      // Full page up (Ctrl+B or 'g' for top)
      if (key.ctrl && input === 'b') {
        const newIndex = Math.max(0, state.selectedFlatIndex - pageSize)
        dispatch({ type: 'SELECT_FLAT_INDEX', index: newIndex })
        return
      }
      // Full page down (Ctrl+F)
      if (key.ctrl && input === 'f') {
        const newIndex = Math.min(state.flatItems.length - 1, state.selectedFlatIndex + pageSize)
        dispatch({ type: 'SELECT_FLAT_INDEX', index: newIndex })
        return
      }
      // Go to top (g g - just 'g' for simplicity, or G for bottom)
      if (input === 'g') {
        dispatch({ type: 'SELECT_FLAT_INDEX', index: 0 })
        return
      }
      if (input === 'G') {
        dispatch({ type: 'SELECT_FLAT_INDEX', index: state.flatItems.length - 1 })
        return
      }

      // Handle actions based on current flat item type
      if (currentFlatItem) {
        // On header: Enter/Tab toggles section
        if (currentFlatItem.type === 'header') {
          if ((key.return || key.tab) && onToggleSection) {
            const sectionName = currentFlatItem.sectionName
            let section: SectionName | null = null
            if (sectionName.includes('NEW')) section = 'new'
            else if (sectionName.includes('FOLLOWING')) section = 'following'
            else if (sectionName.includes('UNFOLLOWED')) section = 'unfollowed'

            if (section) {
              dispatch({ type: 'SET_LOADING', loading: true })
              const { channels, displayItems: newDisplayItems } = await onToggleSection(section)
              dispatch({ type: 'SET_CHANNELS', channels, displayItems: newDisplayItems })
              dispatch({ type: 'SET_LOADING', loading: false })
              return
            }
          }

          // y/x on header applies to next channel below
          if ((input === 'y' || input === 'x') && (onFollowChannel || onUnfollowChannel)) {
            // Find next channel below this header
            for (let i = state.selectedFlatIndex + 1; i < state.flatItems.length; i++) {
              const item = state.flatItems[i]
              if (item.type === 'channel') {
                const channel = state.channels.find(c => c.id === item.channelId)
                if (channel) {
                  if (input === 'y' && onFollowChannel) {
                    dispatch({ type: 'SET_LOADING', loading: true })
                    dispatch({ type: 'SET_STATUS', text: 'Following channel...' })
                    const { channels, displayItems: newDisplayItems } = await onFollowChannel(channel)
                    dispatch({ type: 'SET_CHANNELS', channels, displayItems: newDisplayItems })
                    dispatch({ type: 'SET_STATUS', text: `✓ Following ${channel.name}` })
                    dispatch({ type: 'SET_LOADING', loading: false })
                  } else if (input === 'x' && onUnfollowChannel) {
                    dispatch({ type: 'SET_LOADING', loading: true })
                    dispatch({ type: 'SET_STATUS', text: 'Unfollowing channel...' })
                    const { channels, displayItems: newDisplayItems } = await onUnfollowChannel(channel)
                    dispatch({ type: 'SET_CHANNELS', channels, displayItems: newDisplayItems })
                    dispatch({ type: 'SET_STATUS', text: `✓ Unfollowed ${channel.name}` })
                    dispatch({ type: 'SET_LOADING', loading: false })
                  }
                }
                return
              }
            }
          }
        }

        // On channel: Tab toggles expand/collapse, Enter toggles reader focus, y/x follows/unfollows
        if (currentFlatItem.type === 'channel') {
          // Tab: toggle expand/collapse
          if (key.tab) {
            const channel = state.channels.find(c => c.id === currentFlatItem.channelId)
            if (channel) {
              // If collapsing and this channel has reader focus, clear it
              if (state.expandedChannels.has(channel.id) && state.readerFocusChannel === channel.id) {
                dispatch({ type: 'SET_READER_FOCUS', channelId: null })
              }
              await toggleChannelExpand(channel)
            }
            return
          }

          // Enter: toggle reader focus (expand first if needed)
          if (key.return) {
            const channel = state.channels.find(c => c.id === currentFlatItem.channelId)
            if (channel) {
              // Expand if not expanded
              if (!state.expandedChannels.has(channel.id)) {
                await toggleChannelExpand(channel)
              }
              // Toggle reader focus
              if (state.readerFocusChannel === channel.id) {
                dispatch({ type: 'SET_READER_FOCUS', channelId: null })
                dispatch({ type: 'SET_STATUS', text: `${title} - ↑↓ navigate · Tab expand · Enter reader mode · i compose` })
              } else {
                const data = state.expandedChannelData.get(channel.id)
                const totalMsgs = data?.messages.length || 0
                const startMsg = Math.max(0, totalMsgs - DEFAULT_VISIBLE_MESSAGES) + 1
                dispatch({ type: 'SET_READER_FOCUS', channelId: channel.id })
                dispatch({ type: 'SET_STATUS', text: `Reader: ${channel.name} (${startMsg}-${totalMsgs} of ${totalMsgs}) · ↑↓ scroll · Enter exit` })
              }
            }
            return
          }

          if (input === 'y' && onFollowChannel) {
            const channel = state.channels.find(c => c.id === currentFlatItem.channelId)
            if (channel) {
              dispatch({ type: 'SET_LOADING', loading: true })
              dispatch({ type: 'SET_STATUS', text: 'Following channel...' })
              const { channels, displayItems: newDisplayItems } = await onFollowChannel(channel)
              dispatch({ type: 'SET_CHANNELS', channels, displayItems: newDisplayItems })
              dispatch({ type: 'SET_STATUS', text: `✓ Following ${channel.name}` })
              dispatch({ type: 'SET_LOADING', loading: false })
            }
            return
          }

          if (input === 'x' && onUnfollowChannel) {
            const channel = state.channels.find(c => c.id === currentFlatItem.channelId)
            if (channel) {
              dispatch({ type: 'SET_LOADING', loading: true })
              dispatch({ type: 'SET_STATUS', text: 'Unfollowing channel...' })
              const { channels, displayItems: newDisplayItems } = await onUnfollowChannel(channel)
              dispatch({ type: 'SET_CHANNELS', channels, displayItems: newDisplayItems })
              dispatch({ type: 'SET_STATUS', text: `✓ Unfollowed ${channel.name}` })
              dispatch({ type: 'SET_LOADING', loading: false })
            }
            return
          }
        }

        // On message: Tab=collapse, Enter=reader focus, r=reply, e=react, d=delete, f=download, u=urls, v=view, h/←=collapse
        if (currentFlatItem.type === 'message') {
          const channelId = currentFlatItem.channelId
          const channel = state.channels.find(c => c.id === channelId)
          const data = state.expandedChannelData.get(channelId)
          const msg = data?.messages[currentFlatItem.messageIndex]

          // Tab: collapse channel
          if (key.tab) {
            if (state.readerFocusChannel === channelId) {
              dispatch({ type: 'SET_READER_FOCUS', channelId: null })
            }
            dispatch({ type: 'TOGGLE_CHANNEL_EXPAND', channelId })
            // Find the channel line
            const channelIndex = state.flatItems.findIndex(
              item => item.type === 'channel' && item.channelId === channelId
            )
            if (channelIndex >= 0) {
              dispatch({ type: 'SELECT_FLAT_INDEX', index: channelIndex })
            }
            return
          }

          // Enter: toggle reader focus
          if (key.return) {
            if (state.readerFocusChannel === channelId) {
              dispatch({ type: 'SET_READER_FOCUS', channelId: null })
              dispatch({ type: 'SET_STATUS', text: `${title} - ↑↓ navigate · Tab expand · Enter reader mode · i compose` })
            } else if (channel && data) {
              const totalMsgs = data.messages.length
              const startMsg = Math.max(0, totalMsgs - DEFAULT_VISIBLE_MESSAGES) + 1
              dispatch({ type: 'SET_READER_FOCUS', channelId })
              dispatch({ type: 'SET_STATUS', text: `Reader: ${channel.name} (${startMsg}-${totalMsgs} of ${totalMsgs}) · ↑↓ scroll · Enter exit` })
            }
            return
          }

          // Reply (r)
          if (input === 'r' && msg && channel) {
            dispatch({ type: 'SET_REPLYING_TO', messageId: msg.id })
            dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
            // Move to input line for this channel
            const inputIndex = findInputIndexForChannel(state.flatItems, channelId)
            if (inputIndex >= 0) {
              dispatch({ type: 'SELECT_FLAT_INDEX', index: inputIndex })
            }
            dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
            dispatch({ type: 'SET_STATUS', text: 'Reply - Enter to send, Esc to cancel' })
            return
          }

          // React (e)
          if (input === 'e' && msg && channel) {
            dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
            // Store the message index for reaction
            dispatch({ type: 'SELECT_MESSAGE_INDEX', index: currentFlatItem.messageIndex })
            // Set messages for the react view to use
            if (data) {
              dispatch({ type: 'SET_MESSAGES', messages: data.messages })
            }
            dispatch({ type: 'SET_VIEW', view: 'react' })
            dispatch({ type: 'SET_STATUS', text: 'React - Enter emoji, Esc to cancel' })
            return
          }

          // Delete (d)
          if (input === 'd' && msg && channel && client) {
            const currentUser = client.getCurrentUser()
            if (!currentUser) {
              dispatch({ type: 'SET_STATUS', text: '❌ User not found' })
              return
            }
            if (msg.authorId !== currentUser.id) {
              dispatch({ type: 'SET_STATUS', text: '❌ Can only delete your own messages' })
              return
            }
            try {
              await client.deleteMessage(channelId, msg.id)
              dispatch({ type: 'SET_STATUS', text: '✅ Message deleted' })
              // Refresh channel messages
              const messages = await loadMessagesForChannel(channel)
              dispatch({
                type: 'SET_EXPANDED_CHANNEL_DATA',
                channelId,
                data: { channelId, messages, isLoading: false, hasMoreOlderMessages: true },
              })
            } catch (err) {
              dispatch({
                type: 'SET_STATUS',
                text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
              })
            }
            return
          }

          // Download attachments (f)
          if (input === 'f' && msg) {
            if (!msg.hasAttachments || msg.attachments.length === 0) {
              dispatch({ type: 'SET_STATUS', text: 'No attachments on this message' })
              return
            }
            dispatch({ type: 'SET_LOADING', loading: true })
            try {
              await downloadAttachmentsFromInfo(msg.attachments, (status) => {
                dispatch({ type: 'SET_STATUS', text: status })
              })
            } catch (err) {
              dispatch({
                type: 'SET_STATUS',
                text: `❌ Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
              })
            }
            dispatch({ type: 'SET_LOADING', loading: false })
            return
          }

          // Open URLs (u)
          if (input === 'u' && msg) {
            const urls = extractUrls(msg.content)
            if (urls.length === 0) {
              dispatch({ type: 'SET_STATUS', text: 'No URLs in this message' })
              return
            }
            for (const url of urls) {
              await openUrlInBrowser(url)
            }
            dispatch({ type: 'SET_STATUS', text: `Opened ${urls.length} URL(s)` })
            return
          }

          // View full message (v)
          if (input === 'v' && msg) {
            const reactionsText = msg.reactions && msg.reactions.length > 0
              ? msg.reactions
                  .map((r) => {
                    const userList = r.users.length > 0 ? r.users.join(', ') : '(unknown)'
                    return `${r.emoji} (${r.count}) - ${userList}`
                  })
                  .join('\n')
              : undefined
            dispatch({
              type: 'SET_MESSAGE_DETAIL',
              detail: {
                author: msg.author,
                timestamp: msg.timestamp,
                content: msg.content,
                reactions: reactionsText,
              },
            })
            dispatch({ type: 'SET_VIEW', view: 'reactionUsers' })
            return
          }

          // Back/collapse (h or left arrow)
          if (input === 'h' || key.leftArrow) {
            // Collapse this channel and move selection to the channel line
            const channel = state.channels.find(c => c.id === channelId)
            if (channel) {
              dispatch({ type: 'TOGGLE_CHANNEL_EXPAND', channelId })
              // Find the channel line in flat items and select it
              const channelIndex = state.flatItems.findIndex(
                item => item.type === 'channel' && item.channelId === channelId
              )
              if (channelIndex >= 0) {
                dispatch({ type: 'SELECT_FLAT_INDEX', index: channelIndex })
              }
            }
            return
          }
        }

        // On input line: Tab=collapse, i=compose
        if (currentFlatItem.type === 'input') {
          // Tab: collapse channel
          if (key.tab) {
            const channelId = currentFlatItem.channelId
            if (state.readerFocusChannel === channelId) {
              dispatch({ type: 'SET_READER_FOCUS', channelId: null })
            }
            dispatch({ type: 'TOGGLE_CHANNEL_EXPAND', channelId })
            // Find the channel line
            const channelIndex = state.flatItems.findIndex(
              item => item.type === 'channel' && item.channelId === channelId
            )
            if (channelIndex >= 0) {
              dispatch({ type: 'SELECT_FLAT_INDEX', index: channelIndex })
            }
            return
          }

          if (input === 'i') {
            const channel = state.channels.find(c => c.id === currentFlatItem.channelId)
            if (channel) {
              dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
              dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
              dispatch({ type: 'SET_STATUS', text: 'Compose - Enter to send, Esc to cancel' })
            }
            return
          }

          // Back/collapse (h or left arrow)
          if (input === 'h' || key.leftArrow) {
            const channelId = currentFlatItem.channelId
            if (state.readerFocusChannel === channelId) {
              dispatch({ type: 'SET_READER_FOCUS', channelId: null })
            }
            dispatch({ type: 'TOGGLE_CHANNEL_EXPAND', channelId })
            // Find the channel line
            const channelIndex = state.flatItems.findIndex(
              item => item.type === 'channel' && item.channelId === channelId
            )
            if (channelIndex >= 0) {
              dispatch({ type: 'SELECT_FLAT_INDEX', index: channelIndex })
            }
            return
          }
        }
      }

      // Refresh (R key)
      if (input === 'R' || input === 'r') {
        await refreshAllChannels()
        return
      }

      // Collapse all (c key)
      if (input === 'c') {
        dispatch({ type: 'COLLAPSE_ALL_CHANNELS' })
        // Reset selection to first channel
        const firstChannelIndex = state.flatItems.findIndex(item => item.type === 'channel')
        if (firstChannelIndex >= 0) {
          dispatch({ type: 'SELECT_FLAT_INDEX', index: firstChannelIndex })
        }
        return
      }

      // Exit
      if (key.escape) {
        onExit?.()
        exit()
        return
      }
    }

    // ==================== React View ====================
    if (view === 'react') {
      if (key.escape) {
        dispatch({ type: 'SET_INPUT_TEXT', text: '' })
        dispatch({ type: 'SET_VIEW', view: 'unified' })
        dispatch({
          type: 'SET_STATUS',
          text: `${title} - ↑↓ navigate · Enter/Tab expand · R refresh · i compose · Esc exit`,
        })
        return
      }
      if (key.return) {
        await addReaction(state.inputText)
        return
      }
    }

    // ==================== LLM Review View ====================
    if (view === 'llmReview') {
      if (input === 'p') {
        await sendMessageUnified(state.llmProcessedText)
        return
      }
      if (input === 'o') {
        await sendMessageUnified(state.llmOriginalText)
        return
      }
      if (input === 'e') {
        dispatch({ type: 'SET_INPUT_TEXT', text: state.llmProcessedText })
        dispatch({ type: 'SET_VIEW', view: 'unified' })
        dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
        return
      }
      if (input === 'O') {
        dispatch({ type: 'SET_INPUT_TEXT', text: state.llmOriginalText })
        dispatch({ type: 'SET_VIEW', view: 'unified' })
        dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
        return
      }
      if (key.escape) {
        dispatch({ type: 'CLEAR_LLM_TEXTS' })
        dispatch({ type: 'SET_VIEW', view: 'unified' })
        return
      }
    }

    // ==================== Reaction Users View ====================
    if (view === 'reactionUsers') {
      if (key.escape || input === 'q') {
        dispatch({ type: 'SET_VIEW', view: 'unified' })
        return
      }
    }
  })

  // Determine help bar bindings based on view and current item
  const getHelpBindings = () => {
    if (state.view === 'unified') {
      if (state.focusMode === 'compose') {
        return [
          { key: 'Enter', label: 'send' },
          { key: 'Esc', label: 'cancel' },
        ]
      }

      // Reader mode: simple scroll controls
      if (state.readerFocusChannel !== null) {
        return [
          { key: '↑', label: 'older' },
          { key: '↓', label: 'newer' },
          { key: 'Enter/Esc', label: 'exit reader' },
        ]
      }

      const currentItem = state.flatItems[state.selectedFlatIndex]

      // On message: show message-level bindings
      if (currentItem?.type === 'message') {
        return [
          { key: '↑↓', label: 'nav' },
          { key: 'Enter', label: 'reader' },
          { key: 'Tab', label: 'collapse' },
          { key: 'r', label: 'reply' },
          { key: 'e', label: 'react' },
          { key: 'v', label: 'view' },
        ]
      }

      // On input line
      if (currentItem?.type === 'input') {
        return [
          { key: '↑↓', label: 'nav' },
          { key: 'Tab', label: 'collapse' },
          { key: 'i', label: 'compose' },
          { key: 'h', label: 'back' },
        ]
      }

      // On channel or header
      return [
        { key: '↑↓/jk', label: 'nav' },
        { key: 'Tab', label: 'expand' },
        { key: 'Enter', label: 'reader' },
        { key: 'R', label: 'refresh' },
        ...(onFollowChannel ? [{ key: 'y', label: 'follow' }] : []),
        ...(onUnfollowChannel ? [{ key: 'x', label: 'unfollow' }] : []),
        { key: 'Esc', label: 'exit' },
      ]
    }
    switch (state.view) {
      case 'react':
        return [
          { key: 'Enter', label: 'add' },
          { key: 'Esc', label: 'cancel' },
        ]
      case 'llmReview':
        return [
          { key: 'p', label: 'send processed' },
          { key: 'o', label: 'send original' },
          { key: 'e', label: 'edit processed' },
          { key: 'O', label: 'edit original' },
          { key: 'Esc', label: 'cancel' },
        ]
      case 'reactionUsers':
        return [{ key: 'Esc/q', label: 'close' }]
      default:
        return []
    }
  }

  return (
    <Box flexDirection="column" height={state.rows}>
      <StatusBar text={state.statusText} loading={state.loading} />

      <Box flexGrow={1} flexDirection="column" paddingX={1}>
        {state.view === 'unified' && (
          <UnifiedView
            displayItems={state.channelDisplayItems}
            channels={state.channels}
            flatItems={state.flatItems}
            selectedFlatIndex={state.selectedFlatIndex}
            expandedChannels={state.expandedChannels}
            expandedChannelData={state.expandedChannelData}
            focusMode={state.focusMode}
            readerFocusChannel={state.readerFocusChannel}
            inputText={state.inputText}
            inputCursorPos={state.inputCursorPos}
            onInputChange={(text) => dispatch({ type: 'SET_INPUT_TEXT', text })}
            onCursorChange={(pos) =>
              dispatch({ type: 'SET_INPUT_CURSOR_POS', pos })
            }
            onSubmit={sendMessageUnified}
            replyingToMessageId={state.replyingToMessageId}
            rows={state.rows}
            getChannelFromDisplayIndex={getChannelFromDisplayIndex}
          />
        )}

        {state.view === 'react' && (
          <ReactView
            inputText={state.inputText}
            cursorPos={state.inputCursorPos}
            onInputChange={(text) => dispatch({ type: 'SET_INPUT_TEXT', text })}
            onCursorChange={(pos) =>
              dispatch({ type: 'SET_INPUT_CURSOR_POS', pos })
            }
            onSubmit={addReaction}
          />
        )}

        {state.view === 'llmReview' && (
          <LlmReviewView
            originalText={state.llmOriginalText}
            processedText={state.llmProcessedText}
          />
        )}

        {state.view === 'reactionUsers' && state.messageDetail && (
          <MessageDetailView message={state.messageDetail} />
        )}
      </Box>

      <HelpBar bindings={getHelpBindings()} />
    </Box>
  )
}

// ==================== Render helper ====================

export function renderApp(props: AppProps) {
  return render(<App {...props} />)
}
