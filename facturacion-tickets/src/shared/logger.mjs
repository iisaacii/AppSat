export const logger = {
  info(message, meta = undefined) {
    write("info", message, meta);
  },
  warn(message, meta = undefined) {
    write("warn", message, meta);
  },
  error(message, meta = undefined) {
    write("error", message, meta);
  },
};

function write(level, message, meta) {
  const payload = {
    level,
    message,
    time: new Date().toISOString(),
    ...(meta ? { meta } : {}),
  };
  console.log(JSON.stringify(payload));
}
