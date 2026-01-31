/**
 * Helper function to show platform selector
 */

import React from 'react'
import { render } from 'ink'
import { PlatformSelector } from './PlatformSelector'
import { PlatformType } from '@/platforms/types'

/**
 * Show platform selector and wait for user choice
 */
export async function showPlatformSelector(): Promise<PlatformType | null> {
  return new Promise((resolve) => {
    const { unmount } = render(
      <PlatformSelector
        onSelect={(platform) => {
          unmount()
          resolve(platform)
        }}
        onExit={() => {
          unmount()
          resolve(null)
        }}
      />
    )
  })
}
