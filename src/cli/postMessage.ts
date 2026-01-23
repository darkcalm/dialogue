/**
 * CLI tool to post messages as the bot
 * Uses Blessed for interactive terminal UI with navigation
 */

import 'module-alias/register'
import 'source-map-support/register'

import { Client, GatewayIntentBits, TextChannel, ThreadChannel } from 'discord.js'
import * as blessed from 'blessed'
import config from '@/helpers/env'

interface ChannelInfo {
  id: string
  name: string
  type: string
  guildName?: string
}

interface MessageInfo {
  author: string
  content: string
  timestamp: string
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
    let messageScrollIndex = 0
    let currentMode: 'channel-select' | 'messages' | 'input' = 'channel-select'

    // Helper to load messages
    const loadMessages = async (channelInfo: ChannelInfo) => {
      try {
        const channel = await client.channels.fetch(channelInfo.id)
        if (channel && channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
          const messages = await channel.messages.fetch({ limit: 20 })
          recentMessages = Array.from(messages.values())
            .slice(0, 15) // Show last 15 messages (including bot messages)
            .reverse()
            .map(msg => {
              const authorName = msg.author.displayName || msg.author.username
              const botTag = msg.author.bot ? ' [BOT]' : ''
              return {
                author: `${authorName}${botTag}`,
                content: msg.content || '(no text content)',
                timestamp: new Date(msg.createdTimestamp).toLocaleTimeString(),
              }
            })
          // Start at the bottom (most recent messages) - show last 5 messages initially
          messageScrollIndex = Math.max(0, recentMessages.length - 5)
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
        const isSelected = actualIdx === messageScrollIndex && currentMode === 'messages'
        const prefix = isSelected ? '> ' : '  '
        const lines = msg.content.split('\n')
        const messageLines = lines.map((line, i) => 
          `${prefix}${i === 0 ? `[${msg.timestamp}] ${msg.author}: ` : ' '.repeat(msg.timestamp.length + msg.author.length + 5)}${line}`
        ).join('\n')
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
      
      updateMessagesDisplay()
      currentMode = 'messages'
      messagesBox.focus()
      statusBox.setContent(`Channel: ${selectedChannel.guildName ? `${selectedChannel.guildName} / ` : ''}${selectedChannel.name} - ↑↓ to scroll messages, i to send, c to change channel`)
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
    messagesBox.key(['up', 'k'], () => {
      if (currentMode === 'messages' && messageScrollIndex > 0) {
        messageScrollIndex--
        updateMessagesDisplay()
      }
    })

    messagesBox.key(['down', 'j'], () => {
      if (currentMode === 'messages' && messageScrollIndex < recentMessages.length - 1) {
        messageScrollIndex++
        updateMessagesDisplay()
      }
    })

    // Also bind to screen for when messages box has focus
    screen.key(['up', 'k'], () => {
      if (currentMode === 'messages' && messageScrollIndex > 0) {
        messageScrollIndex--
        updateMessagesDisplay()
      }
    })

    screen.key(['down', 'j'], () => {
      if (currentMode === 'messages' && messageScrollIndex < recentMessages.length - 1) {
        messageScrollIndex++
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

    // Input handling
    inputBox.key(['enter'], async () => {
      const message = inputBox.getValue()
      if (message.trim()) {
        try {
          const channel = await client.channels.fetch(selectedChannel.id)
          if (channel && channel.isTextBased() && (channel instanceof TextChannel || channel instanceof ThreadChannel)) {
            await channel.send(message)
            inputBox.clearValue()
            inputBox.setValue('')
            currentMode = 'messages'
            messagesBox.focus()
            await loadMessages(selectedChannel)
            updateMessagesDisplay()
            statusBox.setContent('✅ Message sent! - ↑↓ to scroll messages, i to send another, c to change channel')
            screen.render()
          }
        } catch (err) {
          statusBox.setContent(`❌ Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
          screen.render()
        }
      }
    })

    screen.key(['i', 'I'], () => {
      if (currentMode === 'messages' || currentMode === 'channel-select') {
        currentMode = 'input'
        inputBox.focus()
        statusBox.setContent('Type your message and press Enter to send, Esc to cancel')
        screen.render()
      }
    })

    inputBox.key(['escape'], () => {
      currentMode = 'messages'
      messagesBox.focus()
      inputBox.clearValue()
      inputBox.setValue('')
      statusBox.setContent(`Channel: ${selectedChannel.guildName ? `${selectedChannel.guildName} / ` : ''}${selectedChannel.name} - ↑↓ to scroll messages, 'i' to send, 'c' to change channel`)
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
    screen.append(inputBox)

    screen.render()
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
}

if (require.main === module) {
  void main()
}
