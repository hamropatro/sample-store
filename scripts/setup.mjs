import { copyFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
try {
  await copyFile(new URL('../.env.example', import.meta.url), new URL('../.env', import.meta.url), constants.COPYFILE_EXCL);
  await chmod(new URL('../.env', import.meta.url), 0o600);
  console.log('Created .env in demo mode. No credentials needed.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Keeping your existing .env unchanged.');
}
console.log('Run npm start, then open the printed localhost URL.');
