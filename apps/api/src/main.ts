import { createApp } from './app';
import { config } from './config';

async function main() {
  const app = await createApp();
  await app.listen(config.port, '127.0.0.1');
  console.log(`API listening on http://localhost:${config.port}/api`);
}

void main();
