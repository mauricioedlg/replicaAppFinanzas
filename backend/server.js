import { once } from 'node:events';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { assertSchema, openDatabase } from './database.js';
import { createEmail } from './email.js';
import { deliverPendingPaymentEmails } from './payments.js';

let db;
let server;
try {
  const config = loadConfig({ args: process.argv.slice(2) });
  db = await openDatabase(config);
  await assertSchema(db);
  const email = createEmail(config);
  server = createApp({ db, config, email }).listen(config.port, config.host);
  await once(server, 'listening');
  console.log(`API Node.js en http://${config.host}:${config.port}`);

  let running = Promise.resolve();
  let worker;
  let stopping = false;
  if (config.paymentWorker) {
    const tick = () => {
      running = deliverPendingPaymentEmails({ db, email })
        .catch((error) => console.error('No se pudieron revisar los comprobantes.', error.code || error.name))
        .finally(() => { if (!stopping) worker = setTimeout(tick, 10_000); });
    };
    worker = setTimeout(tick, 0);
  }
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(worker);
    await Promise.all([new Promise((resolve) => server.close(resolve)), running]);
    await db.close();
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  console.error('La API no pudo iniciar.', error.message);
  server?.close();
  await db?.close();
  process.exitCode = 1;
}
