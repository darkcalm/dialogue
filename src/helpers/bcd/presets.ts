/**
 * BCD: Basic Consultant Dialogues
 * Ported from Python to TypeScript
 * Original: https://replit.com/@darkcalm/bcd#main.py
 */

export interface DiagramKey {
  [key: string]: string[] // key name -> array of aliases
}

export interface Diagram {
  prefix: string
  keys: DiagramKey
  affine: unknown[]
  seedformats: { [count: number]: number[] }
  requests: { [key: string]: string[] }
  printedseed(keyed: KeyedData): string
  assignedBySeed(text: string): KeyedData
  assignedByKey(text: string): KeyedData
}

export interface KeyedData {
  [key: string]: { assigned: string }
}

export interface Payload {
  diagram: Diagram
  keyed: KeyedData
}

/**
 * Parse payload from user input
 */
export function parsePayload(...args: string[]): Payload | null {
  try {
    // Parse arguments: "diagram <> assign" format
    const parsed = args.map((arg) => {
      const match = arg.match(/^(.*?)\s*<>\s*(.+)$/)
      if (match) {
        return [match[1].trim(), match[2].trim()]
      }
      return ['', arg.trim()]
    })

    // Find diagram type
    const diagramName = parsed.find((p) => p[0] && Protocols[p[0]])?.[0] || ''

    if (!diagramName || !Protocols[diagramName]) {
      return null
    }

    const diagram = Protocols[diagramName]

    // Process assignments
    const keyed: KeyedData = {}
    for (const [diag, assign] of parsed) {
      if (diag === diagramName || !diag) {
        const assigned = diag
          ? diagram.assignedBySeed(assign)
          : diagram.assignedByKey(assign)
        Object.assign(keyed, assigned)
      }
    }

    return { diagram, keyed }
  } catch (error) {
    console.error('Error parsing payload:', error)
    return null
  }
}

/**
 * Diagram class implementation
 */
class DiagramImpl implements Diagram {
  prefix: string
  keys: DiagramKey
  affine: unknown[]
  seedformats: { [count: number]: number[] }
  requests: { [key: string]: string[] }

  constructor(
    prefix: string,
    keys: DiagramKey,
    affine: unknown[] = [],
    seedformats: { [count: number]: number[] } = {},
    requests: { [key: string]: string[] } = {}
  ) {
    this.prefix = prefix
    this.keys = keys
    this.affine = affine
    this.seedformats = seedformats
    this.requests = requests
  }

  /**
   * Generate printed seed output
   */
  printedseed(keyed: KeyedData): string {
    const keyNames = Object.keys(this.keys)
    const values = keyNames.map((k) => {
      if (keyed[k]) {
        // Escape special characters for display
        return keyed[k].assigned.replace(/[\\`*_\[\]()#+\-.!]/g, '\\$&')
      }
      return ''
    })

    return `${this.prefix} <> ${values.filter((v) => v).join('; ')}`
  }

  /**
   * Unescape text
   */
  descape(text: string): string {
    return text.replace(/\\(.)/g, '$1')
  }

  /**
   * Assign by seed format (positional)
   */
  assignedBySeed(text: string): KeyedData {
    const parts = text.split(';').map((t) => t.trim())
    const count = parts.length

    if (this.seedformats[count]) {
      const keyNames = Object.keys(this.keys)
      const result: KeyedData = {}

      for (let i = 0; i < this.seedformats[count].length; i++) {
        const keyIndex = this.seedformats[count][i]
        if (keyIndex < keyNames.length && i < parts.length) {
          result[keyNames[keyIndex]] = { assigned: this.descape(parts[i]) }
        }
      }

      return result
    }

    // Fallback to key-based assignment
    return this.assignedByKey(text)
  }

  /**
   * Assign by key name
   */
  assignedByKey(text: string): KeyedData {
    const keyNames = Object.keys(this.keys)
    const result: KeyedData = {}

    for (const key of keyNames) {
      // Match patterns like "key value" or "; key value"
      const patterns = this.keys[key].map((alias) => {
        // Escape special regex characters in alias
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return `(?:^|;\\s*)${escaped}\\s+([^;]+)`
      })

      for (const pattern of patterns) {
        const regex = new RegExp(pattern, 'i')
        const match = text.match(regex)
        if (match && match[1]) {
          result[key] = { assigned: this.descape(match[1].trim()) }
          break
        }
      }
    }

    return result
  }
}

/**
 * Protocol definitions
 */
export const Protocols: { [name: string]: DiagramImpl } = {
  '2x2': new DiagramImpl(
    '2x2',
    {
      q1: ['quadrant 1'],
      q2: ['quadrant 2'],
      q3: ['quadrant 3'],
      q4: ['quadrant 4'],
      xp: ['positive x'],
      xn: ['negative x'],
      yp: ['positive y'],
      yn: ['negative y'],
      x: ['axis x'],
      y: ['axis y'],
      t: ['title'],
    },
    [],
    {
      11: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      10: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      9: [0, 1, 2, 3, 4, 5, 6, 7, 10],
      8: [0, 1, 2, 3, 4, 5, 6, 7],
      7: [4, 5, 6, 7, 8, 9, 10],
      6: [4, 5, 6, 7, 8, 9],
      5: [4, 5, 6, 7, 10],
      4: [4, 5, 6, 7],
      3: [8, 9, 10],
      2: [8, 9],
      1: [10],
    },
    {
      functionandpropertiesandvalues1: ['line of x at xp/xn'],
      functionandpropertiesandvalues2: ['line of y at yp/yn'],
    }
  ),

  '2/3': new DiagramImpl(
    '2/3',
    {
      u: ['top corner'],
      l: ['left corner'],
      r: ['right corner'],
      '-u': ['bottom side'],
      '-l': ['right side'],
      '-r': ['left side'],
      t: ['title'],
    },
    [],
    {
      7: [0, 1, 2, 3, 4, 5, 6],
      6: [0, 1, 2, 3, 4, 5],
      4: [0, 1, 2, 6],
      3: [0, 1, 2],
      1: [6],
    },
    {
      functionandproperties1: ['line of -u at l/r'],
      functionandproperties2: ['line of -l at u/r'],
      functionandproperties3: ['line of -r at u/l'],
    }
  ),
}
