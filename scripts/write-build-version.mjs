import fs from 'fs';
import path from 'path';

const root = process.cwd();

function gitDirectory() {
  const dotGit = path.join(root, '.git');
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) return dotGit;
  const pointer = fs.readFileSync(dotGit, 'utf8').trim();
  return path.resolve(root, pointer.slice('gitdir:'.length).trim());
}

function gitCommit() {
  try {
    const directory = gitDirectory();
    const head = fs.readFileSync(path.join(directory, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head;
    const reference = head.replace(/^ref:\s*/, '');
    const looseReference = path.join(directory, reference);
    if (fs.existsSync(looseReference)) return fs.readFileSync(looseReference, 'utf8').trim();
    const packed = fs.readFileSync(path.join(directory, 'packed-refs'), 'utf8')
      .split(/\r?\n/)
      .find(line => line.endsWith(` ${reference}`));
    return packed?.split(' ')[0] || '';
  } catch {
    return '';
  }
}

const tag = String(process.env.APP_VERSION || '').trim();
const environmentCommit = String(process.env.GIT_COMMIT || '').trim();
let version = '';

if (/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
  version = tag;
} else if (/^[0-9a-f]{7,40}$/i.test(environmentCommit)) {
  version = environmentCommit.slice(0, 12).toLowerCase();
} else {
  version = gitCommit().slice(0, 12).toLowerCase();
}

if (!version) {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  version = `v${packageInfo.version}`;
}

fs.writeFileSync(path.join(root, '.build-version'), `${version}\n`);
