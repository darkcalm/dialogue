/**
 * Local type declarations for 'ink' to work with moduleResolution: "node".
 * The package uses "exports" which node resolution doesn't follow.
 */
declare module 'ink' {
  import type { ReactNode } from 'react'

  export interface Key {
    upArrow: boolean
    downArrow: boolean
    leftArrow: boolean
    rightArrow: boolean
    pageDown: boolean
    pageUp: boolean
    home: boolean
    end: boolean
    return: boolean
    escape: boolean
    ctrl: boolean
    shift: boolean
    tab: boolean
    backspace: boolean
    delete: boolean
    meta: boolean
    sequence?: string
  }

  export function render(
    tree: ReactNode,
    options?: { stdout?: NodeJS.WritableStream; stdin?: NodeJS.ReadableStream; exitOnCtrlC?: boolean }
  ): {
    waitUntilExit: () => Promise<void>
    unmount: () => void
    rerender: (tree: ReactNode) => void
    clear: () => void
  }

  export const Box: React.FC<{
    flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'
    width?: number | string
    height?: number | string
    minWidth?: number | string
    minHeight?: number | string
    flexGrow?: number
    flexShrink?: number
    paddingX?: number
    marginLeft?: number | string
    borderStyle?: string
    borderColor?: string
    borderLeft?: boolean
    borderRight?: boolean
    backgroundColor?: string
    overflow?: 'hidden' | 'visible'
    children?: ReactNode
  }>

  export const Text: React.FC<{
    color?: string
    bold?: boolean
    dimColor?: boolean
    inverse?: boolean
    children?: ReactNode
  }>

  export function useInput(
    inputHandler: (input: string, key: Key) => void,
    options?: { isActive?: boolean }
  ): void

  export function useApp(): { exit: () => void }

  export function useStdout(): {
    stdout: NodeJS.WriteStream
    write: (data: string) => void
  }
}
