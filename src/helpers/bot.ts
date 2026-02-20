import { Client, IntentsBitField } from 'discord.js'
import config from '@/helpers/env'
import { commandMap } from '@/commands/index'

export const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.DirectMessages,
    IntentsBitField.Flags.MessageContent,
  ],
})

export async function startBot() {
  client.once('clientReady', (client) => {
    console.log(`Discord ${client.user.tag} is ready`)
    console.log(
      `Link to invite: https://discord.com/api/oauth2/authorize?client_id=${config.CLIENT_ID}&permissions=0&scope=bot%20applications.commands`
    )
  })

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return
    const command = commandMap.get(interaction.commandName)
    if (!command) return
    try {
      await command.execute(interaction)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: message, ephemeral: true })
      } else {
        await interaction.reply({ content: message, ephemeral: true })
      }
    }
  })

  await client.login(config.DISCORD_BOT_TOKEN)
}
