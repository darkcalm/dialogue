import * as commandModules from '@/commands/index'
import { Client, IntentsBitField } from 'discord.js'
import config from '@/helpers/env'

const commands = Object(commandModules)

export const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.DirectMessages,
    IntentsBitField.Flags.MessageContent, // Required to read message content
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
    if (interaction.isButton()) {
      // Handle button interactions for pagination
      if (interaction.customId.startsWith('links_')) {
        const linksCommand = commands['links']
        if (linksCommand?.handleButton) {
          await linksCommand.handleButton(interaction)
        }
      }
      return
    }

    if (!interaction.isCommand()) return

    const { commandName } = interaction
    if (commands[commandName])
      await commands[commandName].execute(interaction, client)
  })

  await client.login(config.DISCORD_BOT_TOKEN)
}
