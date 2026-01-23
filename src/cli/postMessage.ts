/**
 * CLI tool to post messages as the bot
 * Uses Blessed for interactive terminal UI with navigation
 */

import 'module-alias/register'
import 'source-map-support/register'

import { Client, GatewayIntentBits, TextChannel, ThreadChannel, Message } from 'discord.js'
import * as blessed from 'blessed'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as https from 'https'
import * as http from 'http'
import config from '@/helpers/env'

interface ChannelInfo {
  id: string
  name: string
  type: string
  guildName?: string
}

interface MessageInfo {
  id: string
  author: string
  authorId: string
  content: string
  timestamp: string
  isBot: boolean
  hasAttachments: boolean // Whether message has any attachments
  attachmentCount: number // Number of attachments
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

    // Fetch all channels
    const channelList: ChannelInfo[] = []
    
    for (const [guildId, guild] of client.guilds.cache) {
      for (const [channelId, channel] of guild.channels.cache) {
        if (channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
          const permissions = channel.permissionsFor(guild.members.me!)
          if (permissions?.has('SendMessages')) {
            channelList.push({
              id: channel.id,
              name: channel.name,
              type: channel.isThread() ? 'thread' : 'text',
              guildName: guild.name,
            })
          }
        }
      }
    }

    channelList.sort((a, b) => {
      if (a.guildName !== b.guildName) {
        return (a.guildName || '').localeCompare(b.guildName || '')
      }
      return a.name.localeCompare(b.name)
    })

    if (channelList.length === 0) {
      console.log('❌ No accessible channels found')
      await client.destroy()
      process.exit(0)
    }

    // Create Blessed screen
    const screen = blessed.screen({
      smartCSR: true,
      title: 'Discord Bot CLI',
    })

    let selectedChannelIndex = 0
    let selectedChannel = channelList[0]
    let recentMessages: MessageInfo[] = []
    let messageObjects: Map<string, Message> = new Map() // Store actual Message objects for interactions
    let messageScrollIndex = 0
    let selectedMessageIndex = -1 // Index of selected message for actions
    let currentMode: 'channel-select' | 'messages' | 'input' | 'react-input' = 'channel-select'
    let replyingToMessage: Message | null = null // Message we're replying to
    let attachedFiles: Array<{ path: string; name: string }> = [] // Files attached to current message

    // Helper to load messages
    const loadMessages = async (channelInfo: ChannelInfo) => {
      try {
        const channel = await client.channels.fetch(channelInfo.id)
        if (channel && channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
          const messages = await channel.messages.fetch({ limit: 20 })
          messageObjects.clear() // Clear old message objects
          recentMessages = Array.from(messages.values())
            .slice(0, 15) // Show last 15 messages (including bot messages)
            .reverse()
            .map(msg => {
              // Store the actual Message object
              messageObjects.set(msg.id, msg)
              const authorName = msg.author.displayName || msg.author.username
              const botTag = msg.author.bot ? ' [BOT]' : ''
              
              // Check for attachments
              const hasAttachments = msg.attachments.size > 0
              const attachmentCount = msg.attachments.size
              
              return {
                id: msg.id,
                author: `${authorName}${botTag}`,
                authorId: msg.author.id,
                content: msg.content || '(no text content)',
                timestamp: new Date(msg.createdTimestamp).toLocaleTimeString(),
                isBot: msg.author.bot,
                hasAttachments,
                attachmentCount,
              }
            })
          // Start at the bottom (most recent messages) - show last 5 messages initially
          messageScrollIndex = Math.max(0, recentMessages.length - 5)
          selectedMessageIndex = -1 // Reset selection
        }
      } catch (err) {
        // Silently fail
      }
    }

    // Channel list box
    const channelListBox = blessed.list({
      top: 1,
      left: 0,
      width: '40%',
      height: '100%',
      items: channelList.map((ch, idx) => 
        `${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}${ch.type === 'thread' ? ' (thread)' : ''}`
      ),
      keys: true,
      vi: true,
      mouse: true,
      style: {
        selected: {
          bg: 'green',
          fg: 'black',
        },
      },
    })

    // Messages box
    const messagesBox = blessed.box({
      top: 1,
      left: '40%',
      width: '60%',
      height: '80%',
      content: '',
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
      },
      style: {
        scrollbar: {
          bg: 'blue',
        },
      },
    })

    // Attachments display box
    const attachmentsBox = blessed.box({
      bottom: 3,
      left: '40%',
      width: '60%',
      height: 3,
      content: '',
      scrollable: true,
      alwaysScroll: true,
      hidden: true,
      style: {
        fg: 'cyan',
        bg: 'blue',
      },
    })

    // Input box
    const inputBox = blessed.textbox({
      bottom: 0,
      left: '40%',
      width: '60%',
      height: 3,
      inputOnFocus: true,
      style: {
        fg: 'white',
        bg: 'blue',
      },
    })

    // Reaction input box (hidden by default)
    const reactionInputBox = blessed.textbox({
      bottom: 0,
      left: '40%',
      width: '60%',
      height: 3,
      inputOnFocus: true,
      hidden: true,
      style: {
        fg: 'yellow',
        bg: 'blue',
      },
    })

    // Status box
    const statusBox = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: 'Discord Bot CLI - ↑↓ to navigate channels, → to select channel, Esc to exit',
      style: {
        bg: 'blue',
        fg: 'white',
      },
    })

    const updateMessagesDisplay = () => {
      if (recentMessages.length === 0) {
        messagesBox.setContent('No recent messages')
        screen.render()
        return
      }

      const visibleMessages = recentMessages.slice(
        Math.max(0, messageScrollIndex),
        Math.min(recentMessages.length, messageScrollIndex + 10)
      )

      const content = visibleMessages.map((msg, idx) => {
        const actualIdx = messageScrollIndex + idx
        const isSelected = actualIdx === selectedMessageIndex && currentMode === 'messages'
        const prefix = isSelected ? '▶ ' : '  '
        const lines = msg.content.split('\n')
        const attachmentIndicator = msg.hasAttachments 
          ? ` 📎(${msg.attachmentCount} file${msg.attachmentCount > 1 ? 's' : ''})` 
          : ''
        const messageLines = lines.map((line, i) => {
          if (i === 0) {
            return `${prefix}[${msg.timestamp}] ${msg.author}${attachmentIndicator}: ${line}`
          } else {
            // Continuation lines: align with the content after the author and indicator
            const firstLinePrefix = `[${msg.timestamp}] ${msg.author}${attachmentIndicator}: `
            return `${prefix}${' '.repeat(firstLinePrefix.length)}${line}`
          }
        }).join('\n')
        
        return messageLines
      }).join('\n\n')

      messagesBox.setContent(content)
      screen.render()
    }

    const updateChannelList = () => {
      channelListBox.setItems(channelList.map((ch) => 
        `${ch.guildName ? `${ch.guildName} / ` : ''}${ch.name}${ch.type === 'thread' ? ' (thread)' : ''}`
      ))
      if (selectedChannelIndex >= 0 && selectedChannelIndex < channelList.length) {
        channelListBox.select(selectedChannelIndex)
      }
      screen.render()
    }

    // Initial load
    await loadMessages(selectedChannel)
    updateMessagesDisplay()
    updateChannelList()

    // Track selected index when navigating the list
    channelListBox.on('select item', (item, index) => {
      selectedChannelIndex = index
    })

    // Channel selection function
    const selectChannel = async () => {
      // Use the tracked selectedChannelIndex
      const newChannel = channelList[selectedChannelIndex]
      
      // Always reload messages, even if it's the same channel (to get latest messages)
      selectedChannel = newChannel
      await loadMessages(selectedChannel)
      
      // Reset scroll to show latest messages (scroll to bottom)
      messageScrollIndex = Math.max(0, recentMessages.length - 5)
      selectedMessageIndex = recentMessages.length > 0 ? recentMessages.length - 1 : -1
      
      updateMessagesDisplay()
      currentMode = 'messages'
      messagesBox.focus()
      statusBox.setContent(`Channel: ${selectedChannel.guildName ? `${selectedChannel.guildName} / ` : ''}${selectedChannel.name} - ↑↓ to select message, Enter to act, d=delete, r=reply, e=react, f=download, i=send, c=change channel`)
      screen.render()
    }

    // Use right arrow to select channel
    channelListBox.key(['right', 'l'], async () => {
      await selectChannel()
    })

    // Enter also works for selecting (for convenience)
    channelListBox.key(['enter'], async () => {
      await selectChannel()
    })

    // Make sure channel list has focus initially
    channelListBox.focus()

    // Messages navigation - up/down scroll messages when in messages mode
    // Only bind to messagesBox, not screen, to avoid interfering with channel list navigation
    messagesBox.key(['up', 'k'], () => {
      if (currentMode === 'messages' && recentMessages.length > 0) {
        if (selectedMessageIndex === -1) {
          // Initialize selection to the last visible message
          selectedMessageIndex = Math.min(messageScrollIndex + 9, recentMessages.length - 1)
        } else if (selectedMessageIndex > 0) {
          selectedMessageIndex--
          // Adjust scroll to keep selected message visible
          if (selectedMessageIndex < messageScrollIndex) {
            messageScrollIndex = selectedMessageIndex
          }
        } else if (messageScrollIndex > 0) {
          messageScrollIndex--
        }
        updateMessagesDisplay()
      }
    })

    messagesBox.key(['down', 'j'], () => {
      if (currentMode === 'messages' && recentMessages.length > 0) {
        if (selectedMessageIndex === -1) {
          // Initialize selection to the first visible message
          selectedMessageIndex = messageScrollIndex
        } else if (selectedMessageIndex < recentMessages.length - 1) {
          selectedMessageIndex++
          // Adjust scroll to keep selected message visible
          if (selectedMessageIndex >= messageScrollIndex + 10) {
            messageScrollIndex = selectedMessageIndex - 9
          }
        } else if (messageScrollIndex < recentMessages.length - 1) {
          messageScrollIndex++
        }
        updateMessagesDisplay()
      }
    })

    // Global keys for mode switching
    screen.key(['c', 'C'], () => {
      if (currentMode !== 'input') {
        currentMode = 'channel-select'
        channelListBox.focus()
        statusBox.setContent('Discord Bot CLI - ↑↓ to navigate channels, → to select channel, Esc to exit')
        screen.render()
      }
    })

    // Delete selected message
    const deleteSelectedMessage = async () => {
      if (selectedMessageIndex < 0 || selectedMessageIndex >= recentMessages.length) {
        statusBox.setContent('❌ No message selected')
        screen.render()
        return
      }

      const messageInfo = recentMessages[selectedMessageIndex]
      const message = messageObjects.get(messageInfo.id)

      if (!message) {
        statusBox.setContent('❌ Message not found')
        screen.render()
        return
      }

      // Check if message is from the bot
      if (messageInfo.authorId !== client.user?.id) {
        statusBox.setContent('❌ Can only delete messages from the bot')
        screen.render()
        return
      }

      try {
        await message.delete()
        statusBox.setContent('✅ Message deleted')
        screen.render()
        await loadMessages(selectedChannel)
        updateMessagesDisplay()
        // Adjust selection after deletion
        if (selectedMessageIndex >= recentMessages.length) {
          selectedMessageIndex = recentMessages.length - 1
        }
        updateMessagesDisplay()
      } catch (err) {
        statusBox.setContent(`❌ Error deleting message: ${err instanceof Error ? err.message : 'Unknown error'}`)
        screen.render()
      }
    }

    // Reply to selected message
    const replyToSelectedMessage = () => {
      if (selectedMessageIndex < 0 || selectedMessageIndex >= recentMessages.length) {
        statusBox.setContent('❌ No message selected')
        screen.render()
        return
      }

      const messageInfo = recentMessages[selectedMessageIndex]
      const message = messageObjects.get(messageInfo.id)

      if (!message) {
        statusBox.setContent('❌ Message not found')
        screen.render()
        return
      }

      // Store the message to reply to
      replyingToMessage = message
      clearAttachments() // Clear any previous attachments
      currentMode = 'input'
      reactionInputBox.hide()
      inputBox.show()
      inputBox.focus()
      statusBox.setContent(`Replying to ${messageInfo.author} - Type message with /attach <path> anywhere, Enter to send, Esc to cancel`)
      screen.render()
    }

    // Add emoji reaction to selected message
    const reactToSelectedMessage = async () => {
      if (selectedMessageIndex < 0 || selectedMessageIndex >= recentMessages.length) {
        statusBox.setContent('❌ No message selected')
        screen.render()
        return
      }

      const messageInfo = recentMessages[selectedMessageIndex]
      const message = messageObjects.get(messageInfo.id)

      if (!message) {
        statusBox.setContent('❌ Message not found')
        screen.render()
        return
      }

      currentMode = 'react-input'
      reactionInputBox.show()
      reactionInputBox.focus()
      inputBox.hide()
      statusBox.setContent('Enter emoji: Unicode (🐙), :name: (e.g. :octopus:), or custom <:name:id>, Enter to add, Esc to cancel')
      screen.render()
    }

    // Download attachments from selected message
    const downloadAttachments = async () => {
      if (selectedMessageIndex < 0 || selectedMessageIndex >= recentMessages.length) {
        statusBox.setContent('❌ No message selected')
        screen.render()
        return
      }

      const messageInfo = recentMessages[selectedMessageIndex]
      const message = messageObjects.get(messageInfo.id)

      if (!message) {
        statusBox.setContent('❌ Message not found')
        screen.render()
        return
      }

      if (message.attachments.size === 0) {
        statusBox.setContent('❌ Message has no attachments')
        screen.render()
        return
      }

      try {
        // Get Downloads folder path
        const homeDir = os.homedir()
        const downloadsPath = path.join(homeDir, 'Downloads')
        
        // Ensure Downloads folder exists
        if (!fs.existsSync(downloadsPath)) {
          fs.mkdirSync(downloadsPath, { recursive: true })
        }

        statusBox.setContent(`📥 Downloading ${message.attachments.size} file(s)...`)
        screen.render()

        // Download all attachments
        const downloadPromises = Array.from(message.attachments.values()).map(async (attachment, index) => {
          const url = attachment.url
          const fileName = attachment.name || `attachment_${index + 1}`
          const filePath = path.join(downloadsPath, fileName)

          // Handle duplicate filenames
          let finalPath = filePath
          let counter = 1
          while (fs.existsSync(finalPath)) {
            const ext = path.extname(fileName)
            const nameWithoutExt = path.basename(fileName, ext)
            finalPath = path.join(downloadsPath, `${nameWithoutExt}_${counter}${ext}`)
            counter++
          }

          return new Promise<void>((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http
            const file = fs.createWriteStream(finalPath)

            protocol.get(url, (response) => {
              if (response.statusCode === 301 || response.statusCode === 302) {
                // Handle redirects
                protocol.get(response.headers.location!, (redirectResponse) => {
                  redirectResponse.pipe(file)
                  file.on('finish', () => {
                    file.close()
                    resolve()
                  })
                }).on('error', reject)
              } else {
                response.pipe(file)
                file.on('finish', () => {
                  file.close()
                  resolve()
                })
              }
            }).on('error', (err) => {
              fs.unlinkSync(finalPath) // Delete the file on error
              reject(err)
            })
          })
        })

        await Promise.all(downloadPromises)
        statusBox.setContent(`✅ Downloaded ${message.attachments.size} file(s) to Downloads folder`)
        screen.render()
      } catch (err) {
        statusBox.setContent(`❌ Error downloading files: ${err instanceof Error ? err.message : 'Unknown error'}`)
        screen.render()
      }
    }

    // Process /attach command when Tab is pressed (optional preview)
    inputBox.key(['tab'], () => {
      if (currentMode === 'input') {
        const currentValue = inputBox.getValue().trim()
        // Extract /attach commands and preview attachments
        const attachRegex = /\/attach\s+([^\s]+(?:\s+[^\s]+)*)/g
        let match
        const foundFiles: string[] = []
        while ((match = attachRegex.exec(currentValue)) !== null) {
          const filePaths = match[1].trim().split(/\s+/).filter(p => p.trim())
          foundFiles.push(...filePaths)
        }
        if (foundFiles.length > 0) {
          statusBox.setContent(`Found ${foundFiles.length} file(s) in /attach commands. Press Enter to send with message.`)
          screen.render()
        } else {
          statusBox.setContent('Type message with /attach <path> anywhere, then press Enter to send')
          screen.render()
        }
      }
    })

    // Input handling
    inputBox.key(['enter'], async () => {
      const fullInput = inputBox.getValue()
      const trimmed = fullInput.trim()
      
      if (!trimmed && attachedFiles.length === 0) {
        return // Don't send empty messages
      }

      // Parse message for /attach command - can appear anywhere in the message
      let messageText = ''
      const filesToAttach: string[] = []
      
      // Find all /attach occurrences in the message
      const attachRegex = /\/attach\s+([^\s]+(?:\s+[^\s]+)*)/g
      let match
      let lastIndex = 0
      const parts: Array<{ type: 'text' | 'attach'; content: string }> = []
      
      while ((match = attachRegex.exec(trimmed)) !== null) {
        // Add text before this /attach
        if (match.index > lastIndex) {
          const textBefore = trimmed.substring(lastIndex, match.index).trim()
          if (textBefore) {
            parts.push({ type: 'text', content: textBefore })
          }
        }
        
        // Add the file paths after /attach
        const filePaths = match[1].trim()
        if (filePaths) {
          parts.push({ type: 'attach', content: filePaths })
        }
        
        lastIndex = match.index + match[0].length
      }
      
      // Add remaining text after last /attach
      if (lastIndex < trimmed.length) {
        const textAfter = trimmed.substring(lastIndex).trim()
        if (textAfter) {
          parts.push({ type: 'text', content: textAfter })
        }
      }
      
      // If no /attach found, treat entire input as message text
      if (parts.length === 0) {
        messageText = trimmed
      } else {
        // Reconstruct message text and collect file paths
        const textParts: string[] = []
        parts.forEach(part => {
          if (part.type === 'text') {
            textParts.push(part.content)
          } else {
            // Extract file paths from attach part
            const paths = part.content.split(/\s+/).filter(p => p.trim())
            filesToAttach.push(...paths)
          }
        })
        messageText = textParts.join(' ').trim()
      }

      // Attach files found in /attach commands
      const newlyAttachedFiles: string[] = []
      filesToAttach.forEach(filePath => {
        if (attachFile(filePath)) {
          newlyAttachedFiles.push(filePath)
        }
      })

      // Send message if there's content or attachments (from previous session or newly attached)
      if (messageText || attachedFiles.length > 0 || newlyAttachedFiles.length > 0) {
        try {
          // Prepare attachments - Discord.js format
          const attachmentOptions = attachedFiles.map(file => ({
            attachment: file.path,
            name: file.name,
          }))

          if (replyingToMessage) {
            // Send as reply with attachments
            const options: any = {}
            if (messageText) {
              options.content = messageText
            }
            if (attachmentOptions.length > 0) {
              options.files = attachmentOptions
            }
            await replyingToMessage.reply(options)
            replyingToMessage = null
            inputBox.clearValue()
            inputBox.setValue('')
            clearAttachments()
            currentMode = 'messages'
            messagesBox.focus()
            await loadMessages(selectedChannel)
            updateMessagesDisplay()
            statusBox.setContent('✅ Reply sent! - ↑↓ to select message, Enter to act, d=delete, r=reply, e=react, f=download, i=send, c=change channel')
            screen.render()
          } else {
            // Send as regular message with attachments
            const channel = await client.channels.fetch(selectedChannel.id)
            if (channel && channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
              const options: any = {}
              if (messageText) {
                options.content = messageText
              }
              if (attachmentOptions.length > 0) {
                options.files = attachmentOptions
              }
              await channel.send(options)
              inputBox.clearValue()
              inputBox.setValue('')
              clearAttachments()
              currentMode = 'messages'
              messagesBox.focus()
              await loadMessages(selectedChannel)
              updateMessagesDisplay()
              statusBox.setContent('✅ Message sent! - ↑↓ to select message, Enter to act, d=delete, r=reply, e=react, f=download, i=send, c=change channel')
              screen.render()
            }
          }
        } catch (err) {
          statusBox.setContent(`❌ Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
          screen.render()
        }
      } else if (newlyAttachedFiles.length === 0 && filesToAttach.length > 0) {
        // Files were specified but none were valid
        statusBox.setContent(`❌ No valid files found. Check file paths and try again`)
        screen.render()
      }
    })


    // Helper function to update attachments display
    const updateAttachmentsDisplay = () => {
      if (attachedFiles.length === 0) {
        attachmentsBox.hide()
        attachmentsBox.setContent('')
      } else {
        attachmentsBox.show()
        const fileList = attachedFiles.map((file, idx) => 
          `  📎 ${idx + 1}. ${file.name}`
        ).join('\n')
        attachmentsBox.setContent(`Attached files:\n${fileList}`)
      }
      screen.render()
    }

    // Helper function to attach a file
    const attachFile = (filePath: string): boolean => {
      try {
        const resolvedPath = path.resolve(filePath)
        if (!fs.existsSync(resolvedPath)) {
          return false
        }

        const stats = fs.statSync(resolvedPath)
        if (!stats.isFile()) {
          return false
        }

        const fileName = path.basename(resolvedPath)
        attachedFiles.push({ path: resolvedPath, name: fileName })
        updateAttachmentsDisplay()
        return true
      } catch (err) {
        return false
      }
    }

    // Helper function to remove last attachment
    const removeLastAttachment = () => {
      if (attachedFiles.length > 0) {
        attachedFiles.pop()
        updateAttachmentsDisplay()
      }
    }

    // Helper function to clear all attachments
    const clearAttachments = () => {
      attachedFiles = []
      updateAttachmentsDisplay()
    }

    // Helper function to resolve emoji from input
    const resolveEmoji = async (input: string, channel: TextChannel | ThreadChannel): Promise<string | null> => {
      const trimmed = input.trim()
      
      // If it's already a Unicode emoji or custom emoji format, use it directly
      if (trimmed.match(/^<a?:\w+:\d+>$/)) {
        // Custom emoji format: <:name:id> or <a:name:id>
        return trimmed
      }
      
      // Check if it's a Unicode emoji (contains emoji characters)
      const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F1E0}-\u{1F1FF}]/u
      if (emojiRegex.test(trimmed)) {
        return trimmed
      }
      
      // If it's in :name: format, try to find it in the guild's custom emojis
      const nameMatch = trimmed.match(/^:(\w+):$/)
      if (nameMatch) {
        const emojiName = nameMatch[1]
        
        // Try to find in guild emojis
        if (channel.guild) {
          const customEmoji = channel.guild.emojis.cache.find(emoji => emoji.name === emojiName)
          if (customEmoji) {
            return customEmoji.toString() // Returns <:name:id> format
          }
        }
        
        // Try common Unicode emoji mappings
        const commonEmojis: Record<string, string> = {
          'octopus': '🐙',
          'thumbsup': '👍',
          'thumbsdown': '👎',
          'heart': '❤️',
          'fire': '🔥',
          'smile': '😄',
          'laughing': '😂',
          'wink': '😉',
          'thinking': '🤔',
          'eyes': '👀',
          'wave': '👋',
          'clap': '👏',
          'ok_hand': '👌',
          'pray': '🙏',
          'muscle': '💪',
          'party': '🎉',
          'tada': '🎉',
          'confetti_ball': '🎊',
          'balloon': '🎈',
          'cake': '🎂',
          'gift': '🎁',
          'star': '⭐',
          'sparkles': '✨',
          'check': '✅',
          'cross': '❌',
          'warning': '⚠️',
          'exclamation': '❗',
          'question': '❓',
        }
        
        if (commonEmojis[emojiName.toLowerCase()]) {
          return commonEmojis[emojiName.toLowerCase()]
        }
        
        // If not found, return null to show error
        return null
      }
      
      // If it doesn't match any format, try using it directly (might be a partial custom emoji)
      return trimmed
    }

    // Reaction input handling
    reactionInputBox.key(['enter'], async () => {
      const emojiInput = reactionInputBox.getValue().trim()
      if (emojiInput) {
        if (selectedMessageIndex >= 0 && selectedMessageIndex < recentMessages.length) {
          const messageInfo = recentMessages[selectedMessageIndex]
          const message = messageObjects.get(messageInfo.id)

          if (message) {
            try {
              // Resolve the emoji
              const channel = await client.channels.fetch(selectedChannel.id)
              if (!channel || !channel.isTextBased() || !(channel instanceof TextChannel || channel instanceof ThreadChannel)) {
                statusBox.setContent('❌ Channel not found')
                screen.render()
                return
              }

              const resolvedEmoji = await resolveEmoji(emojiInput, channel)
              
              if (!resolvedEmoji) {
                statusBox.setContent(`❌ Unknown emoji: ${emojiInput}. Use Unicode emoji (🐙) or custom emoji format (<:name:id>)`)
                screen.render()
                return
              }

              await message.react(resolvedEmoji)
              reactionInputBox.clearValue()
              reactionInputBox.setValue('')
              reactionInputBox.hide()
              inputBox.show()
              currentMode = 'messages'
              messagesBox.focus()
              statusBox.setContent('✅ Reaction added!')
              screen.render()
              // Reload to show reactions
              await loadMessages(selectedChannel)
              updateMessagesDisplay()
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : 'Unknown error'
              if (errorMessage.includes('Unknown Emoji') || errorMessage.includes('Reaction blocked')) {
                statusBox.setContent(`❌ Unknown emoji: ${emojiInput}. Use Unicode emoji (🐙) or custom emoji format (<:name:id>)`)
              } else {
                statusBox.setContent(`❌ Error adding reaction: ${errorMessage}`)
              }
              screen.render()
            }
          }
        }
      }
    })

    reactionInputBox.key(['escape'], () => {
      reactionInputBox.hide()
      reactionInputBox.clearValue()
      reactionInputBox.setValue('')
      inputBox.show()
      currentMode = 'messages'
      messagesBox.focus()
      statusBox.setContent(`Channel: ${selectedChannel.guildName ? `${selectedChannel.guildName} / ` : ''}${selectedChannel.name} - ↑↓ to select message, Enter to act, d=delete, r=reply, e=react, f=download, i=send, c=change channel`)
      screen.render()
    })

    screen.key(['i', 'I'], () => {
      if (currentMode === 'messages' || currentMode === 'channel-select') {
        replyingToMessage = null // Clear any reply state
        clearAttachments() // Clear any previous attachments
        currentMode = 'input'
        reactionInputBox.hide()
        inputBox.show()
        inputBox.focus()
        statusBox.setContent('Type message with /attach <path> anywhere (e.g., "Here is the file /attach file.txt"), Enter to send, Esc to cancel')
        screen.render()
      }
    })

    // Message action keys
    screen.key(['d', 'D'], async () => {
      if (currentMode === 'messages') {
        await deleteSelectedMessage()
      }
    })

    screen.key(['r', 'R'], async () => {
      if (currentMode === 'messages') {
        await replyToSelectedMessage()
      }
    })

    screen.key(['e', 'E'], async () => {
      if (currentMode === 'messages') {
        await reactToSelectedMessage()
      }
    })

    screen.key(['f', 'F'], async () => {
      if (currentMode === 'messages') {
        await downloadAttachments()
      }
    })

    // Enter key to show actions menu or perform default action
    messagesBox.key(['enter'], () => {
      if (currentMode === 'messages' && selectedMessageIndex >= 0) {
        // Show quick action hint
        const messageInfo = recentMessages[selectedMessageIndex]
        const canDelete = messageInfo.authorId === client.user?.id
        const actions = []
        if (canDelete) actions.push('d=delete')
        actions.push('r=reply', 'e=react')
        if (messageInfo.hasAttachments) actions.push('f=download')
        statusBox.setContent(`Selected: ${messageInfo.author} - ${actions.join(', ')}`)
        screen.render()
      }
    })

    inputBox.key(['escape'], () => {
      currentMode = 'messages'
      reactionInputBox.hide()
      inputBox.show()
      messagesBox.focus()
      inputBox.clearValue()
      inputBox.setValue('')
      replyingToMessage = null // Clear reply state
      clearAttachments() // Clear attachments when canceling
      statusBox.setContent(`Channel: ${selectedChannel.guildName ? `${selectedChannel.guildName} / ` : ''}${selectedChannel.name} - ↑↓ to select message, Enter to act, d=delete, r=reply, e=react, f=download, i=send, c=change channel`)
      screen.render()
    })

    // Exit
    screen.key(['escape', 'q', 'Q', 'C-c'], () => {
      screen.destroy()
      void client.destroy()
      process.exit(0)
    })

    // Layout
    screen.append(statusBox)
    screen.append(channelListBox)
    screen.append(messagesBox)
    screen.append(attachmentsBox)
    screen.append(inputBox)
    screen.append(reactionInputBox)

    screen.render()
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
}

if (require.main === module) {
  void main()
}
