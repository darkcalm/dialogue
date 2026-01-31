/**
 * WhatsApp authentication and connection management using Baileys
 */

import makeWASocket, {
  WASocket,
  useMultiFileAuthState,
  DisconnectReason,
  ConnectionState,
  Browsers,
  Chat,
  proto,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import config from '@/helpers/env'

// Simple in-memory store for chats and messages
class SimpleStore {
  chats: Map<string, Chat> = new Map()
  messages: Map<string, proto.IWebMessageInfo[]> = new Map()

  bind(ev: any) {
    console.log('📦 Starting to bind store to events...')
    console.log('📦 Event emitter type:', typeof ev, ev.constructor?.name)

    // Listen for chats - multiple events to catch all scenarios
    try {
      ev.on('chats.set', ({ chats }: { chats: Chat[] }) => {
        console.log(`📦 Store: chats.set - Received ${chats.length} chats`)
        chats.forEach(chat => this.chats.set(chat.id, chat))
      })
      console.log('✅ Bound: chats.set')
    } catch (err) {
      console.error('❌ Failed to bind chats.set:', err)
    }

    try {
      ev.on('chats.update', (updates: Partial<Chat>[]) => {
        console.log(`📦 Store: chats.update - ${updates.length} updates`)
        updates.forEach(update => {
          if (update.id) {
            const existing = this.chats.get(update.id)
            if (existing) {
              this.chats.set(update.id, { ...existing, ...update } as Chat)
            } else {
              // Create new chat from update if it doesn't exist
              this.chats.set(update.id, update as Chat)
            }
          }
        })
      })
      console.log('✅ Bound: chats.update')
    } catch (err) {
      console.error('❌ Failed to bind chats.update:', err)
    }

    try {
      ev.on('chats.upsert', (chats: Chat[]) => {
        console.log(`📦 Store: chats.upsert - Received ${chats.length} chats`)
        chats.forEach(chat => this.chats.set(chat.id, chat))
      })
      console.log('✅ Bound: chats.upsert')
    } catch (err) {
      console.error('❌ Failed to bind chats.upsert:', err)
    }

    // Also listen for messaging-history which might contain chats
    try {
      ev.on('messaging-history.set', (data: any) => {
        console.log(`📦 Store: messaging-history.set - Received data`)
        if (data.chats && Array.isArray(data.chats)) {
          console.log(`📦 Store: Found ${data.chats.length} chats in messaging history`)
          data.chats.forEach((chat: Chat) => this.chats.set(chat.id, chat))
        }
        if (data.messages && Array.isArray(data.messages)) {
          console.log(`📦 Store: Found ${data.messages.length} messages in messaging history`)
          data.messages.forEach((msg: proto.IWebMessageInfo) => {
            const chatId = msg.key.remoteJid
            if (chatId) {
              if (!this.messages.has(chatId)) {
                this.messages.set(chatId, [])
              }
              this.messages.get(chatId)!.push(msg)
            }
          })
        }
      })
      console.log('✅ Bound: messaging-history.set')
    } catch (err) {
      console.error('❌ Failed to bind messaging-history.set:', err)
    }

    // Listen for ALL events to see what's actually firing
    const originalEmit = ev.emit
    let eventCount = 0
    ev.emit = function(event: string, ...args: any[]) {
      eventCount++
      if (eventCount <= 50) { // Only log first 50 events to avoid spam
        console.log(`🔔 Event fired: ${event}`)
      }
      return originalEmit.apply(this, [event, ...args])
    }

    // Listen for messages
    ev.on('messages.set', ({ messages }: { messages: proto.IWebMessageInfo[] }) => {
      console.log(`📦 Store: messages.set - Received ${messages.length} messages`)
      messages.forEach(msg => {
        const chatId = msg.key.remoteJid
        if (chatId) {
          if (!this.messages.has(chatId)) {
            this.messages.set(chatId, [])
          }
          this.messages.get(chatId)!.push(msg)
        }
      })
    })

    ev.on('messages.upsert', ({ messages }: { messages: proto.IWebMessageInfo[] }) => {
      messages.forEach(msg => {
        const chatId = msg.key.remoteJid
        if (chatId) {
          if (!this.messages.has(chatId)) {
            this.messages.set(chatId, [])
          }
          // Add only if not already present
          const existing = this.messages.get(chatId)!
          if (!existing.find(m => m.key.id === msg.key.id)) {
            existing.push(msg)
          }
        }
      })
    })

    console.log('📦 Store event listeners bound')
  }

  getAllChats(): Chat[] {
    return Array.from(this.chats.values())
  }

  getMessages(chatId: string): proto.IWebMessageInfo[] {
    return this.messages.get(chatId) || []
  }
}

// Create a global store instance
export const store = new SimpleStore()

interface ConnectionOptions {
  onQRCode?: (qr: string) => void
  onConnected?: () => void
  onDisconnected?: () => void
}

/**
 * Create and authenticate a WhatsApp connection
 */
export async function createWhatsAppConnection(
  options: ConnectionOptions = {}
): Promise<WASocket> {
  // Use multi-file auth state for session persistence
  const { state, saveCreds } = await useMultiFileAuthState(
    config.WHATSAPP_SESSION_PATH
  )

  // Create WhatsApp socket
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // We'll handle QR display ourselves
    browser: Browsers.macOS('Desktop'),
    // Additional config
    connectTimeoutMs: config.WHATSAPP_AUTH_TIMEOUT,
    // Enable message sync
    syncFullHistory: true,
    // Mark as online to receive messages
    markOnlineOnConnect: true,
    // Get messages from server
    getMessage: async (key) => {
      // Return message from store if available
      const chatId = key.remoteJid
      if (chatId) {
        const messages = store.getMessages(chatId)
        const msg = messages.find(m => m.key.id === key.id)
        return msg || undefined
      }
      return undefined
    },
  })

  // Bind the store to the socket to cache chats and messages
  store.bind(sock.ev)
  console.log('📦 Store bound to socket')

  return new Promise((resolve, reject) => {
    // Track if we've connected successfully
    let hasConnected = false
    let qrTimeout: NodeJS.Timeout | null = null
    let isReconnecting = false

    // Connection update handler
    sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update

      // Display QR code
      if (qr) {
        console.log('\n📱 Scan this QR code with WhatsApp:')
        qrcode.generate(qr, { small: true })
        console.log('\nWaiting for QR scan...\n')

        if (options.onQRCode) {
          options.onQRCode(qr)
        }

        // Set timeout for QR code
        if (qrTimeout) {
          clearTimeout(qrTimeout)
        }
        qrTimeout = setTimeout(() => {
          if (!hasConnected) {
            reject(new Error('QR code scan timeout - please try again'))
          }
        }, config.WHATSAPP_AUTH_TIMEOUT)
      }

      // Connection opened
      if (connection === 'open') {
        hasConnected = true
        if (qrTimeout) {
          clearTimeout(qrTimeout)
        }
        console.log('✅ WhatsApp connection established!')
        if (options.onConnected) {
          options.onConnected()
        }

        // Only resolve once, even if reconnecting
        if (!isReconnecting) {
          resolve(sock)
        }
      }

      // Connection closed
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        console.log(
          'WhatsApp connection closed. Status code:',
          statusCode,
          'Reconnect:',
          shouldReconnect
        )

        // Handle restart after pairing (error code 515 or similar)
        if (shouldReconnect && !hasConnected && !isReconnecting) {
          console.log('🔄 Restarting connection after pairing...')
          isReconnecting = true

          // Wait a bit before reconnecting
          setTimeout(async () => {
            try {
              // Reconnect using the same credentials
              const newSock = await createWhatsAppConnection(options)
              // Replace the old socket reference
              Object.assign(sock, newSock)
              resolve(newSock)
            } catch (err) {
              reject(err)
            }
          }, 1000)
        } else if (!hasConnected && !isReconnecting) {
          // Failed to connect initially
          if (options.onDisconnected) {
            options.onDisconnected()
          }
          reject(
            new Error(
              lastDisconnect?.error?.message || 'Failed to connect to WhatsApp'
            )
          )
        } else if (hasConnected) {
          // Already connected before, this is a disconnect
          if (options.onDisconnected) {
            options.onDisconnected()
          }
        }
      }
    })

    // Credentials update handler - save credentials when they change
    sock.ev.on('creds.update', saveCreds)
  })
}

/**
 * Disconnect from WhatsApp
 */
export async function disconnectWhatsApp(sock: WASocket): Promise<void> {
  sock.end(undefined)
}
