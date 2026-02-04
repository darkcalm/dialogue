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

// Focus mode in unified view
export type UnifiedFocusMode = 'navigation' | 'compose'

export interface AppState {
  view: ViewName
  channels: ChannelInfo[]
  channelDisplayItems: string[] // For inbox grouped display
  selectedChannelIndex: number
  selectedChannel: ChannelInfo | null

  // Unified view state
  expandedChannels: Set<string> // Channel IDs that are expanded
  expandedChannelData: Map<string, ExpandedChannelData> // Messages for each expanded channel
  focusMode: UnifiedFocusMode // Are we navigating or composing?
  selectedMessageIndex: number // Index within the currently focused expanded channel
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

  // For reaction users modal
  reactionUsersContent: string

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
  | { type: 'SET_REACTION_USERS_CONTENT'; content: string }
  | { type: 'RESET_MESSAGE_STATE' }
  | { type: 'SET_DIMENSIONS'; rows: number; cols: number }
  // Unified view actions
  | { type: 'TOGGLE_CHANNEL_EXPAND'; channelId: string }
  | { type: 'SET_EXPANDED_CHANNEL_DATA'; channelId: string; data: ExpandedChannelData }
  | { type: 'SET_FOCUS_MODE'; mode: UnifiedFocusMode }
  | { type: 'COLLAPSE_ALL_CHANNELS' }
  | { type: 'EXPAND_CHANNEL'; channelId: string }
  | { type: 'SET_EXPANDED_CHANNELS'; expandedChannels: Set<string>; expandedChannelData: Map<string, ExpandedChannelData> }

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
    case 'SET_REACTION_USERS_CONTENT':
      return { ...state, reactionUsersContent: action.content }
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
      return { ...state, expandedChannels: new Set(), focusMode: 'navigation' }
    case 'SET_EXPANDED_CHANNEL_DATA': {
      const newData = new Map(state.expandedChannelData)
      newData.set(action.channelId, action.data)
      return { ...state, expandedChannelData: newData }
    }
    case 'SET_FOCUS_MODE':
      return { ...state, focusMode: action.mode }
    case 'SET_EXPANDED_CHANNELS':
      return {
        ...state,
        expandedChannels: action.expandedChannels,
        expandedChannelData: action.expandedChannelData,
      }
    default:
      return state
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

interface ReactionUsersViewProps {
  content: string
}

function ReactionUsersView({ content }: ReactionUsersViewProps) {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text color="cyan" bold>
        Reaction Users
      </Text>
      <Text>{content}</Text>
      <Text color="gray">Press Esc or q to close</Text>
    </Box>
  )
}

// ==================== Unified View ====================

interface UnifiedViewProps {
  displayItems: string[]
  channels: ChannelInfo[]
  selectedIndex: number
  expandedChannels: Set<string>
  expandedChannelData: Map<string, ExpandedChannelData>
  selectedMessageIndex: number
  focusMode: UnifiedFocusMode
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
  selectedIndex,
  expandedChannels,
  expandedChannelData,
  selectedMessageIndex,
  focusMode,
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
  const items: React.ReactNode[] = []

  // Build the unified list of channels + expanded messages
  let lineCount = 0

  // Calculate where to start rendering for scrolling
  // We need to count lines up to the selected item
  let targetLineCount = 0
  for (let i = 0; i < displayItems.length && i <= selectedIndex; i++) {
    const item = displayItems[i]
    const isHeader = item.startsWith('══════')

    if (isHeader) {
      targetLineCount++
    } else {
      const channel = getChannelFromDisplayIndex(i, channels)
      const isExpanded = channel && expandedChannels.has(channel.id)
      targetLineCount++ // Channel line
      if (isExpanded && channel) {
        const data = expandedChannelData.get(channel.id)
        if (data) {
          targetLineCount += Math.min(data.messages.length, 5) // Show up to 5 messages
          targetLineCount += 2 // Compose input area (2 lines)
        }
      }
    }
  }

  // Scroll offset
  const scrollOffset = Math.max(0, targetLineCount - Math.floor(visibleCount / 2))

  // Render items
  for (let i = 0; i < displayItems.length; i++) {
    if (lineCount - scrollOffset >= visibleCount) break
    if (lineCount - scrollOffset < -20) {
      // Skip items way before viewport
      const item = displayItems[i]
      const isHeader = item.startsWith('══════')
      if (isHeader) {
        lineCount++
      } else {
        const channel = getChannelFromDisplayIndex(i, channels)
        const isExpanded = channel && expandedChannels.has(channel.id)
        lineCount++
        if (isExpanded && channel) {
          const data = expandedChannelData.get(channel.id)
          if (data) {
            lineCount += Math.min(data.messages.length, 5)
            lineCount += 2
          }
        }
      }
      continue
    }

    const item = displayItems[i]
    const isHeader = item.startsWith('══════')
    const isSelected = i === selectedIndex && focusMode === 'navigation'

    if (isHeader) {
      if (lineCount - scrollOffset >= 0) {
        items.push(
          <Text key={`h-${i}`} color="yellow" dimColor>
            {item}
          </Text>
        )
      }
      lineCount++
    } else {
      const channel = getChannelFromDisplayIndex(i, channels)
      const isExpanded = channel && expandedChannels.has(channel.id)
      const expandIcon = isExpanded ? '▼' : '▶'

      if (lineCount - scrollOffset >= 0) {
        items.push(
          <Text
            key={`c-${i}`}
            inverse={isSelected}
            color={isSelected ? 'green' : isExpanded ? 'cyan' : 'blackBright'}
          >
            {isSelected ? '▶ ' : '  '}
            {expandIcon} {item}
          </Text>
        )
      }
      lineCount++

      // If expanded, show messages and compose input
      if (isExpanded && channel) {
        const data = expandedChannelData.get(channel.id)
        const isFocusedChannel = i === selectedIndex

        if (data) {
          if (data.isLoading) {
            if (lineCount - scrollOffset >= 0) {
              items.push(
                <Text key={`load-${channel.id}`} color="gray">
                  {'    '}⏳ Loading messages...
                </Text>
              )
            }
            lineCount++
          } else if (data.messages.length === 0) {
            if (lineCount - scrollOffset >= 0) {
              items.push(
                <Text key={`empty-${channel.id}`} color="gray">
                  {'    '}(no messages)
                </Text>
              )
            }
            lineCount++
          } else {
            // Show last few messages (up to 5)
            const recentMessages = data.messages.slice(-5)
            recentMessages.forEach((msg, msgIdx) => {
              const actualMsgIdx = data.messages.length - 5 + msgIdx
              const isMsgSelected =
                isFocusedChannel &&
                focusMode === 'navigation' &&
                selectedMessageIndex === actualMsgIdx

              if (lineCount - scrollOffset >= 0) {
                const attachmentIndicator = msg.hasAttachments
                  ? ` 📎(${msg.attachmentCount})`
                  : ''
                const reactionsText =
                  msg.reactions && msg.reactions.length > 0
                    ? ' ' + msg.reactions.map((r) => `${r.emoji}${r.count}`).join(' ')
                    : ''

                items.push(
                  <Text
                    key={`msg-${channel.id}-${msg.id}`}
                    inverse={isMsgSelected}
                    color={isMsgSelected ? 'blue' : 'gray'}
                  >
                    {'    '}
                    {isMsgSelected ? '▶ ' : '  '}
                    [{msg.timestamp}] {msg.author}
                    {attachmentIndicator}: {msg.content.split('\n')[0].slice(0, 60)}
                    {msg.content.split('\n')[0].length > 60 ? '...' : ''}
                    {reactionsText}
                  </Text>
                )
              }
              lineCount++
            })
          }

          // Inline compose input for focused expanded channel
          if (isFocusedChannel && lineCount - scrollOffset >= 0) {
            const isComposing = focusMode === 'compose'
            items.push(
              <Box key={`compose-${channel.id}`} flexDirection="column">
                {replyingToMessageId && (
                  <Text color="cyan">{'    '}↳ Replying...</Text>
                )}
                <Box>
                  <Text color={isComposing ? 'green' : 'gray'}>
                    {'    '}
                    {isComposing ? '✎ ' : '  '}
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
                    <Text color="gray" dimColor>
                      [press i to compose]
                    </Text>
                  )}
                </Box>
              </Box>
            )
            lineCount += 2
          }
        }
      }
    }
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {items}
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

  const initialState: AppState = {
    view: 'unified',
    channels: initialChannels,
    channelDisplayItems: displayItems,
    selectedChannelIndex: findFirstNonHeaderIndex(displayItems),
    selectedChannel: initialChannels[0] || null,

    // Unified view state
    expandedChannels: new Set<string>(),
    expandedChannelData: new Map<string, ExpandedChannelData>(),
    focusMode: 'navigation' as UnifiedFocusMode,
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
    reactionUsersContent: '',
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

  // Load messages for channels with new messages on startup
  const loadMessagesForChannel = useCallback(
    async (channel: ChannelInfo): Promise<MessageInfo[]> => {
      if (useArchiveForMessages) {
        const archiveMessages = await getMessagesFromArchive(channel.id, 50)
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
        return await loadMessagesFromPlatform(client, channel.id)
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
          const archiveMessages = await getMessagesFromArchive(channel.id, 50)
          messages = archiveMessages.reverse().map(archiveRecordToMessageInfo)
        } else if (client) {
          // Live mode: fetch from platform
          messages = await loadMessagesFromPlatform(client, channel.id)
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
          const archiveMessages = await getMessagesFromArchive(channel.id, 50)
          messages = archiveMessages.reverse().map(archiveRecordToMessageInfo)
        } else if (client) {
          messages = await loadMessagesFromPlatform(client, channel.id)
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

        // Check for LLM rewrite
        if (
          messageText.startsWith('llm://') ||
          messageText.endsWith(':\\\\llm')
        ) {
          const cleanText = messageText
            .replace(/^llm:\/\//, '')
            .replace(/:\\\\llm$/, '')
            .trim()
          const processed = await rewriteMessageWithLLM(cleanText)
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
        await refreshMessages(state.selectedChannel)
      } catch (err) {
        dispatch({
          type: 'SET_STATUS',
          text: `❌ Error: ${err instanceof Error ? err.message : 'Unknown'}`,
        })
      }
    },
    [client, state, refreshMessages]
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

  // View reaction users
  const viewReactionUsers = useCallback(() => {
    if (state.selectedMessageIndex < 0) return

    const msgInfo = state.messages[state.selectedMessageIndex]
    if (!msgInfo.reactions || msgInfo.reactions.length === 0) {
      dispatch({ type: 'SET_STATUS', text: 'No reactions on this message' })
      return
    }

    const content = msgInfo.reactions
      .map((r) => {
        const userList =
          r.users.length > 0 ? r.users.join(', ') : '(no users fetched)'
        return `${r.emoji} (${r.count})\n  ${userList}`
      })
      .join('\n\n')

    dispatch({ type: 'SET_REACTION_USERS_CONTENT', content })
    dispatch({ type: 'SET_VIEW', view: 'reactionUsers' })
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
      const channel = getChannelFromDisplayIndex(state.selectedChannelIndex, state.channels)
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

        if (messageText.startsWith('llm://') || messageText.endsWith(':\\\\llm')) {
          const cleanText = messageText.replace(/^llm:\/\//, '').replace(/:\\\\llm$/, '').trim()
          const processed = await rewriteMessageWithLLM(cleanText)
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
    [client, state, loadMessagesForChannel, getChannelFromDisplayIndex]
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

      // Navigation mode
      if (key.upArrow || input === 'k') {
        const newIndex = state.selectedChannelIndex - 1
        if (newIndex >= 0) {
          dispatch({ type: 'SELECT_CHANNEL_INDEX', index: newIndex })
        }
        return
      }
      if (key.downArrow || input === 'j') {
        const newIndex = state.selectedChannelIndex + 1
        if (newIndex < state.channelDisplayItems.length) {
          dispatch({ type: 'SELECT_CHANNEL_INDEX', index: newIndex })
        }
        return
      }

      // Toggle channel expand (Enter or Tab on channel, Tab on header for section)
      if (key.return || key.tab) {
        const currentItem = state.channelDisplayItems[state.selectedChannelIndex]

        // Check if it's a section header
        if (currentItem?.startsWith('══════') && onToggleSection) {
          let section: SectionName | null = null
          if (currentItem.includes('NEW')) section = 'new'
          else if (currentItem.includes('FOLLOWING')) section = 'following'
          else if (currentItem.includes('UNFOLLOWED')) section = 'unfollowed'

          if (section) {
            dispatch({ type: 'SET_LOADING', loading: true })
            const { channels, displayItems: newDisplayItems } = await onToggleSection(section)
            dispatch({ type: 'SET_CHANNELS', channels, displayItems: newDisplayItems })
            dispatch({ type: 'SET_LOADING', loading: false })
            return
          }
        }

        // Toggle channel expand
        const channel = getChannelFromDisplayIndex(state.selectedChannelIndex, state.channels)
        if (channel) {
          await toggleChannelExpand(channel)
        }
        return
      }

      // Compose new message (i key)
      if (input === 'i') {
        const channel = getChannelFromDisplayIndex(state.selectedChannelIndex, state.channels)
        if (channel) {
          // Make sure channel is expanded
          if (!state.expandedChannels.has(channel.id)) {
            await toggleChannelExpand(channel)
          }
          dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
          dispatch({ type: 'SET_FOCUS_MODE', mode: 'compose' })
          dispatch({
            type: 'SET_STATUS',
            text: 'Compose - Enter to send, Esc to cancel',
          })
        }
        return
      }

      // Refresh (R key)
      if (input === 'R' || input === 'r') {
        await refreshAllChannels()
        return
      }

      // Follow channel (y key)
      if (input === 'y' && onFollowChannel) {
        await followChannel()
        return
      }

      // Unfollow channel (x key)
      if (input === 'x' && onUnfollowChannel) {
        await unfollowChannel()
        return
      }

      // Collapse all (c key)
      if (input === 'c') {
        dispatch({ type: 'COLLAPSE_ALL_CHANNELS' })
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

  // Determine help bar bindings based on view
  const getHelpBindings = () => {
    if (state.view === 'unified') {
      if (state.focusMode === 'compose') {
        return [
          { key: 'Enter', label: 'send' },
          { key: 'Esc', label: 'cancel' },
        ]
      }
      return [
        { key: '↑↓/jk', label: 'navigate' },
        { key: 'Enter/Tab', label: 'expand' },
        { key: 'i', label: 'compose' },
        { key: 'r', label: 'refresh' },
        { key: 'c', label: 'collapse all' },
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
            selectedIndex={state.selectedChannelIndex}
            expandedChannels={state.expandedChannels}
            expandedChannelData={state.expandedChannelData}
            selectedMessageIndex={state.selectedMessageIndex}
            focusMode={state.focusMode}
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

        {state.view === 'reactionUsers' && (
          <ReactionUsersView content={state.reactionUsersContent} />
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
