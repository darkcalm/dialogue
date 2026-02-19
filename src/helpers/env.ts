import * as dotenv from 'dotenv'
import { cleanEnv, str, num } from 'envalid'
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
  DIALOGUE_HEARTBEAT_INTERVAL_MS: num({ default: 300000 }), // Heartbeat interval for reply view generation
  WHATSAPP_SESSION_PATH: str({ default: './whatsapp-session' }), // WhatsApp session storage
  WHATSAPP_AUTH_TIMEOUT: num({ default: 60000 }), // WhatsApp QR auth timeout (ms)
})
