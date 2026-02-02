# Known CLI Tool (`npm run known`)

A CLI tool to view all tracked/persisted data from the dialogue app.

## Purpose

While `npm run inbox` is the interactive messaging client, `npm run known` provides a read-only view of all persisted state:

- Known channels (from `~/.dialogue-known-channels.json`)
- Visit data / followed channels (from `~/.dialogue-channel-visits.json`)
- Cached messages (from `~/.dialogue-cache.json` if exists)

## Implementation Plan

### Phase 1: Basic Implementation ✅
- [x] Rename `npm run post` to `npm run known`
- [x] Create `src/cli/known.ts` with basic structure
- [x] Display known channels grouped by platform
- [x] Display followed channels with last visit time

### Phase 2: Enhanced Display
- [ ] Show message cache stats (count per channel, age)
- [ ] Add filtering by platform (discord/whatsapp)
- [ ] Show unfollowed channels separately
- [ ] Add channel search functionality

### Phase 3: Management Features
- [ ] Allow removing stale/deleted channels from known list
- [ ] Export data to JSON
- [ ] Clear cache commands

## Data Files

| File | Description |
|------|-------------|
| `~/.dialogue-known-channels.json` | All channels ever seen, with first-seen timestamp |
| `~/.dialogue-channel-visits.json` | Followed channels with last visit time |
| `~/.dialogue-cache.json` | Message cache (if implemented) |

## Usage

```bash
npm run known
```

## Output Example

```
📊 Dialogue Known Data

══════ Discord Channels (15) ══════
  ★ server-name / general (followed, last visit: 2h ago)
  ★ server-name / random (followed, last visit: 1d ago)
  ○ server-name / announcements (not followed)

══════ WhatsApp Chats (8) ══════
  ★ Family Group (followed, last visit: 30m ago)
  ○ Work Chat (not followed)

══════ Stats ══════
  Total known: 23 channels
  Following: 12 channels
  First tracked: 2024-01-15
```
