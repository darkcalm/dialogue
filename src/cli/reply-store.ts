import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ReplyView } from './shared'

const REPLY_STORE_PATH = path.join(os.homedir(), '.dialogue-reply-views.json')

export interface ReplyViewStore {
  replyViews: ReplyView[]
  lastHeartbeatAt?: string
}

export function getReplyStorePath(): string {
  return REPLY_STORE_PATH
}

export function loadReplyStore(): ReplyViewStore {
  try {
    if (fs.existsSync(REPLY_STORE_PATH)) {
      const raw = fs.readFileSync(REPLY_STORE_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.replyViews)) {
        return {
          replyViews: parsed.replyViews as ReplyView[],
          lastHeartbeatAt: parsed.lastHeartbeatAt as string | undefined,
        }
      }
    }
  } catch {
    // ignore
  }
  return { replyViews: [] }
}

export function saveReplyStore(store: ReplyViewStore): void {
  try {
    fs.writeFileSync(REPLY_STORE_PATH, JSON.stringify(store, null, 2))
  } catch (err) {
    console.error('Failed to save reply views:', err)
  }
}

export function upsertReplyViews(store: ReplyViewStore, views: ReplyView[]): ReplyViewStore {
  const map = new Map(store.replyViews.map(view => [view.id, view]))
  for (const view of views) {
    map.set(view.id, view)
  }
  return { ...store, replyViews: Array.from(map.values()) }
}

export function removeReplyView(store: ReplyViewStore, replyId: string): ReplyViewStore {
  return { ...store, replyViews: store.replyViews.filter(view => view.id !== replyId) }
}

export function rankReplyViews(replyViews: ReplyView[]): ReplyView[] {
  return [...replyViews].sort((a, b) => {
    if (b.interestingnessScore !== a.interestingnessScore) {
      return b.interestingnessScore - a.interestingnessScore
    }
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}
