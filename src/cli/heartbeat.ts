import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as https from 'https'
import { Client as LibsqlClient } from '@libsql/client'
import config from '@/helpers/env'
import { createPlatformClient } from '@/platforms/factory'
import {
  getClient,
  initDB,
  closeAllDBs,
  getChannels,
  getMessagesSince,
  rowToMessageRecord,
  MessageRecord,
  ChannelRecord,
} from './db'
import {
  ReplyView,
  ReplyViewAttachment,
  ReplyViewHighlight,
  ReplyViewWebResult,
} from './shared'
import { HEARTBEAT_SKILLS } from '@/commands/heartbeatSkills'
import {
  loadReplyStore,
  saveReplyStore,
  upsertReplyViews,
  rankReplyViews,
} from './reply-store'

const HEARTBEAT_LOCK_FILE = path.join(os.homedir(), '.dialogue-heartbeat.lock')
const HEARTBEAT_LOG_FILE = path.join(os.homedir(), '.dialogue-heartbeat.log')

const MAX_SEARCH_TERMS = 6
const MAX_ARCHIVE_RESULTS = 5
const MAX_WEB_RESULTS = 4
const MAX_NEW_DRAFTS_PER_HEARTBEAT = 6
const MAX_RETHINK_PER_HEARTBEAT = 2
const RETHINK_INTERVAL_HOURS = 6

const STOP_WORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'when', 'where', 'which',
  'would', 'could', 'should', 'there', 'their', 'about', 'your', 'youre', 'yourself',
  'into', 'over', 'under', 'while', 'were', 'been', 'being', 'just', 'like', 'because',
  'also', 'some', 'more', 'than', 'then', 'them', 'they', 'these', 'those', 'here',
  'want', 'need', 'does', 'did', 'doing', 'done', 'cant', 'cannot', 'dont', 'wont',
  'will', 'shall', 'might', 'must', 'such', 'much', 'many', 'each', 'other', 'most',
])

let isRunning = true

function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString()
  const logLine = `[${timestamp}] ${message}`
  console.log(logLine)
  try { fs.appendFileSync(HEARTBEAT_LOG_FILE, logLine + '\n') } catch {}
}

function writeLockFile(): void {
  fs.writeFileSync(HEARTBEAT_LOCK_FILE, process.pid.toString(), 'utf-8')
}

function removeLockFile(): void {
  try { if (fs.existsSync(HEARTBEAT_LOCK_FILE)) fs.unlinkSync(HEARTBEAT_LOCK_FILE) } catch {}
}

function isHeartbeatRunning(): boolean {
  try {
    if (!fs.existsSync(HEARTBEAT_LOCK_FILE)) return false
    const pid = parseInt(fs.readFileSync(HEARTBEAT_LOCK_FILE, 'utf-8').trim(), 10)
    process.kill(pid, 0)
    return true
  } catch {
    if (fs.existsSync(HEARTBEAT_LOCK_FILE)) fs.unlinkSync(HEARTBEAT_LOCK_FILE)
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function extractSearchTerms(content: string): string[] {
  const cleaned = content
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .toLowerCase()
  const terms = cleaned
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length >= 4 && !STOP_WORDS.has(term))
  return Array.from(new Set(terms)).slice(0, MAX_SEARCH_TERMS)
}

async function searchArchiveMessages(
  archiveDb: LibsqlClient,
  terms: string[]
): Promise<ReplyViewHighlight[]> {
  const hits = new Map<string, ReplyViewHighlight>()
  for (const term of terms) {
    const result = await archiveDb.execute({
      sql: `
        SELECT m.*, c.name as channel_name
        FROM messages m
        LEFT JOIN channels c ON c.id = m.channel_id
        WHERE m.content LIKE ?
        ORDER BY m.timestamp DESC
        LIMIT ?
      `,
      args: [`%${term}%`, MAX_ARCHIVE_RESULTS],
    })
    for (const row of result.rows) {
      const record = rowToMessageRecord(row)
      if (hits.has(record.id)) continue
      hits.set(record.id, {
        id: record.id,
        channelId: record.channelId,
        channelName: (row.channel_name as string) || undefined,
        author: record.authorName,
        content: record.content,
        timestamp: record.timestamp,
      })
    }
  }

  return Array.from(hits.values()).slice(0, MAX_ARCHIVE_RESULTS)
}

async function searchWeb(query: string): Promise<ReplyViewWebResult[]> {
  return await new Promise((resolve) => {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
      https.get(url, (res) => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            const results: ReplyViewWebResult[] = []
            if (parsed?.AbstractURL && parsed?.AbstractText) {
              results.push({
                query,
                title: parsed.Heading || parsed.AbstractURL,
                url: parsed.AbstractURL,
                snippet: parsed.AbstractText,
              })
            }
            if (Array.isArray(parsed?.RelatedTopics)) {
              for (const topic of parsed.RelatedTopics) {
                if (results.length >= MAX_WEB_RESULTS) break
                const text = topic?.Text as string | undefined
                const topicUrl = topic?.FirstURL as string | undefined
                if (text && topicUrl) {
                  results.push({
                    query,
                    title: text.split(' - ')[0] || text,
                    url: topicUrl,
                    snippet: text,
                  })
                }
              }
            }
            resolve(results)
          } catch {
            resolve([])
          }
        })
      }).on('error', () => resolve([]))
    } catch {
      resolve([])
    }
  })
}

function extractJsonPayload(text: string): any | null {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

async function requestReplyDraft(prompt: string): Promise<{ draft: string; noveltyScore: number; curiosityScore: number; attachments?: ReplyViewAttachment[] } | null> {
  if (!config.OPENROUTER_API_KEY || !config.OPENROUTER_MODEL) return null

  return await new Promise((resolve) => {
    try {
      const data = JSON.stringify({
        model: config.OPENROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are an inquisitive synthesis agent. Craft short, grounded reply drafts that surface the core insight only. ' +
              'Keep replies to 2-3 sentences, under 60 words, no preamble. ' +
              'Do not mention prior people or sources. Keep references out of the draft. ' +
              'Return a JSON object with keys: draft (string), noveltyScore (number 0-1), curiosityScore (number 0-1), attachments (optional array of {path,name}). ' +
              'Only include attachments if you created files in /tmp for this reply. ' +
              'If nothing truly novel emerges, set noveltyScore below 0.5 and draft to an empty string.',
          },
          {
            role: 'user',
            content: prompt,
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
          'X-Title': 'dialogue-reply-heartbeat',
        },
      }

      const req = https.request(options, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            const content = parsed?.choices?.[0]?.message?.content
            if (typeof content !== 'string') {
              resolve(null)
              return
            }
            const payload = extractJsonPayload(content)
            const draft = typeof payload?.draft === 'string' ? payload.draft.trim() : ''
            const noveltyScore = Number(payload?.noveltyScore)
            const curiosityScore = Number(payload?.curiosityScore)
            const attachments = Array.isArray(payload?.attachments)
              ? payload.attachments.filter((item: any) => item?.path && item?.name)
              : undefined
            if (!draft || !Number.isFinite(noveltyScore) || !Number.isFinite(curiosityScore)) {
              resolve(null)
              return
            }
            resolve({
              draft,
              noveltyScore,
              curiosityScore,
              attachments,
            })
          } catch {
            resolve(null)
          }
        })
      })

      req.on('error', () => resolve(null))
      req.write(data)
      req.end()
    } catch {
      resolve(null)
    }
  })
}

function computeRecencyScore(timestamp: string): number {
  const messageTime = new Date(timestamp).getTime()
  const hours = Math.max(0, (Date.now() - messageTime) / (1000 * 60 * 60))
  const score = 1 / (1 + hours / 6)
  return Math.max(0, Math.min(1, score))
}

function computeInterestingness(options: {
  novelty: number
  curiosity: number
  recency: number
  archiveCount: number
  webCount: number
}): number {
  const archiveScore = Math.min(1, options.archiveCount / MAX_ARCHIVE_RESULTS)
  const webScore = Math.min(1, options.webCount / MAX_WEB_RESULTS)
  const weighted =
    options.novelty * 0.45 +
    options.curiosity * 0.25 +
    options.recency * 0.15 +
    archiveScore * 0.1 +
    webScore * 0.05
  return Math.max(0, Math.min(1, weighted))
}

async function createReplyView(
  message: MessageRecord,
  channel: ChannelRecord,
  archiveDb: LibsqlClient,
): Promise<ReplyView | null> {
  const terms = extractSearchTerms(message.content)
  if (terms.length === 0) return null

  const archiveHighlights = await searchArchiveMessages(archiveDb, terms)
  const webSearchResults: ReplyViewWebResult[] = []
  for (const term of terms.slice(0, 2)) {
    const results = await searchWeb(term)
    webSearchResults.push(...results)
  }

  const highlightLines = archiveHighlights
    .map((hit) => {
      const channelLabel = channel.guildName
        ? `${channel.guildName} / #${hit.channelName || hit.channelId}`
        : `#${hit.channelName || hit.channelId}`
      const snippet = hit.content.slice(0, 180).replace(/\s+/g, ' ')
      return `- (${channelLabel}) ${hit.author}: ${snippet}`
    })
    .join('\n')

  const webLines = webSearchResults
    .slice(0, MAX_WEB_RESULTS)
    .map((item) => `- ${item.title}: ${item.snippet} (${item.url})`)
    .join('\n')

  const prompt = [
    `Incoming message from ${message.authorName} in #${channel.name}:`,
    message.content.trim(),
    '',
    'Recent recency signal: high if it is urgent or time-sensitive.',
    '',
    'Archive search highlights:',
    highlightLines || '- (none)',
    '',
    'Web search highlights:',
    webLines || '- (none)',
    '',
    'Craft a concise reply that fuses the incoming message with the strongest past idea. Be specific and concrete.',
  ].join('\n')

  const draftResult = await requestReplyDraft(prompt)
  if (!draftResult) return null

  const recencyScore = computeRecencyScore(message.timestamp)
  const interestingnessScore = computeInterestingness({
    novelty: draftResult.noveltyScore,
    curiosity: draftResult.curiosityScore,
    recency: recencyScore,
    archiveCount: archiveHighlights.length,
    webCount: webSearchResults.length,
  })

  const now = new Date().toISOString()
  return {
    id: `${message.channelId}:${message.id}`,
    targetChannelId: message.channelId,
    targetChannelName: channel.name,
    targetGuildName: channel.guildName,
    targetGuildId: channel.guildId,
    sourceMessageId: message.id,
    sourceAuthor: message.authorName,
    sourceContent: message.content,
    sourceTimestamp: message.timestamp,
    draft: draftResult.draft,
    attachments: draftResult.attachments,
    noveltyScore: draftResult.noveltyScore,
    curiosityScore: draftResult.curiosityScore,
    recencyScore,
    interestingnessScore,
    archiveHighlights,
    webSearchResults,
    toolsUsed: ['archive-search', 'web-search', 'reply-synthesis'],
    skillsUsed: HEARTBEAT_SKILLS.map((skill) => skill.id),
    createdAt: now,
    updatedAt: now,
  }
}

async function rethinkReplyView(
  view: ReplyView,
  archiveDb: LibsqlClient
): Promise<ReplyView | null> {
  const terms = extractSearchTerms(view.sourceContent)
  const archiveHighlights = await searchArchiveMessages(archiveDb, terms)
  const webSearchResults: ReplyViewWebResult[] = []
  for (const term of terms.slice(0, 2)) {
    const results = await searchWeb(term)
    webSearchResults.push(...results)
  }

  const highlightLines = archiveHighlights
    .map((hit) => {
      const channelLabel = view.targetGuildName
        ? `${view.targetGuildName} / #${hit.channelName || hit.channelId}`
        : `#${hit.channelName || hit.channelId}`
      const snippet = hit.content.slice(0, 180).replace(/\s+/g, ' ')
      return `- (${channelLabel}) ${hit.author}: ${snippet}`
    })
    .join('\n')

  const webLines = webSearchResults
    .slice(0, MAX_WEB_RESULTS)
    .map((item) => `- ${item.title}: ${item.snippet} (${item.url})`)
    .join('\n')

  const prompt = [
    `Incoming message from ${view.sourceAuthor} in #${view.targetChannelName}:`,
    view.sourceContent.trim(),
    '',
    'Archive search highlights:',
    highlightLines || '- (none)',
    '',
    'Web search highlights:',
    webLines || '- (none)',
    '',
    'Re-evaluate the reply draft for novelty and curiosity. Improve it if possible, staying concise.',
  ].join('\n')

  const draftResult = await requestReplyDraft(prompt)
  if (!draftResult) return null

  const recencyScore = computeRecencyScore(view.sourceTimestamp)
  const interestingnessScore = computeInterestingness({
    novelty: draftResult.noveltyScore,
    curiosity: draftResult.curiosityScore,
    recency: recencyScore,
    archiveCount: archiveHighlights.length,
    webCount: webSearchResults.length,
  })

  return {
    ...view,
    draft: draftResult.draft,
    attachments: draftResult.attachments,
    noveltyScore: draftResult.noveltyScore,
    curiosityScore: draftResult.curiosityScore,
    recencyScore,
    interestingnessScore,
    archiveHighlights,
    webSearchResults,
    updatedAt: new Date().toISOString(),
  }
}

async function runHeartbeatCycle(
  realtimeDb: LibsqlClient,
  archiveDb: LibsqlClient,
  botUserId?: string,
): Promise<void> {
  const store = loadReplyStore()
  const lastHeartbeat = store.lastHeartbeatAt || new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const channels = await getChannels(realtimeDb)
  const channelMap = new Map(channels.map((ch) => [ch.id, ch]))
  const newViews: ReplyView[] = []

  for (const channel of channels) {
    if (newViews.length >= MAX_NEW_DRAFTS_PER_HEARTBEAT) break
    const messages = await getMessagesSince(realtimeDb, channel.id, lastHeartbeat, botUserId)
    for (const message of messages) {
      if (newViews.length >= MAX_NEW_DRAFTS_PER_HEARTBEAT) break
      if (!message.content || message.content.trim().length < 8) continue
      const viewId = `${message.channelId}:${message.id}`
      if (store.replyViews.some(view => view.id === viewId)) continue
      const channelRecord = channelMap.get(message.channelId)
      if (!channelRecord) continue
      const view = await createReplyView(message, channelRecord, archiveDb)
      if (view && view.noveltyScore >= 0.5) {
        newViews.push(view)
      }
    }
  }

  let updatedStore = upsertReplyViews(store, newViews)

  updatedStore = {
    ...updatedStore,
    replyViews: updatedStore.replyViews.map((view) => {
      const recencyScore = computeRecencyScore(view.sourceTimestamp)
      const interestingnessScore = computeInterestingness({
        novelty: view.noveltyScore,
        curiosity: view.curiosityScore,
        recency: recencyScore,
        archiveCount: view.archiveHighlights.length,
        webCount: view.webSearchResults.length,
      })
      return { ...view, recencyScore, interestingnessScore }
    }),
  }

  const rethinkCandidates = updatedStore.replyViews
    .filter((view) => {
      const hours = (Date.now() - new Date(view.updatedAt).getTime()) / (1000 * 60 * 60)
      return hours >= RETHINK_INTERVAL_HOURS
    })
    .sort((a, b) => a.interestingnessScore - b.interestingnessScore)
    .slice(0, MAX_RETHINK_PER_HEARTBEAT)

  for (const view of rethinkCandidates) {
    const refreshed = await rethinkReplyView(view, archiveDb)
    if (refreshed) {
      updatedStore = upsertReplyViews(updatedStore, [refreshed])
    }
  }

  const reranked = rankReplyViews(updatedStore.replyViews)
  updatedStore = { ...updatedStore, replyViews: reranked, lastHeartbeatAt: new Date().toISOString() }
  saveReplyStore(updatedStore)

  log(`Heartbeat complete. ${newViews.length} new reply view${newViews.length === 1 ? '' : 's'} added.`)
}

async function main() {
  if (!config.OPENROUTER_API_KEY || !config.OPENROUTER_MODEL) {
    console.log('❌ OPENROUTER_API_KEY and OPENROUTER_MODEL are required for heartbeat.')
    process.exit(1)
  }

  if (isHeartbeatRunning()) {
    console.log('✅ Heartbeat already running.')
    process.exit(0)
  }

  writeLockFile()
  process.on('exit', () => {
    removeLockFile()
  })
  process.on('SIGINT', () => {
    isRunning = false
  })
  process.on('SIGTERM', () => {
    isRunning = false
  })
  process.on('uncaughtException', (err) => {
    log(`⚠️  Heartbeat crash: ${err.message}`)
  })
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason)
    log(`⚠️  Heartbeat rejection: ${message}`)
  })

  const realtimeDb = getClient('realtime', 'local')
  const archiveDb = getClient('archive', 'local')
  await initDB(realtimeDb)
  await initDB(archiveDb)

  log('🔌 Connecting heartbeat to Discord...')
  const platformClient = await createPlatformClient('discord')
  await platformClient.connect()
  const botUserId = platformClient.getCurrentUser()?.id

  log('💓 Heartbeat started.')
  while (isRunning) {
    try {
      await runHeartbeatCycle(realtimeDb, archiveDb, botUserId)
    } catch (err) {
      log(`⚠️  Heartbeat error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
    log(`⏳ Next heartbeat in ${Math.round(config.DIALOGUE_HEARTBEAT_INTERVAL_MS / 1000)}s`)
    await sleep(config.DIALOGUE_HEARTBEAT_INTERVAL_MS)
  }

  log('🛑 Heartbeat stopping...')
  await platformClient.disconnect()
  closeAllDBs()
  removeLockFile()
}

main().catch((err) => {
  console.error('❌ Heartbeat fatal error:', err instanceof Error ? err.message : 'Unknown error')
  removeLockFile()
  process.exit(1)
})
