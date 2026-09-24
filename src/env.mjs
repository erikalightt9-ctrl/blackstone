import { readFileSync } from 'node:fs';

// Settings that are secrets - the mail account's password, above all - have to live somewhere
// that is not the repository. A local .env file is the usual answer, and this is a deliberately
// small reader for one: no dependency, no variable expansion, no clever syntax to get wrong.
//
// A real environment variable always wins. A server told its configuration by its own startup
// script must not have it quietly overridden by a file somebody left in the directory.
//
// Only the names of the keys are ever returned, never the values, so a startup log can say
// what was configured without printing a password into it.
export function loadEnvFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return []; // No file is the normal case, not an error.
  }

  const loaded = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1) continue;

    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(equals + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
