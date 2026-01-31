/**
 * Platform selector component
 * Interactive menu to choose between Discord and WhatsApp
 */

import React, { useState } from 'react'
import { Box, Text } from 'ink'
import { PlatformType } from '@/platforms/types'

interface PlatformOption {
  value: PlatformType
  label: string
  description: string
}

const PLATFORM_OPTIONS: PlatformOption[] = [
  {
    value: 'discord',
    label: 'Discord',
    description: 'Connect to Discord servers and DMs',
  },
  {
    value: 'whatsapp',
    label: 'WhatsApp',
    description: 'Connect to WhatsApp chats (requires QR code)',
  },
]

interface PlatformSelectorProps {
  onSelect: (platform: PlatformType) => void
  onExit: () => void
}

export const PlatformSelector: React.FC<PlatformSelectorProps> = ({ onSelect, onExit }) => {
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Handle keyboard input
  React.useEffect(() => {
    const handleInput = (data: Buffer) => {
      const key = data.toString()

      // Arrow up
      if (key === '\u001B[A') {
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : PLATFORM_OPTIONS.length - 1))
      }
      // Arrow down
      else if (key === '\u001B[B') {
        setSelectedIndex(prev => (prev < PLATFORM_OPTIONS.length - 1 ? prev + 1 : 0))
      }
      // Enter
      else if (key === '\r' || key === '\n') {
        onSelect(PLATFORM_OPTIONS[selectedIndex].value)
      }
      // Escape or Ctrl+C
      else if (key === '\u001B' || key === '\u0003') {
        onExit()
      }
    }

    process.stdin.setRawMode(true)
    process.stdin.on('data', handleInput)

    return () => {
      process.stdin.setRawMode(false)
      process.stdin.off('data', handleInput)
    }
  }, [selectedIndex, onSelect, onExit])

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Select a platform:
        </Text>
      </Box>

      {PLATFORM_OPTIONS.map((option, index) => {
        const isSelected = index === selectedIndex

        return (
          <Box key={option.value} marginBottom={1}>
            <Box width={3}>
              <Text color={isSelected ? 'green' : 'gray'}>
                {isSelected ? '▶ ' : '  '}
              </Text>
            </Box>
            <Box flexDirection="column">
              <Text bold color={isSelected ? 'white' : 'gray'}>
                {option.label}
              </Text>
              <Text color={isSelected ? 'gray' : 'dim'}>
                {option.description}
              </Text>
            </Box>
          </Box>
        )
      })}

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>
          ↑/↓: Navigate • Enter: Select • Esc: Exit
        </Text>
      </Box>
    </Box>
  )
}
