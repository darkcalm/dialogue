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
  reactions: Array<{ emoji: string; count: number; name: string }> // Emoji reactions on the message
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
    let currentMode: 'channel-select' | 'messages' | 'input' | 'react-input' | 'llm-review' = 'channel-select'
    let replyingToMessage: Message | null = null // Message we're replying to
    let attachedFiles: Array<{ path: string; name: string }> = [] // Files attached to current message
    let llmOriginalText = '' // Natural-language text before LLM rewrite (when requested)
    let llmProcessedText = '' // Text returned from LLM rewrite (when requested)

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
              
              // Fetch reactions
              const reactions: Array<{ emoji: string; count: number; name: string }> = []
              if (msg.reactions.cache.size > 0) {
                msg.reactions.cache.forEach(reaction => {
                  // Get emoji display - show name for better terminal compatibility
                  let emojiDisplay: string
                  let emojiName: string
                  
                  if (reaction.emoji.id) {
                    // Custom emoji - show as :name: (terminal can't display custom emojis)
                    emojiName = reaction.emoji.name || 'unknown'
                    emojiDisplay = `:${emojiName}:`
                  } else {
                    // Unicode emoji - show emoji character
                    // If terminal doesn't support it, it will show as "?" but that's a terminal limitation
                    emojiName = reaction.emoji.name || reaction.emoji.toString()
                    emojiDisplay = reaction.emoji.toString()
                  }
                  reactions.push({
                    emoji: emojiDisplay,
                    count: reaction.count,
                    name: emojiName,
                  })
                })
              }
              
              return {
                id: msg.id,
                author: `${authorName}${botTag}`,
                authorId: msg.author.id,
                content: msg.content || '(no text content)',
                timestamp: new Date(msg.createdTimestamp).toLocaleTimeString(),
                isBot: msg.author.bot,
                hasAttachments,
                attachmentCount,
                reactions,
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
      height: '76%',
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

    // LLM preview box (shows processed vs original text before sending)
    const llmPreviewBox = blessed.box({
      top: '77%',
      left: '40%',
      width: '60%',
      height: 4, // Will be dynamically adjusted
      content: '',
      hidden: true,
      scrollable: true,
      alwaysScroll: true,
      style: {
        fg: 'magenta',
        bg: 'blue',
      },
    })

    // Attachments display box
    const attachmentsBox = blessed.box({
      top: '85%',
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
        
        // Add reactions display if any
        let reactionsDisplay = ''
        if (msg.reactions && msg.reactions.length > 0) {
          const firstLinePrefix = `[${msg.timestamp}] ${msg.author}${attachmentIndicator}: `
          const reactionsText = msg.reactions
            .map(r => `${r.emoji} ${r.count}`)
            .join('  ')
          reactionsDisplay = `\n${prefix}${' '.repeat(firstLinePrefix.length)}${reactionsText}`
        }
        
        return messageLines + reactionsDisplay
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

    // Initial load - just show channel list, don't load messages until user selects a channel
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
      statusBox.setContent(`Channel: ${selectedChannel.guildName ? `${selectedChannel.guildName} / ` : ''}${selectedChannel.name} - ↑↓ to select message, Enter to act, d=delete, r=reply, e=react, f=download, i=send, ←=change channel`)
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
    screen.key(['left'], () => {
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

    // Helper: rewrite message text using OpenRouter LLM.
    // IMPORTANT: This function should only receive the pure natural-language portion of the message.
    const rewriteMessageWithLLM = async (text: string): Promise<string> => {
      // Feature is optional – only run if configured
      if (!config.OPENROUTER_API_KEY || !config.OPENROUTER_MODEL) {
        return text
      }

      return await new Promise<string>((resolve) => {
        try {
          const data = JSON.stringify({
            model: config.OPENROUTER_MODEL,
            messages: [
              {
                role: 'system',
                content:
                  'You are a message enhancement pipeline. Your task is to rewrite Discord messages to be clearer, friendlier, and more concise. ' +
                  'CRITICAL: Return ONLY the rewritten message text. Do NOT include any prefixes, explanations, or meta-commentary like "Here\'s a clearer version:" or "Here\'s the rewritten message:". ' +
                  'Just output the enhanced message text directly. ' +
                  'Preserve the intent and meaning while improving wording and tone. ' +
                  'This is a pipeline transformation, not a conversation - output only the processed text.',
              },
              {
                role: 'user',
                content: text,
              },
            ],
          })

          const options: https.RequestOptions = {
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
              'Content-Length': Buffer.byteLength(data),
              // Optional but recommended headers for OpenRouter
              'X-Title': 'dialogue-discord-cli',
            },
          }

          const req = https.request(options, (res) => {
            let body = ''
            res.on('data', (chunk) => {
              body += chunk
            })
            res.on('end', () => {
              try {
                const parsed = JSON.parse(body)
                const rewritten =
                  parsed?.choices?.[0]?.message?.content &&
                  typeof parsed.choices[0].message.content === 'string'
                    ? parsed.choices[0].message.content
                    : text
                resolve(rewritten)
              } catch {
                // On any parsing error, fall back to original text
                resolve(text)
              }
            })
          })

          req.on('error', () => {
            // Network or API error – fall back silently
            resolve(text)
          })

          req.write(data)
          req.end()
        } catch {
          // Any unexpected error – just fall back to original
          resolve(text)
        }
      })
    }

    // Helper: send the current message (used both from normal flow and LLM review)
    const sendCurrentMessage = async (finalMessageText: string) => {
      // Use file paths directly - Discord.js accepts an array of file paths
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

            inputBox.clearValue()
            inputBox.setValue('')
        clearAttachments()
        llmOriginalText = ''
        llmProcessedText = ''
        llmPreviewBox.hide()
            currentMode = 'messages'
            messagesBox.focus()
            await loadMessages(selectedChannel)
            updateMessagesDisplay()
        statusBox.setContent('✅ Message sent! - ↑↓ to select message, Enter to act, d=delete, r=reply, e=react, f=download, i=send, c=change channel')
            screen.render()
        } catch (err) {
          statusBox.setContent(`❌ Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
          screen.render()
        }
      }

    // Input handling
    inputBox.key(['enter'], async () => {
      const rawInput = inputBox.getValue()
      if (!rawInput.trim() && attachedFiles.length === 0) {
        return
      }

      // Detect LLM routing markers (prefix or suffix) and strip them from the working text
      let llmRequested = false
      let fullInput = rawInput
      if (fullInput.startsWith('llm://')) {
        llmRequested = true
        fullInput = fullInput.substring('llm://'.length)
      } else if (fullInput.endsWith('\\\\:llm')) {
        // Support \\:llm (two backslashes, colon, llm)
        llmRequested = true
        fullInput = fullInput.substring(0, fullInput.length - '\\\\:llm'.length)
      }

      const trimmed = fullInput.trim()
      if (!trimmed && attachedFiles.length === 0) {
        return
      }

      // Parse message for /attach command - simple approach: /attach "path" or /attach path
      // Extract text and file paths
      let messageText = ''
      const filesToAttach: string[] = []

      // Simple regex: /attach followed by quoted string or unquoted path
      const attachRegex = /\/attach\s+(?:"([^"]+)"|(\S+))/g
      let match
      let lastIndex = 0
      const textParts: string[] = []

      while ((match = attachRegex.exec(trimmed)) !== null) {
        // Add text before this match
        if (match.index > lastIndex) {
          const textBefore = trimmed.substring(lastIndex, match.index).trim()
          if (textBefore) textParts.push(textBefore)
        }

        // Extract file path (quoted or unquoted)
        const filePath = (match[1] || match[2] || '').trim()
        if (filePath) {
          filesToAttach.push(filePath)
        }

        lastIndex = match.index + match[0].length
      }

      // Add remaining text after last match
      if (lastIndex < trimmed.length) {
        const textAfter = trimmed.substring(lastIndex).trim()
        if (textAfter) textParts.push(textAfter)
      }

      messageText = textParts.join(' ').trim()

      // Attach files and track success
      // Unescape paths that come from terminal drag-and-drop (which escapes spaces as "\ ")
      let anyAttached = false
      filesToAttach.forEach(filePath => {
        // Remove backslash escaping from spaces (terminal drag-and-drop format: "file\ name.png" -> "file name.png")
        // Only replace backslash-space, not all backslashes
        const unescapedPath = filePath.replace(/\\ /g, ' ')
        if (attachFile(unescapedPath)) {
          anyAttached = true
        }
      })
      
      // Update display after all files are processed
      updateAttachmentsDisplay()
      
      // Show error if files were specified but none were attached
      if (filesToAttach.length > 0 && !anyAttached) {
        statusBox.setContent('❌ No valid files found. Check file paths and try again')
        screen.render()
      }

      // If no LLM requested, just send immediately
      if (!llmRequested) {
        if (messageText || attachedFiles.length > 0) {
          await sendCurrentMessage(messageText)
        } else if (filesToAttach.length > 0 && attachedFiles.length === 0) {
          statusBox.setContent('❌ No valid files found. Check file paths and try again')
          screen.render()
        }
        return
      }

      // LLM requested: rewrite messageText (natural language only), then show preview
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

      // Format preview with proper line breaks for multi-line text
      const previewLines: string[] = []
      // Put controls on the same line as header so they're always visible
      previewLines.push('LLM rewrite preview: [p=send processed] [o=send original] [e=edit processed] [O=edit original] [Esc=cancel]')
      previewLines.push('  Processed:')
      
      // Split processed text by newlines and indent each line
      const processedLines = (llmProcessedText || '(empty)').split('\n')
      processedLines.forEach(line => {
        previewLines.push(`    ${line}`)
      })
      
      previewLines.push('  Original :')
      
      // Split original text by newlines and indent each line
      const originalLines = (llmOriginalText || '(empty)').split('\n')
      originalLines.forEach(line => {
        previewLines.push(`    ${line}`)
      })
      
      // Calculate dynamic height based on actual content:
      // header with controls (1) + processed label (1) + processed lines + original label (1) + original lines
      const totalLines = previewLines.length
      // Ensure minimum height of 5 (to always show header + controls + at least some content), max at 20 lines
      const calculatedHeight = Math.min(Math.max(5, totalLines), 20)
      
      llmPreviewBox.height = calculatedHeight
      llmPreviewBox.setContent(previewLines.join('\n'))
      llmPreviewBox.scrollTo(0) // Always start at top so controls are visible
      
      // Hide input box and ensure screen has focus for key bindings
      inputBox.hide()
      reactionInputBox.hide()
      llmPreviewBox.show()
      
      // Show attachments box if there are attachments
      if (attachedFiles.length > 0) {
        updateAttachmentsDisplay()
        attachmentsBox.show()
        // Position attachments box below LLM preview (which is at 77%)
        // Use a fixed position that won't overlap
        attachmentsBox.top = '90%'
        attachmentsBox.height = Math.min(attachedFiles.length + 2, 6)
        // Adjust LLM preview height if needed to prevent overlap
        const attachmentsHeight = attachmentsBox.height
        if (calculatedHeight + attachmentsHeight > 18) {
          llmPreviewBox.height = Math.max(5, 18 - attachmentsHeight)
        }
      } else {
        attachmentsBox.hide()
      }
      
      currentMode = 'llm-review'
      // Remove focus from input box so screen-level keys work
      messagesBox.focus()
      screen.render()
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
        // Dynamically adjust height based on number of files
        attachmentsBox.height = Math.min(attachedFiles.length + 2, 8)
      }
      screen.render()
    }

    // Helper function to attach a file
    const attachFile = (filePath: string): boolean => {
      try {
        let finalPath = filePath.trim()
        
        // Expand ~ to home directory
        if (finalPath.startsWith('~')) {
          finalPath = finalPath.replace('~', os.homedir())
        }
        
        // Resolve relative paths, normalize absolute paths
        finalPath = path.isAbsolute(finalPath) 
          ? path.normalize(finalPath)
          : path.resolve(finalPath)
        
        // Check if file exists
        if (!fs.existsSync(finalPath)) {
          return false
        }

        const stats = fs.statSync(finalPath)
        if (!stats.isFile()) {
          return false
        }

        const fileName = path.basename(finalPath)
        attachedFiles.push({ path: finalPath, name: fileName })
        updateAttachmentsDisplay()
        return true
      } catch {
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
      statusBox.setContent(`Channel: ${selectedChannel.guildName ? `${selectedChannel.guildName} / ` : ''}${selectedChannel.name} - ↑↓ to select message, Enter to act, d=delete, r=reply, e=react, f=download, i=send, ←=change channel`)
      screen.render()
    })

    screen.key(['i', 'I'], () => {
      if (currentMode === 'messages' || currentMode === 'channel-select') {
        replyingToMessage = null // Clear any reply state
        clearAttachments() // Clear any previous attachments
        llmOriginalText = ''
        llmProcessedText = ''
        llmPreviewBox.hide()
        currentMode = 'input'
        reactionInputBox.hide()
        inputBox.show()
        inputBox.focus()
        statusBox.setContent('Type message (optionally with /attach <path> and llm:// or :\\\\llm), Enter to send, Esc to cancel')
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
      if (currentMode === 'llm-review') {
        // Edit processed text (prioritize llm-review mode)
        inputBox.show()
        reactionInputBox.hide()
        currentMode = 'input'
        inputBox.setValue(llmProcessedText)
        inputBox.focus()
        llmPreviewBox.hide()
        statusBox.setContent('Editing processed message. Modify text and press Enter to send, Esc to cancel')
        screen.render()
      } else if (currentMode === 'messages') {
        await reactToSelectedMessage()
      }
    })

    screen.key(['f', 'F'], async () => {
      if (currentMode === 'messages') {
        await downloadAttachments()
      }
    })

    // LLM review actions - these must be checked before other handlers
    screen.key(['p', 'P'], async () => {
      if (currentMode === 'llm-review') {
        await sendCurrentMessage(llmProcessedText)
      }
    })

    screen.key(['o'], async () => {
      if (currentMode === 'llm-review') {
        await sendCurrentMessage(llmOriginalText)
      }
    })

    screen.key(['O'], () => {
      if (currentMode === 'llm-review') {
        // Edit original text
        inputBox.show()
        reactionInputBox.hide()
        currentMode = 'input'
        inputBox.setValue(llmOriginalText)
        inputBox.focus()
        llmPreviewBox.hide()
        statusBox.setContent('Editing original message. Modify text and press Enter to send, Esc to cancel')
        screen.render()
      }
    })

    // Esc handler - mode-specific behavior
    screen.key(['escape'], () => {
      if (currentMode === 'llm-review') {
        // Cancel LLM review and go back to input mode
        llmPreviewBox.hide()
        inputBox.show()
        reactionInputBox.hide()
        currentMode = 'input'
        inputBox.focus()
        statusBox.setContent('Type message (optionally with /attach <path> and llm:// or :\\\\llm), Enter to send, Esc to cancel')
        screen.render()
      } else if (currentMode === 'channel-select') {
        // Exit application only when in channel-select mode (most rooted state)
        screen.destroy()
        void client.destroy()
        process.exit(0)
      }
      // Other modes (messages, input, react-input) have their own Esc handlers
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
      llmOriginalText = ''
      llmProcessedText = ''
      llmPreviewBox.hide()
      statusBox.setContent(`Channel: ${selectedChannel.guildName ? `${selectedChannel.guildName} / ` : ''}${selectedChannel.name} - ↑↓ to select message, Enter to act, d=delete, r=reply, e=react, f=download, i=send, ←=change channel`)
      screen.render()
    })

    // Exit with Ctrl+C from any mode
    screen.key(['C-c'], () => {
      screen.destroy()
      void client.destroy()
      process.exit(0)
    })

    // Layout
    screen.append(statusBox)
    screen.append(channelListBox)
    screen.append(messagesBox)
    screen.append(llmPreviewBox)
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
