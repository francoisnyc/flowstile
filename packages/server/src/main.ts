import 'reflect-metadata';
import 'dotenv/config';
import { buildApp } from './app.js';

async function start() {
  const app = await buildApp();
  const port = parseInt(process.env.PORT ?? '3000', 10);

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`Flowstile server listening on port ${port}`);
}

start();
