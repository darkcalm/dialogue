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
  | 'channels'
  | 'messages'
  | 'compose'
  | 'react'
  | 'llmReview'
  | 'reactionUsers'

export interface AppState {
  view: ViewName
  channels: ChannelInfo[]
  channelDisplayItems: string[] // For inbox grouped display
  selectedChannelIndex: number
  selectedChannel: ChannelInfo | null

  messages: MessageInfo[]
  selectedMessageIndex: number
  messageScrollIndex: number
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
  onChannelSelect,
  getChannelFromDisplayIndex,
  onExit,
  onRefreshChannels,
  onFollowChannel,
  onUnfollowChannel,
  onToggleSection,
}: AppProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const initialState: AppState = {
    view: 'channels',
    channels: initialChannels,
    channelDisplayItems:
      initialDisplayItems ||
      initialChannels.map(
        (c) => `${c.guildName ? `${c.guildName} / ` : ''}${c.name}`
      ),
    selectedChannelIndex: 0,
    selectedChannel: initialChannels[0] || null,
    messages: [],
    selectedMessageIndex: -1,
    messageScrollIndex: 0,
    hasMoreOlderMessages: true,
    isLoadingOlderMessages: false,
    inputText: '',
    inputCursorPos: 0,
    replyingToMessageId: null,
    attachedFiles: [],
    llmOriginalText: '',
    llmProcessedText: '',
    statusText: `${title} - ↑↓ navigate · Enter select · Tab collapse · y follow · x unfollow`,
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

  // Subscribe to real-time message events and update cache + UI
  useEffect(() => {
    if (!client) return // Archive-only mode - no real-time updates

    const platform = client.type

    // Handle new messages
    client.onMessage((msg) => {
      upsertCachedMessage(platform, msg.channelId, msg)

      // If we're viewing this channel, update UI state
      if (state.selectedChannel?.id === msg.channelId && state.view === 'messages') {
        const cached = getCachedMessages(platform, msg.channelId)
        if (cached) {
          dispatch({ type: 'SET_MESSAGES', messages: cached.messages })
        }
      }
    })

    // Handle message updates (edits, reactions)
    client.onMessageUpdate((msg) => {
      upsertCachedMessage(platform, msg.channelId, msg)

      // If we're viewing this channel, update UI state
      if (state.selectedChannel?.id === msg.channelId && state.view === 'messages') {
        const cached = getCachedMessages(platform, msg.channelId)
        if (cached) {
          dispatch({ type: 'SET_MESSAGES', messages: cached.messages })
        }
      }
    })

    // Handle message deletions
    client.onMessageDelete((channelId, messageId) => {
      deleteCachedMessage(platform, channelId, messageId)

      // If we're viewing this channel, update UI state
      if (state.selectedChannel?.id === channelId && state.view === 'messages') {
        const cached = getCachedMessages(platform, channelId)
        if (cached) {
          dispatch({ type: 'SET_MESSAGES', messages: cached.messages })
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
        dispatch({ type: 'SET_VIEW', view: 'messages' })
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
        dispatch({ type: 'SET_VIEW', view: 'messages' })
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

  // Key handling
  useInput(async (input, key) => {
    // Global: Ctrl+C exits
    if (key.ctrl && input === 'c') {
      onExit?.()
      exit()
      return
    }

    const { view } = state

    // ==================== Channels View ====================
    if (view === 'channels') {
      // Navigation - allow selecting headers for collapsing
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

      // Select channel
      if (key.return || key.rightArrow || input === 'l') {
        const channel = getChannelFromDisplayIndex
          ? getChannelFromDisplayIndex(
              state.selectedChannelIndex,
              state.channels
            )
          : state.channels[state.selectedChannelIndex]

        if (channel) {
          dispatch({ type: 'SET_SELECTED_CHANNEL', channel })
          onChannelSelect?.(channel)
          markChannelVisited(channel.id, undefined, client?.type || 'discord')
          await loadMessages(channel)
          dispatch({ type: 'SET_VIEW', view: 'messages' })
        }
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

      // Toggle section collapse (Tab on header)
      if (key.tab && onToggleSection) {
        const currentItem = state.channelDisplayItems[state.selectedChannelIndex]
        if (currentItem?.startsWith('══════')) {
          // Extract section name from header
          let section: SectionName | null = null
          if (currentItem.includes('NEW')) section = 'new'
          else if (currentItem.includes('FOLLOWING')) section = 'following'
          else if (currentItem.includes('UNFOLLOWED')) section = 'unfollowed'

          if (section) {
            dispatch({ type: 'SET_LOADING', loading: true })
            const { channels, displayItems } = await onToggleSection(section)
            dispatch({ type: 'SET_CHANNELS', channels, displayItems })
            dispatch({ type: 'SET_LOADING', loading: false })
            return
          }
        }
      }

      // Exit
      if (key.escape) {
        onExit?.()
        exit()
        return
      }
    }

    // ==================== Messages View ====================
    if (view === 'messages') {
      // Navigation
      if (key.upArrow || input === 'k') {
        const newIndex = state.selectedMessageIndex - 1
        if (newIndex >= 0) {
          dispatch({ type: 'SELECT_MESSAGE_INDEX', index: newIndex })
          // Load older if near top
          if (newIndex <= 2) {
            await loadOlder()
          }
        }
        return
      }
      if (key.downArrow || input === 'j') {
        dispatch({
          type: 'SELECT_MESSAGE_INDEX',
          index: state.selectedMessageIndex + 1,
        })
        return
      }

      // Back to channels (with refresh)
      if (key.leftArrow || input === 'h') {
        if (onRefreshChannels) {
          await refreshChannels()
        }
        dispatch({ type: 'SET_VIEW', view: 'channels' })
        dispatch({
          type: 'SET_STATUS',
          text: `${title} - ↑↓ navigate · Enter select · Tab collapse · y follow · x unfollow`,
        })
        return
      }

      // New message
      if (input === 'i') {
        dispatch({ type: 'RESET_MESSAGE_STATE' })
        dispatch({ type: 'SET_VIEW', view: 'compose' })
        dispatch({
          type: 'SET_STATUS',
          text: 'Compose - Enter to send, Esc to cancel, /attach <path> for files',
        })
        return
      }

      // Reply
      if (input === 'r') {
        if (state.selectedMessageIndex >= 0) {
          const msgInfo = state.messages[state.selectedMessageIndex]
          dispatch({ type: 'SET_REPLYING_TO', messageId: msgInfo.id })
          dispatch({ type: 'SET_VIEW', view: 'compose' })
          dispatch({
            type: 'SET_STATUS',
            text: 'Reply - Enter to send, Esc to cancel',
          })
        }
        return
      }

      // React
      if (input === 'e') {
        if (state.selectedMessageIndex >= 0) {
          dispatch({ type: 'SET_VIEW', view: 'react' })
          dispatch({ type: 'SET_INPUT_TEXT', text: '' })
          dispatch({
            type: 'SET_STATUS',
            text: 'React - Enter emoji, Esc to cancel',
          })
        }
        return
      }

      // Delete
      if (input === 'd') {
        await deleteMessage()
        return
      }

      // Download attachments
      if (input === 'f') {
        await downloadAttachments()
        return
      }

      // Open URLs
      if (input === 'u') {
        await openUrls()
        return
      }

      // View reaction users
      if (input === 'v') {
        viewReactionUsers()
        return
      }

      // Escape goes back (with refresh)
      if (key.escape) {
        if (onRefreshChannels) {
          await refreshChannels()
        }
        dispatch({ type: 'SET_VIEW', view: 'channels' })
        dispatch({
          type: 'SET_STATUS',
          text: `${title} - ↑↓ navigate · Enter select · Tab collapse · y follow · x unfollow`,
        })
        return
      }
    }

    // ==================== Compose View ====================
    if (view === 'compose') {
      if (key.escape) {
        dispatch({ type: 'RESET_MESSAGE_STATE' })
        dispatch({ type: 'SET_VIEW', view: 'messages' })
        dispatch({
          type: 'SET_STATUS',
          text: `${
            state.selectedChannel?.name || 'Channel'
          } - ↑↓ select · d=del r=reply e=react i=new ←=back`,
        })
        return
      }
      // Let TextInput handle return key via onSubmit
    }

    // ==================== React View ====================
    if (view === 'react') {
      if (key.escape) {
        dispatch({ type: 'SET_INPUT_TEXT', text: '' })
        dispatch({ type: 'SET_VIEW', view: 'messages' })
        dispatch({
          type: 'SET_STATUS',
          text: `${
            state.selectedChannel?.name || 'Channel'
          } - ↑↓ select · d=del r=reply e=react i=new ←=back`,
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
        await sendMessage(state.llmProcessedText)
        return
      }
      if (input === 'o') {
        await sendMessage(state.llmOriginalText)
        return
      }
      if (input === 'e') {
        dispatch({ type: 'SET_INPUT_TEXT', text: state.llmProcessedText })
        dispatch({ type: 'SET_VIEW', view: 'compose' })
        return
      }
      if (input === 'O') {
        dispatch({ type: 'SET_INPUT_TEXT', text: state.llmOriginalText })
        dispatch({ type: 'SET_VIEW', view: 'compose' })
        return
      }
      if (key.escape) {
        dispatch({ type: 'CLEAR_LLM_TEXTS' })
        dispatch({ type: 'SET_VIEW', view: 'compose' })
        return
      }
    }

    // ==================== Reaction Users View ====================
    if (view === 'reactionUsers') {
      if (key.escape || input === 'q') {
        dispatch({ type: 'SET_VIEW', view: 'messages' })
        return
      }
    }
  })

  // Determine help bar bindings based on view
  const getHelpBindings = () => {
    switch (state.view) {
      case 'channels':
        return [
          { key: '↑↓/jk', label: 'navigate' },
          { key: 'Enter/→', label: 'select' },
          ...(onUnfollowChannel ? [{ key: 'x', label: 'unfollow' }] : []),
          { key: 'Esc', label: 'exit' },
        ]
      case 'messages':
        return [
          { key: '↑↓/jk', label: 'navigate' },
          { key: 'i', label: 'new' },
          { key: 'r', label: 'reply' },
          { key: 'e', label: 'react' },
          { key: 'd', label: 'delete' },
          { key: 'f', label: 'download' },
          { key: 'u', label: 'URLs' },
          { key: 'v', label: 'reactions' },
          { key: '←', label: 'back' },
        ]
      case 'compose':
        return [
          { key: 'Enter', label: 'send' },
          { key: 'Esc', label: 'cancel' },
        ]
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
        {state.view === 'channels' && (
          <ChannelsView
            items={state.channelDisplayItems}
            selectedIndex={state.selectedChannelIndex}
            rows={state.rows}
          />
        )}

        {state.view === 'messages' && (
          <MessagesView
            messages={state.messages}
            selectedIndex={state.selectedMessageIndex}
            scrollIndex={state.messageScrollIndex}
            rows={state.rows}
          />
        )}

        {state.view === 'compose' && (
          <ComposeView
            inputText={state.inputText}
            cursorPos={state.inputCursorPos}
            onInputChange={(text) => dispatch({ type: 'SET_INPUT_TEXT', text })}
            onCursorChange={(pos) =>
              dispatch({ type: 'SET_INPUT_CURSOR_POS', pos })
            }
            onSubmit={sendMessage}
            replyingTo={state.replyingToMessageId}
            attachedFiles={state.attachedFiles}
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
