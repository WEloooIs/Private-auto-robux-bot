import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: ["*.token", "*.authorization", "*.cookie", "*.session"],
      remove: true,
    },
  });
}