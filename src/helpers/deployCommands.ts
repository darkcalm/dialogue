import { commands as registeredCommands } from '@/commands/index'
import { REST } from '@discordjs/rest'
import { Routes } from 'discord-api-types/v10'
import cleanEnv from '@/helpers/env'

export default async function deployCommands() {
  const commands: unknown[] = []

  for (const command of registeredCommands) {
    commands.push(command.data)
  }

  const rest = new REST({ version: '10' }).setToken(cleanEnv.DISCORD_BOT_TOKEN)

  try {
    // Deploy to guild if GUILD_ID is provided, otherwise deploy globally
    if (cleanEnv.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(cleanEnv.CLIENT_ID, cleanEnv.GUILD_ID),
        { body: commands }
      )
      console.log(`Commands deployed to guild: ${cleanEnv.GUILD_ID}`)
    } else {
      await rest.put(
        Routes.applicationCommands(cleanEnv.CLIENT_ID),
        { body: commands }
      )
      console.log('Commands deployed globally (may take up to 1 hour to propagate)')
    }
  } catch (error) {
    console.error('Error deploying commands:', error)
  }
}
