import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const required = ['index.html', 'index.html.gz', 'a.js', 'a.js.gz', 'a.css', 'a.css.gz', 'x.js', 'x.js.gz'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function filesIn(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${file}`);
    if (entry.isDirectory()) return filesIn(file, base);
    if (!entry.isFile()) throw new Error(`Not a regular file: ${file}`);
    return [relative(base, file)];
  });
}

export function stageWebAssets(frontendDist, firmwareDist) {
  frontendDist = resolve(frontendDist);
  firmwareDist = resolve(firmwareDist);
  const nested = relative(frontendDist, firmwareDist);
  if (!nested || (!nested.startsWith(`..${sep}`) && nested !== '..')) {
    throw new Error('Frontend output and firmware output must be separate directories');
  }
  if (!existsSync(frontendDist) || lstatSync(frontendDist).isSymbolicLink()) {
    throw new Error(`Frontend build missing or invalid: ${frontendDist}`);
  }
  for (const name of required) {
    const file = join(frontendDist, name);
    if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error(`Build file missing: ${file}`);
  }
  const files = filesIn(frontendDist);
  for (const name of files.filter((file) => file.endsWith('.gz'))) {
    const raw = join(frontendDist, name.slice(0, -3));
    if (!existsSync(raw) || !gunzipSync(readFileSync(join(frontendDist, name))).equals(readFileSync(raw))) {
      throw new Error(`gzip does not match its source: ${name}`);
    }
  }
  const destination = join(firmwareDist, 'orig');
  if (existsSync(destination) && (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory())) {
    throw new Error(`Firmware asset destination is not a normal directory: ${destination}`);
  }
  const cache = join(dirname(firmwareDist), '.cache');
  mkdirSync(cache, { recursive: true });
  const temporary = mkdtempSync(join(cache, 'web-assets-'));
  const next = join(temporary, 'next');
  const previous = join(temporary, 'previous');
  let published = false;
  try {
    mkdirSync(next);
    for (const name of files) {
      const mapped = name === 'index.html' ? 'i.html' : name === 'index.html.gz' ? 'i.html.gz' : name;
      const target = join(next, mapped);
      if (existsSync(target)) throw new Error(`Duplicate output name: ${mapped}`);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(frontendDist, name), target);
    }
    mkdirSync(firmwareDist, { recursive: true });
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(next, destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
    published = true;
  } finally {
    // Keep the recoverable previous directory if rollback itself failed.
    if (published || !existsSync(previous)) rmSync(temporary, { recursive: true, force: true });
  }
  return destination;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const destination = stageWebAssets(join(root, 'frontend', 'dist'), join(root, 'dist'));
    console.log(`Prepared firmware web assets: ${destination}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
