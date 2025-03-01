import { createStatusRouter } from '@aztec/foundation/json-rpc/server';
import { type DebugLogger } from '@aztec/foundation/log';
import { createTXERpcServer } from '@aztec/txe';

import http from 'http';

export const startTXE = (options: any, debugLogger: DebugLogger) => {
  debugLogger.info(`Setting up TXE...`);
  const txeServer = createTXERpcServer(debugLogger);
  const app = txeServer.getApp();
  // add status route
  const statusRouter = createStatusRouter(() => txeServer.isHealthy());
  app.use(statusRouter.routes()).use(statusRouter.allowedMethods());

  const httpServer = http.createServer(app.callback());
  httpServer.timeout = 1e3 * 60 * 5; // 5 minutes
  httpServer.listen(options.port);

  debugLogger.info(`TXE listening on port ${options.port}`);
};
