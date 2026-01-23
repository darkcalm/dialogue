import * as dotenv from 'dotenv'
import { cleanEnv, str } from 'envalid'
import { cwd } from 'process'
import { resolve } from 'path'

dotenv.config({ path: resolve(cwd(), '.env') })

// eslint-disable-next-line node/no-process-env
export default cleanEnv(process.env, {
  DISCORD_BOT_TOKEN: str(),
  CLIENT_ID: str(),
  GUILD_ID: str({ default: '' }), // Optional: if not provided, commands deploy globally
  OPENROUTER_API_KEY: str({ default: '' }), // Optional: for LLM message rewriting
  OPENROUTER_MODEL: str({ default: '' }), // Optional: e.g. openrouter/your-model-name
})
