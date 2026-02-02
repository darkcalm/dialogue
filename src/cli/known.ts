/**
 * CLI tool to view all tracked/persisted data
 * Shows known channels, visit data, and cache stats
 */

import {
  loadVisitData,
  loadKnownChannels,
} from './shared'

// Format relative time
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

function main() {
  console.log('\n📊 Dialogue Known Data\n')

  const knownChannels = loadKnownChannels()
  const visitData = loadVisitData()

  // Group channels by platform
  const discordChannels: Array<{ id: string; name: string; firstSeen: string | null; visitKey: string }> = []
  const whatsappChannels: Array<{ id: string; name: string; firstSeen: string | null; visitKey: string }> = []
  const seenIds = new Set<string>()

  // First, add all known channels
  for (const [key, data] of Object.entries(knownChannels)) {
    const [platform, ...idParts] = key.split(':')
    const id = idParts.join(':') // Handle WhatsApp IDs with colons
    const entry = { id, name: data.name, firstSeen: data.firstSeen, visitKey: key }
    seenIds.add(key)

    if (platform === 'discord') {
      discordChannels.push(entry)
    } else if (platform === 'whatsapp') {
      whatsappChannels.push(entry)
    }
  }

  // Also add followed channels not in known list (backwards compat)
  for (const [key, visit] of Object.entries(visitData)) {
    if (seenIds.has(key)) continue
    
    const [platform, ...idParts] = key.split(':')
    if (!platform || idParts.length === 0) continue // Skip old unprefixed keys
    
    const id = idParts.join(':')
    const entry = { id, name: id, firstSeen: null, visitKey: key }

    if (platform === 'discord') {
      discordChannels.push(entry)
    } else if (platform === 'whatsapp') {
      whatsappChannels.push(entry)
    }
  }

  // Sort by name
  discordChannels.sort((a, b) => a.name.localeCompare(b.name))
  whatsappChannels.sort((a, b) => a.name.localeCompare(b.name))

  // Display Discord channels
  if (discordChannels.length > 0) {
    console.log(`══════ Discord Channels (${discordChannels.length}) ══════`)
    for (const ch of discordChannels) {
      const visit = visitData[ch.visitKey] || visitData[ch.id]
      if (visit) {
        const lastVisit = formatRelativeTime(visit.lastVisited)
        console.log(`  ★ ${ch.name} (followed, last visit: ${lastVisit})`)
      } else {
        console.log(`  ○ ${ch.name} (not followed)`)
      }
    }
    console.log()
  }

  // Display WhatsApp channels
  if (whatsappChannels.length > 0) {
    console.log(`══════ WhatsApp Chats (${whatsappChannels.length}) ══════`)
    for (const ch of whatsappChannels) {
      const visit = visitData[ch.visitKey] || visitData[ch.id]
      if (visit) {
        const lastVisit = formatRelativeTime(visit.lastVisited)
        console.log(`  ★ ${ch.name} (followed, last visit: ${lastVisit})`)
      } else {
        console.log(`  ○ ${ch.name} (not followed)`)
      }
    }
    console.log()
  }

  // Stats
  const totalKnown = discordChannels.length + whatsappChannels.length
  const totalFollowing = Object.keys(visitData).length

  // Find earliest first-seen date
  let earliestDate: string | null = null
  for (const data of Object.values(knownChannels)) {
    if (!earliestDate || data.firstSeen < earliestDate) {
      earliestDate = data.firstSeen
    }
  }

  console.log('══════ Stats ══════')
  console.log(`  Total known: ${totalKnown} channels`)
  console.log(`  Following: ${totalFollowing} channels`)
  if (earliestDate) {
    console.log(`  First tracked: ${new Date(earliestDate).toLocaleDateString()}`)
  }

  if (totalKnown === 0) {
    console.log('\n💡 No channels tracked yet. Run "npm run inbox" to start tracking.')
  }

  console.log()
}

main()
