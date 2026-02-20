import { heartbeatSkillCommands, heartbeatSkillsCommand, SkillCommand } from './heartbeatSkills'

export const commands: SkillCommand[] = [heartbeatSkillsCommand, ...heartbeatSkillCommands]

export const commandMap = new Map(commands.map((command) => [command.data.name, command]))
