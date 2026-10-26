export interface Config {
  apiKey: string;
  port: number;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = env.TICKSTREAM_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error("TICKSTREAM_API_KEY is required");
  }
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    // Never include environment values in a configuration error.
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return { apiKey, port };
}
