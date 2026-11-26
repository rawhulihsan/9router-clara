import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
export async function resolve(specifier,context,next) {
  if (specifier.startsWith('@/')) specifier = new URL('../src/'+specifier.slice(2),import.meta.url).href;
  if (specifier.startsWith('open-sse/')) specifier = new URL('../'+specifier,import.meta.url).href;
  if (specifier.startsWith('file:') && !existsSync(fileURLToPath(specifier)) && existsSync(fileURLToPath(specifier)+'.js')) specifier += '.js';
  return next(specifier,context);
}
