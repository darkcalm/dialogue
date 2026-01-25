/**
 * CLI tool to show inbox-style channel grouping
 * Groups channels by: @-mentions, new messages, never visited
 */

import 'module-alias/register'
import 'source-map-support/register'

import { Client, GatewayIntentBits, TextChannel, ThreadChannel, Message } from 'discord.js'
import * as blessed from 'blessed'
import * as path from 'path'
import * as os from 'os'
import {
  ChannelInfo,
  MessageInfo,
  createUIComponents,
  loadMessages,
  loadVisitData,
  markChannelVisited,
  saveVisitData,
  extractUrls,
  openUrlInBrowser,
  formatDateHeader,
  rewriteMessageWithLLM,
  attachFile,
  downloadAttachments,
  resolveEmoji,
} from './shared'
import config from '@/helpers/env'

interface InboxChannelInfo extends ChannelInfo {
  group: 'mentions' | 'new' | 'unvisited' | 'visited'
  mentionCount?: number
  newMessageCount?: number
  lastMessageTimestamp?: Date
}

async function main() {
  try {
    console.log('🔌 Connecting to Discord...')
    
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })

    await client.login(config.DISCORD_BOT_TOKEN)

    await new Promise((resolve) => {
      if (client.isReady()) {
        resolve(undefined)
      } else {
        client.once('ready', resolve)
      }
    })

    console.log('✅ Connected!\n')
    console.log('📥 Scanning channels for inbox...')

    const visitData = loadVisitData()
    const botUserId = client.user?.id

    // Fetch all channels and categorize them
    const mentionChannels: InboxChannelInfo[] = []
    const newMessageChannels: InboxChannelInfo[] = []
    const unvisitedChannels: InboxChannelInfo[] = []
    const visitedChannels: InboxChannelInfo[] = []
    
    for (const [guildId, guild] of client.guilds.cache) {
      for (const [channelId, channel] of guild.channels.cache) {
        if (channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
          const permissions = channel.permissionsFor(guild.members.me!)
          if (!permissions?.has('ViewChannel') || !permissions?.has('SendMessages')) {
            continue
          }
          
          const channelInfo: InboxChannelInfo = {
            id: channel.id,
            name: channel.name,
            type: channel.isThread() ? 'thread' : 'text',
            guildName: guild.name,
            group: 'visited',
          }

          const channelVisit = visitData[channel.id]
          
          try {
            // Fetch recent messages to check for mentions and new messages
            const messages = await channel.messages.fetch({ limit: 50 })
            const messagesArray = Array.from(messages.values())
            
            if (messagesArray.length > 0) {
              channelInfo.lastMessageTimestamp = new Date(messagesArray[0].createdTimestamp)
            }

            // Check for @-mentions of the bot
            const mentionMessages = messagesArray.filter(msg => 
              msg.mentions.users.has(botUserId!) || 
              msg.content.includes(`<@${botUserId}>`) ||
              msg.content.includes(`<@!${botUserId}>`)
            )
            
            if (!channelVisit) {
              // Never visited
              channelInfo.group = 'unvisited'
              channelInfo.newMessageCount = messagesArray.length
              
              // But check if there are mentions - mentions take priority
              if (mentionMessages.length > 0) {
                channelInfo.group = 'mentions'
                channelInfo.mentionCount = mentionMessages.length
              }
            } else {
              const lastVisitDate = new Date(channelVisit.lastVisited)
              
              // Count messages since last visit
              const newMessages = messagesArray.filter(msg => 
                new Date(msg.createdTimestamp) > lastVisitDate
              )
              
              // Count mentions since last visit
              const newMentions = mentionMessages.filter(msg =>
                new Date(msg.createdTimestamp) > lastVisitDate
              )
              
              if (newMentions.length > 0) {
                channelInfo.group = 'mentions'
                channelInfo.mentionCount = newMentions.length
              } else if (newMessages.length > 0) {
                channelInfo.group = 'new'
                channelInfo.newMessageCount = newMessages.length
              } else {
                channelInfo.group = 'visited'
              }
            }
          } catch (err) {
            // Can't fetch messages, mark as unvisited
            if (!channelVisit) {
              channelInfo.group = 'unvisited'
            }
          }

          // Add to appropriate array
          switch (channelInfo.group) {
            case 'mentions':
              mentionChannels.push(channelInfo)
              break
            case 'new':
              newMessageChannels.push(channelInfo)
              break
            case 'unvisited':
              unvisitedChannels.push(channelInfo)
              break
            case 'visited':
              visitedChannels.push(channelInfo)
              break
          }
        }
      }
    }

    // Sort each group by last message timestamp (most recent first)
    const sortByTimestamp = (a: InboxChannelInfo, b: InboxChannelInfo) => {
      if (!a.lastMessageTimestamp && !b.lastMessageTimestamp) return 0
      if (!a.lastMessageTimestamp) return 1
      if (!b.lastMessageTimestamp) return -1
      return b.lastMessageTimestamp.getTime() - a.lastMessageTimestamp.getTime()
    }

    mentionChannels.sort(sortByTimestamp)
    newMessageChannels.sort(sortByTimestamp)
    unvisitedChannels.sort(sortByTimestamp)
    visitedChannels.sort(sortByTimestamp)

    // Combine all channels with group headers
    const allChannels: (InboxChannelInfo | { isHeader: true; label: string })[] = []
    
    if (mentionChannels.length > 0) {
      allChannels.push({ isHeader: true, label: `══════ 📢 MENTIONS (${mentionChannels.length}) ══════` })
      allChannels.push(...mentionChannels)
    }
    
    if (newMessageChannels.length > 0) {
      allChannels.push({ isHeader: true, label: `══════ 🆕 NEW MESSAGES (${newMessageChannels.length}) ══════` })
      allChannels.push(...newMessageChannels)
    }
    
    if (unvisitedChannels.length > 0) {
      allChannels.push({ isHeader: true, label: `══════ 👀 NEVER VISITED (${unvisitedChannels.length}) ══════` })
      allChannels.push(...unvisitedChannels)
    }
    
    if (visitedChannels.length > 0) {
      allChannels.push({ isHeader: true, label: `══════ ✓ UP TO DATE (${visitedChannels.length}) ══════` })
      allChannels.push(...visitedChannels)
    }

    const channelList = allChannels.filter(item => !('isHeader' in item)) as InboxChannelInfo[]

    if (channelList.length === 0) {
      console.log('❌ No accessible channels found')
      await client.destroy()
      process.exit(0)
    }

    console.log(`Found ${mentionChannels.length} with mentions, ${newMessageChannels.length} with new messages, ${unvisitedChannels.length} never visited`)

    // Create UI components
    const ui = createUIComponents('Discord Inbox')

    let selectedChannelIndex = 0
    let selectedChannel = channelList[0]
    let recentMessages: MessageInfo[] = []
    let messageObjects: Map<string, Message> = new Map()
    let messageScrollIndex = 0
    let selectedMessageIndex = -1
    let currentMode: 'channel-select' | 'messages' | 'input' | 'react-input' | 'llm-review' = 'channel-select'
    let replyingToMessage: Message | null = null
    let attachedFiles: Array<{ path: string; name: string }> = []
    let llmOriginalText = ''
    let llmProcessedText = ''

    // Build display list with headers
    const buildChannelDisplayList = (): string[] => {
      const displayItems: string[] = []
      
      if (mentionChannels.length > 0) {
        displayItems.push(`══════ 📢 MENTIONS (${mentionChannels.length}) ══════`)
        mentionChannels.forEach(ch => {
          const badge = ch.mentionCount ? ` [${ch.mentionCount} @]` : ''
          displayItems.push(`  ${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}${badge}`)
        })
      }
      
      if (newMessageChannels.length > 0) {
        displayItems.push(`══════ 🆕 NEW MESSAGES (${newMessageChannels.length}) ══════`)
        newMessageChannels.forEach(ch => {
          const badge = ch.newMessageCount ? ` [${ch.newMessageCount} new]` : ''
          displayItems.push(`  ${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}${badge}`)
        })
      }
      
      if (unvisitedChannels.length > 0) {
        displayItems.push(`══════ 👀 NEVER VISITED (${unvisitedChannels.length}) ══════`)
        unvisitedChannels.forEach(ch => {
          displayItems.push(`  ${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}`)
        })
      }
      
      if (visitedChannels.length > 0) {
        displayItems.push(`══════ ✓ UP TO DATE (${visitedChannels.length}) ══════`)
        visitedChannels.forEach(ch => {
          displayItems.push(`  ${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}`)
        })
      }
      
      return displayItems
    }

    // Map display index to actual channel
    const getChannelFromDisplayIndex = (displayIndex: number): InboxChannelInfo | null => {
      const displayList = buildChannelDisplayList()
      const item = displayList[displayIndex]
      if (!item || item.startsWith('══════')) {
        return null // It's a header
      }
      
      // Count actual channels before this index
      let channelCount = 0
      for (let i = 0; i <= displayIndex; i++) {
        const di = displayList[i]
        if (di && !di.startsWith('══════')) {
          channelCount++
        }
      }
      
      // Get the channel at this position
      return channelList[channelCount - 1] || null
    }

    const updateChannelList = () => {
      const displayList = buildChannelDisplayList()
      ui.channelListBox.setItems(displayList)
      ui.screen.render()
    }

    const updateMessagesDisplay = () => {
      if (recentMessages.length === 0) {
        ui.messagesBox.setContent('No recent messages')
        ui.screen.render()
        return
      }

      const visibleMessages = recentMessages.slice(
        Math.max(0, messageScrollIndex),
        Math.min(recentMessages.length, messageScrollIndex + 10)
      )

      const contentParts: string[] = []
      let lastDateStr = ''

      visibleMessages.forEach((msg, idx) => {
        const actualIdx = messageScrollIndex + idx
        const isSelected = actualIdx === selectedMessageIndex && currentMode === 'messages'
        const prefix = isSelected ? '▶ ' : '  '
        
        const currentDateStr = msg.date.toDateString()
        if (currentDateStr !== lastDateStr) {
          const dateHeader = formatDateHeader(msg.date)
          contentParts.push(`\n━━━ ${dateHeader} ━━━`)
          lastDateStr = currentDateStr
        }
        
        // Add reply indicator if this message is a reply
        let replyLine = ''
        if (msg.replyTo) {
          replyLine = `${prefix}  ↳ Replying to ${msg.replyTo.author}: ${msg.replyTo.content}\n`
        }
        
        const lines = msg.content.split('\n')
        const attachmentIndicator = msg.hasAttachments 
          ? ` 📎(${msg.attachmentCount} file${msg.attachmentCount > 1 ? 's' : ''})` 
          : ''
        const messageLines = lines.map((line, i) => {
          if (i === 0) {
            return `${prefix}[${msg.timestamp}] ${msg.author}${attachmentIndicator}: ${line}`
          } else {
            const firstLinePrefix = `[${msg.timestamp}] ${msg.author}${attachmentIndicator}: `
            return `${prefix}${' '.repeat(firstLinePrefix.length)}${line}`
          }
        }).join('\n')
        
        let reactionsDisplay = ''
        if (msg.reactions && msg.reactions.length > 0) {
          const firstLinePrefix = `[${msg.timestamp}] ${msg.author}${attachmentIndicator}: `
          const reactionsText = msg.reactions
            .map(r => `${r.emoji} ${r.count}`)
            .join('  ')
          reactionsDisplay = `\n${prefix}${' '.repeat(firstLinePrefix.length)}${reactionsText}`
        }
        
        contentParts.push(replyLine + messageLines + reactionsDisplay)
      })

      ui.messagesBox.setContent(contentParts.join('\n\n'))
      ui.screen.render()
    }

    const updateAttachmentsDisplay = () => {
      if (attachedFiles.length === 0) {
        ui.attachmentsBox.hide()
        ui.attachmentsBox.setContent('')
      } else {
        ui.attachmentsBox.show()
        const fileList = attachedFiles.map((file, idx) => 
          `  📎 ${idx + 1}. ${file.name}`
        ).join('\n')
        ui.attachmentsBox.setContent(`Attached files:\n${fileList}`)
        ui.attachmentsBox.height = Math.min(attachedFiles.length + 2, 8)
      }
      ui.screen.render()
    }

    const clearAttachments = () => {
      attachedFiles = []
      updateAttachmentsDisplay()
    }

    // Initial load
    updateChannelList()
    ui.statusBox.setContent('Discord Inbox - ↑↓ to navigate, → to select channel, Esc to exit')

    // Channel navigation
    ui.channelListBox.on('select item', (item, index) => {
      const channel = getChannelFromDisplayIndex(index)
      if (channel) {
        selectedChannel = channel
        selectedChannelIndex = channelList.indexOf(channel)
      }
    })

    // Track selected display index
    let selectedDisplayIndex = 0
    ui.channelListBox.on('select item', (item: any, index: number) => {
      selectedDisplayIndex = index
    })

    // Select channel with right arrow
    ui.channelListBox.key(['right', 'enter'], async () => {
      const channel = getChannelFromDisplayIndex(selectedDisplayIndex)
      
      if (!channel) {
        // It's a header, skip
        return
      }
      
      selectedChannel = channel
      selectedChannelIndex = channelList.indexOf(channel)
      
      recentMessages = await loadMessages(client, selectedChannel, messageObjects)
      
      // Mark channel as visited
      const lastMsgId = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1].id : undefined
      markChannelVisited(selectedChannel.id, lastMsgId)
      
      messageScrollIndex = Math.max(0, recentMessages.length - 5)
      selectedMessageIndex = recentMessages.length > 0 ? recentMessages.length - 1 : -1
      
      updateMessagesDisplay()
      currentMode = 'messages'
      ui.messagesBox.focus()
      ui.statusBox.setContent(`Channel: ${selectedChannel.guildName ? `${selectedChannel.guildName} / ` : ''}${selectedChannel.name} - ↑↓ to select message, d=delete, r=reply, e=react, f=download, u=open URLs, i=send, ←=change channel`)
      ui.screen.render()
    })

    // Message navigation
    ui.messagesBox.key(['up', 'k'], () => {
      if (currentMode === 'messages' && recentMessages.length > 0) {
        if (selectedMessageIndex === -1) {
          selectedMessageIndex = Math.min(messageScrollIndex + 9, recentMessages.length - 1)
        } else if (selectedMessageIndex > 0) {
          selectedMessageIndex--
          if (selectedMessageIndex < messageScrollIndex) {
            messageScrollIndex = selectedMessageIndex
          }
        } else if (messageScrollIndex > 0) {
          messageScrollIndex--
        }
        updateMessagesDisplay()
      }
    })

    ui.messagesBox.key(['down', 'j'], () => {
      if (currentMode === 'messages' && recentMessages.length > 0) {
        if (selectedMessageIndex === -1) {
          selectedMessageIndex = messageScrollIndex
        } else if (selectedMessageIndex < recentMessages.length - 1) {
          selectedMessageIndex++
          if (selectedMessageIndex >= messageScrollIndex + 10) {
            messageScrollIndex = selectedMessageIndex - 9
          }
        } else if (messageScrollIndex < recentMessages.length - 1) {
          messageScrollIndex++
        }
        updateMessagesDisplay()
      }
    })

    // Helper to move channel to visited group after viewing
    const moveChannelToVisited = (channel: InboxChannelInfo) => {
      if (channel.group === 'visited') return // Already visited
      
      // Remove from current group
      let sourceArray: InboxChannelInfo[] | null = null
      switch (channel.group) {
        case 'mentions':
          sourceArray = mentionChannels
          break
        case 'new':
          sourceArray = newMessageChannels
          break
        case 'unvisited':
          sourceArray = unvisitedChannels
          break
      }
      
      if (sourceArray) {
        const index = sourceArray.indexOf(channel)
        if (index > -1) {
          sourceArray.splice(index, 1)
        }
      }
      
      // Update channel properties
      channel.group = 'visited'
      channel.mentionCount = 0
      channel.newMessageCount = 0
      
      // Add to visited (at the beginning since it's most recent)
      visitedChannels.unshift(channel)
      
      // Rebuild the channelList to match new order
      channelList.length = 0
      channelList.push(...mentionChannels, ...newMessageChannels, ...unvisitedChannels, ...visitedChannels)
    }

    // Mode switching with left arrow
    ui.screen.key(['left'], () => {
      if (currentMode !== 'input') {
        // If we were viewing messages, mark the channel as visited and update groups
        if (currentMode === 'messages' && selectedChannel) {
          moveChannelToVisited(selectedChannel)
          updateChannelList()
        }
        
        currentMode = 'channel-select'
        ui.channelListBox.focus()
        ui.statusBox.setContent('Discord Inbox - ↑↓ to navigate, → to select channel, Esc to exit')
        ui.screen.render()
      }
    })

    // Message actions
    const deleteSelectedMessage = async () => {
      if (selectedMessageIndex < 0 || selectedMessageIndex >= recentMessages.length) {
        ui.statusBox.setContent('❌ No message selected')
        ui.screen.render()
        return
      }

      const messageInfo = recentMessages[selectedMessageIndex]
      const message = messageObjects.get(messageInfo.id)

      if (!message) {
        ui.statusBox.setContent('❌ Message not found')
        ui.screen.render()
        return
      }

      if (message.author.id !== client.user?.id) {
        ui.statusBox.setContent('❌ Can only delete bot messages')
        ui.screen.render()
        return
      }

      try {
        await message.delete()
        ui.statusBox.setContent('✅ Message deleted')
        ui.screen.render()
        recentMessages = await loadMessages(client, selectedChannel, messageObjects)
        updateMessagesDisplay()
        if (selectedMessageIndex >= recentMessages.length) {
          selectedMessageIndex = recentMessages.length - 1
        }
        updateMessagesDisplay()
      } catch (err) {
        ui.statusBox.setContent(`❌ Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
        ui.screen.render()
      }
    }

    const replyToSelectedMessage = () => {
      if (selectedMessageIndex < 0 || selectedMessageIndex >= recentMessages.length) {
        ui.statusBox.setContent('❌ No message selected')
        ui.screen.render()
        return
      }

      const messageInfo = recentMessages[selectedMessageIndex]
      const message = messageObjects.get(messageInfo.id)

      if (!message) {
        ui.statusBox.setContent('❌ Message not found')
        ui.screen.render()
        return
      }

      replyingToMessage = message
      clearAttachments()
      currentMode = 'input'
      ui.reactionInputBox.hide()
      ui.inputBox.show()
      ui.inputBox.focus()
      ui.statusBox.setContent(`Replying to ${messageInfo.author}. Type message, Enter to send, Esc to cancel`)
      ui.screen.render()
    }

    const reactToSelectedMessage = async () => {
      if (selectedMessageIndex < 0 || selectedMessageIndex >= recentMessages.length) {
        ui.statusBox.setContent('❌ No message selected')
        ui.screen.render()
        return
      }

      const messageInfo = recentMessages[selectedMessageIndex]
      const message = messageObjects.get(messageInfo.id)

      if (!message) {
        ui.statusBox.setContent('❌ Message not found')
        ui.screen.render()
        return
      }

      currentMode = 'react-input'
      ui.inputBox.hide()
      ui.reactionInputBox.show()
      ui.reactionInputBox.focus()
      ui.statusBox.setContent(`Add reaction to ${messageInfo.author}'s message. Enter emoji, press Enter`)
      ui.screen.render()
    }

    const downloadSelectedAttachments = async () => {
      if (selectedMessageIndex < 0 || selectedMessageIndex >= recentMessages.length) {
        ui.statusBox.setContent('❌ No message selected')
        ui.screen.render()
        return
      }

      const messageInfo = recentMessages[selectedMessageIndex]
      const message = messageObjects.get(messageInfo.id)

      if (!message) {
        ui.statusBox.setContent('❌ Message not found')
        ui.screen.render()
        return
      }

      await downloadAttachments(message, (msg) => {
        ui.statusBox.setContent(msg)
        ui.screen.render()
      })
    }

    const openUrlsFromSelectedMessage = async () => {
      if (selectedMessageIndex < 0 || selectedMessageIndex >= recentMessages.length) {
        ui.statusBox.setContent('❌ No URLs found in message')
        ui.screen.render()
        return
      }

      const messageInfo = recentMessages[selectedMessageIndex]
      const urls = extractUrls(messageInfo.content)

      if (urls.length === 0) {
        ui.statusBox.setContent('❌ No URLs found in message')
        ui.screen.render()
        return
      }

      try {
        for (const url of urls) {
          await openUrlInBrowser(url)
        }
        ui.statusBox.setContent(`✅ Opened ${urls.length} URL(s) in browser`)
        ui.screen.render()
      } catch (err) {
        ui.statusBox.setContent(`❌ Error opening URLs: ${err instanceof Error ? err.message : 'Unknown error'}`)
        ui.screen.render()
      }
    }

    // Send message helper
    const sendCurrentMessage = async (finalMessageText: string) => {
      const filePaths = attachedFiles.map(file => file.path)

      if (!finalMessageText && filePaths.length === 0) return

      try {
        if (replyingToMessage) {
          const options: any = {}
          if (finalMessageText) options.content = finalMessageText
          if (filePaths.length > 0) options.files = filePaths
          await replyingToMessage.reply(options)
          replyingToMessage = null
        } else {
          const channel = await client.channels.fetch(selectedChannel.id)
          if (channel && channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
            const options: any = {}
            if (finalMessageText) options.content = finalMessageText
            if (filePaths.length > 0) options.files = filePaths
            await channel.send(options)
          }
        }

        ui.inputBox.clearValue()
        ui.inputBox.setValue('')
        clearAttachments()
        llmOriginalText = ''
        llmProcessedText = ''
        ui.llmPreviewBox.hide()
        currentMode = 'messages'
        ui.messagesBox.focus()
        recentMessages = await loadMessages(client, selectedChannel, messageObjects)
        updateMessagesDisplay()
        ui.statusBox.setContent('✅ Message sent!')
        ui.screen.render()
      } catch (err) {
        ui.statusBox.setContent(`❌ Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
        ui.screen.render()
      }
    }

    // Input handling
    ui.inputBox.key(['enter'], async () => {
      const rawInput = ui.inputBox.getValue()
      if (!rawInput.trim() && attachedFiles.length === 0) {
        return
      }

      let llmRequested = false
      let fullInput = rawInput
      if (fullInput.startsWith('llm://')) {
        llmRequested = true
        fullInput = fullInput.substring('llm://'.length)
      } else if (fullInput.endsWith('\\\\:llm')) {
        llmRequested = true
        fullInput = fullInput.substring(0, fullInput.length - '\\\\:llm'.length)
      }

      const trimmed = fullInput.trim()
      if (!trimmed && attachedFiles.length === 0) {
        return
      }

      // Parse /attach commands
      let messageText = ''
      const filesToAttach: string[] = []
      const attachRegex = /\/attach\s+(?:"([^"]+)"|(\S+))/g
      let match
      let lastIndex = 0
      const textParts: string[] = []

      while ((match = attachRegex.exec(trimmed)) !== null) {
        if (match.index > lastIndex) {
          const textBefore = trimmed.substring(lastIndex, match.index).trim()
          if (textBefore) textParts.push(textBefore)
        }
        const filePath = (match[1] || match[2] || '').trim()
        if (filePath) {
          filesToAttach.push(filePath)
        }
        lastIndex = match.index + match[0].length
      }

      if (lastIndex < trimmed.length) {
        const textAfter = trimmed.substring(lastIndex).trim()
        if (textAfter) textParts.push(textAfter)
      }

      messageText = textParts.join(' ').trim()

      // Attach files
      let anyAttached = false
      filesToAttach.forEach(filePath => {
        const unescapedPath = filePath.replace(/\\ /g, ' ')
        if (attachFile(unescapedPath, attachedFiles)) {
          anyAttached = true
        }
      })

      updateAttachmentsDisplay()

      if (filesToAttach.length > 0 && !anyAttached) {
        ui.statusBox.setContent('❌ No valid files found. Check file paths and try again')
        ui.screen.render()
      }

      if (!llmRequested) {
        if (messageText || attachedFiles.length > 0) {
          await sendCurrentMessage(messageText)
        }
        return
      }

      // LLM requested
      llmOriginalText = messageText
      llmProcessedText = messageText

      if (messageText) {
        try {
          const rewritten = await rewriteMessageWithLLM(messageText)
          llmProcessedText = rewritten || messageText
        } catch {
          llmProcessedText = messageText
        }
      }

      // Show LLM preview
      const previewLines: string[] = []
      previewLines.push('LLM rewrite preview: [p=send processed] [o=send original] [e=edit processed] [O=edit original] [Esc=cancel]')
      previewLines.push('  Processed:')
      
      const processedLines = (llmProcessedText || '(empty)').split('\n')
      processedLines.forEach(line => {
        previewLines.push(`    ${line}`)
      })
      
      previewLines.push('  Original :')
      
      const originalLines = (llmOriginalText || '(empty)').split('\n')
      originalLines.forEach(line => {
        previewLines.push(`    ${line}`)
      })
      
      const totalLines = previewLines.length
      const calculatedHeight = Math.min(Math.max(5, totalLines), 20)
      
      ui.llmPreviewBox.height = calculatedHeight
      ui.llmPreviewBox.setContent(previewLines.join('\n'))
      ui.llmPreviewBox.scrollTo(0)
      
      ui.inputBox.hide()
      ui.reactionInputBox.hide()
      ui.llmPreviewBox.show()
      
      if (attachedFiles.length > 0) {
        updateAttachmentsDisplay()
        ui.attachmentsBox.show()
        ui.attachmentsBox.top = '90%'
        ui.attachmentsBox.height = Math.min(attachedFiles.length + 2, 6)
      } else {
        ui.attachmentsBox.hide()
      }
      
      currentMode = 'llm-review'
      ui.messagesBox.focus()
      ui.screen.render()
    })

    // Reaction input handling
    ui.reactionInputBox.key(['enter'], async () => {
      const emojiInput = ui.reactionInputBox.getValue().trim()
      if (!emojiInput) {
        return
      }

      ui.reactionInputBox.clearValue()
      ui.reactionInputBox.setValue('')
      ui.reactionInputBox.hide()
      ui.inputBox.show()
      currentMode = 'messages'
      ui.messagesBox.focus()

      if (selectedMessageIndex >= 0 && selectedMessageIndex < recentMessages.length) {
        const messageInfo = recentMessages[selectedMessageIndex]
        const message = messageObjects.get(messageInfo.id)

        if (message) {
          try {
            const channel = await client.channels.fetch(selectedChannel.id)
            if (!channel || !channel.isTextBased() || !(channel instanceof TextChannel || channel instanceof ThreadChannel)) {
              ui.statusBox.setContent('❌ Channel not found')
              ui.screen.render()
              return
            }

            const resolved = await resolveEmoji(emojiInput, channel)
            if (!resolved) {
              ui.statusBox.setContent(`❌ Unknown emoji: ${emojiInput}`)
              ui.screen.render()
              return
            }

            await message.react(resolved)
            ui.statusBox.setContent(`✅ Added reaction ${emojiInput}`)
            ui.screen.render()
            recentMessages = await loadMessages(client, selectedChannel, messageObjects)
            updateMessagesDisplay()
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error'
            if (errorMessage.includes('Unknown Emoji') || errorMessage.includes('Reaction blocked')) {
              ui.statusBox.setContent(`❌ Unknown emoji: ${emojiInput}. Use Unicode emoji (🐙) or custom emoji format (<:name:id>)`)
            } else {
              ui.statusBox.setContent(`❌ Error adding reaction: ${errorMessage}`)
            }
            ui.screen.render()
          }
        }
      }
    })

    ui.reactionInputBox.key(['escape'], () => {
      ui.reactionInputBox.hide()
      ui.reactionInputBox.clearValue()
      ui.reactionInputBox.setValue('')
      ui.inputBox.show()
      currentMode = 'messages'
      ui.messagesBox.focus()
      ui.statusBox.setContent(`Channel: ${selectedChannel.guildName ? `${selectedChannel.guildName} / ` : ''}${selectedChannel.name} - ↑↓ to select message, d=delete, r=reply, e=react, f=download, u=open URLs, i=send, ←=change channel`)
      ui.screen.render()
    })

    // Key bindings
    ui.screen.key(['i', 'I'], () => {
      if (currentMode === 'messages' || currentMode === 'channel-select') {
        replyingToMessage = null
        clearAttachments()
        llmOriginalText = ''
        llmProcessedText = ''
        ui.llmPreviewBox.hide()
        currentMode = 'input'
        ui.reactionInputBox.hide()
        ui.inputBox.show()
        ui.inputBox.focus()
        ui.statusBox.setContent('Type message (optionally with /attach <path> and llm:// or :\\\\llm), Enter to send, Esc to cancel')
        ui.screen.render()
      }
    })

    ui.screen.key(['d', 'D'], async () => {
      if (currentMode === 'messages') {
        await deleteSelectedMessage()
      }
    })

    ui.screen.key(['r', 'R'], async () => {
      if (currentMode === 'messages') {
        await replyToSelectedMessage()
      }
    })

    ui.screen.key(['e', 'E'], async () => {
      if (currentMode === 'llm-review') {
        ui.inputBox.show()
        ui.reactionInputBox.hide()
        currentMode = 'input'
        ui.inputBox.setValue(llmProcessedText)
        ui.inputBox.focus()
        ui.llmPreviewBox.hide()
        ui.statusBox.setContent('Editing processed message. Modify text and press Enter to send, Esc to cancel')
        ui.screen.render()
      } else if (currentMode === 'messages') {
        await reactToSelectedMessage()
      }
    })

    ui.screen.key(['f', 'F'], async () => {
      if (currentMode === 'messages') {
        await downloadSelectedAttachments()
      }
    })

    ui.screen.key(['u', 'U'], async () => {
      if (currentMode === 'messages') {
        await openUrlsFromSelectedMessage()
      }
    })

    ui.screen.key(['p', 'P'], async () => {
      if (currentMode === 'llm-review') {
        await sendCurrentMessage(llmProcessedText)
      }
    })

    ui.screen.key(['o'], async () => {
      if (currentMode === 'llm-review') {
        await sendCurrentMessage(llmOriginalText)
      }
    })

    ui.screen.key(['O'], () => {
      if (currentMode === 'llm-review') {
        ui.inputBox.show()
        ui.reactionInputBox.hide()
        currentMode = 'input'
        ui.inputBox.setValue(llmOriginalText)
        ui.inputBox.focus()
        ui.llmPreviewBox.hide()
        ui.statusBox.setContent('Editing original message. Modify text and press Enter to send, Esc to cancel')
        ui.screen.render()
      }
    })

    ui.screen.key(['escape'], () => {
      if (currentMode === 'llm-review') {
        ui.llmPreviewBox.hide()
        ui.inputBox.show()
        ui.reactionInputBox.hide()
        currentMode = 'input'
        ui.inputBox.focus()
        ui.statusBox.setContent('Type message (optionally with /attach <path> and llm:// or :\\\\llm), Enter to send, Esc to cancel')
        ui.screen.render()
      } else if (currentMode === 'channel-select') {
        ui.screen.destroy()
        void client.destroy()
        process.exit(0)
      }
    })

    ui.inputBox.key(['escape'], () => {
      currentMode = 'messages'
      ui.reactionInputBox.hide()
      ui.inputBox.show()
      ui.messagesBox.focus()
      ui.inputBox.clearValue()
      ui.inputBox.setValue('')
      replyingToMessage = null
      clearAttachments()
      llmOriginalText = ''
      llmProcessedText = ''
      ui.llmPreviewBox.hide()
      ui.statusBox.setContent(`Channel: ${selectedChannel.guildName ? `${selectedChannel.guildName} / ` : ''}${selectedChannel.name} - ↑↓ to select message, d=delete, r=reply, e=react, f=download, u=open URLs, i=send, ←=change channel`)
      ui.screen.render()
    })

    ui.screen.key(['C-c'], () => {
      ui.screen.destroy()
      void client.destroy()
      process.exit(0)
    })

    // ==================== Real-time Message Subscription ====================
    
    // Helper to find channel in any of the arrays
    const findChannelInArrays = (channelId: string): { channel: InboxChannelInfo | null, array: InboxChannelInfo[] | null } => {
      for (const ch of mentionChannels) {
        if (ch.id === channelId) return { channel: ch, array: mentionChannels }
      }
      for (const ch of newMessageChannels) {
        if (ch.id === channelId) return { channel: ch, array: newMessageChannels }
      }
      for (const ch of unvisitedChannels) {
        if (ch.id === channelId) return { channel: ch, array: unvisitedChannels }
      }
      for (const ch of visitedChannels) {
        if (ch.id === channelId) return { channel: ch, array: visitedChannels }
      }
      return { channel: null, array: null }
    }

    // Helper to move channel between arrays
    const moveChannelToArray = (channel: InboxChannelInfo, fromArray: InboxChannelInfo[], toArray: InboxChannelInfo[]) => {
      const index = fromArray.indexOf(channel)
      if (index > -1) {
        fromArray.splice(index, 1)
      }
      // Add to beginning of target array (most recent first)
      toArray.unshift(channel)
    }

    // Helper to rebuild channelList after array changes
    const rebuildChannelList = () => {
      channelList.length = 0
      channelList.push(...mentionChannels, ...newMessageChannels, ...unvisitedChannels, ...visitedChannels)
    }

    // Subscribe to real-time messages
    client.on('messageCreate', async (message) => {
      // Ignore bot's own messages
      if (message.author.id === botUserId) {
        // But still refresh if we're viewing this channel
        if (currentMode === 'messages' && selectedChannel && message.channelId === selectedChannel.id) {
          recentMessages = await loadMessages(client, selectedChannel, messageObjects)
          updateMessagesDisplay()
        }
        return
      }

      // Find the channel in our tracking arrays
      const { channel: trackedChannel, array: sourceArray } = findChannelInArrays(message.channelId)
      
      if (!trackedChannel || !sourceArray) {
        // Channel not in our list (maybe no permissions), ignore
        return
      }

      // Check if bot is mentioned
      const isMention = message.mentions.users.has(botUserId!) ||
        message.content.includes(`<@${botUserId}>`) ||
        message.content.includes(`<@!${botUserId}>`)

      // Update channel info
      trackedChannel.lastMessageTimestamp = new Date(message.createdTimestamp)

      // Determine target array based on mention status
      let targetArray: InboxChannelInfo[]
      let notificationPrefix: string

      if (isMention) {
        targetArray = mentionChannels
        trackedChannel.mentionCount = (trackedChannel.mentionCount || 0) + 1
        trackedChannel.group = 'mentions'
        notificationPrefix = '📢 @Mention'
      } else {
        // Move to new messages if not already in mentions
        if (trackedChannel.group !== 'mentions') {
          targetArray = newMessageChannels
          trackedChannel.newMessageCount = (trackedChannel.newMessageCount || 0) + 1
          trackedChannel.group = 'new'
          notificationPrefix = '🆕 New message'
        } else {
          // Already in mentions, keep it there but increment count
          targetArray = mentionChannels
          trackedChannel.newMessageCount = (trackedChannel.newMessageCount || 0) + 1
          notificationPrefix = '📢 @Mention'
        }
      }

      // Move channel if needed
      if (sourceArray !== targetArray) {
        moveChannelToArray(trackedChannel, sourceArray, targetArray)
      } else {
        // Move to top of current array (most recent)
        const index = sourceArray.indexOf(trackedChannel)
        if (index > 0) {
          sourceArray.splice(index, 1)
          sourceArray.unshift(trackedChannel)
        }
      }

      // Rebuild channel list
      rebuildChannelList()

      // If we're viewing this channel, refresh messages
      if (currentMode === 'messages' && selectedChannel && message.channelId === selectedChannel.id) {
        recentMessages = await loadMessages(client, selectedChannel, messageObjects)
        updateMessagesDisplay()
        // Mark as visited since we're actively viewing
        markChannelVisited(selectedChannel.id, message.id)
      }

      // Update the channel list display
      updateChannelList()

      // Show notification in status bar (if not currently in this channel)
      if (currentMode === 'channel-select' || (selectedChannel && message.channelId !== selectedChannel.id)) {
        const authorName = message.author.displayName || message.author.username
        const channelName = trackedChannel.guildName 
          ? `${trackedChannel.guildName}/${trackedChannel.name}`
          : trackedChannel.name
        const preview = message.content.substring(0, 50) + (message.content.length > 50 ? '...' : '')
        ui.statusBox.setContent(`${notificationPrefix} in ${channelName}: ${authorName}: ${preview}`)
        ui.screen.render()

        // Reset status after 5 seconds if still in channel-select mode
        setTimeout(() => {
          if (currentMode === 'channel-select') {
            ui.statusBox.setContent('Discord Inbox - ↑↓ to navigate, → to select channel, Esc to exit')
            ui.screen.render()
          }
        }, 5000)
      }
    })

    // Layout
    ui.screen.append(ui.statusBox)
    ui.screen.append(ui.channelListBox)
    ui.screen.append(ui.messagesBox)
    ui.screen.append(ui.llmPreviewBox)
    ui.screen.append(ui.attachmentsBox)
    ui.screen.append(ui.inputBox)
    ui.screen.append(ui.reactionInputBox)

    ui.channelListBox.focus()
    ui.screen.render()
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
}

if (require.main === module) {
  void main()
}
