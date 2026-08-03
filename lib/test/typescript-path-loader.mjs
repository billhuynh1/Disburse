import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') {
    return { url: 'data:text/javascript,export {}', shortCircuit: true };
  }

  let candidate = specifier;
  if (specifier.startsWith('@/')) {
    candidate = pathToFileURL(`${process.cwd()}/${specifier.slice(2)}`).href;
  }

  try {
    return await nextResolve(candidate, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    if (specifier.startsWith('next/')) {
      return nextResolve(`${specifier}.js`, context);
    }
    const url = new URL(candidate, context.parentURL);
    if (url.protocol !== 'file:' || url.pathname.endsWith('.ts')) throw error;
    await access(`${url.pathname}.ts`);
    return nextResolve(`${url.href}.ts`, context);
  }
}
