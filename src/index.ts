#!/usr/bin/env node
import { Command } from 'commander';
import { loadAppConfig } from './config/load.js';
import { captureLogin } from './browser/manager.js';
import { captureVersion } from './orchestrator/capture.js';
import { assembleDocument } from './orchestrator/assemble.js';
import type { VersionId } from './types.js';
import { log, setLogLevel } from './util/logger.js';

const program = new Command();

program
  .name('ui-doc-engine')
  .description(
    'Explores an enterprise web application and produces a Word evidence document.',
  )
  .option('-v, --verbose', 'verbose logging')
  .hook('preAction', (thisCommand) => {
    if (thisCommand.opts()['verbose']) setLogLevel('debug');
  });

program
  .command('login')
  .description('Sign in once and save the browser session for later runs')
  .requiredOption('-a, --app <name>', 'application slug from config/apps')
  .requiredOption('-V, --version-id <old|new>', 'which version to sign in to')
  .action(async (opts: { app: string; versionId: string }) => {
    const app = await loadAppConfig(opts.app);
    await captureLogin(app, asVersion(opts.versionId));
  });

program
  .command('capture')
  .description('Explore one application version and record evidence')
  .requiredOption('-a, --app <name>', 'application slug from config/apps')
  .requiredOption('-V, --version-id <old|new>', 'which version to capture')
  .option('--headed', 'show the browser while capturing')
  .action(async (opts: { app: string; versionId: string; headed?: boolean }) => {
    const app = await loadAppConfig(opts.app);
    await captureVersion(app, asVersion(opts.versionId), {
      headless: !opts.headed,
    });
  });

program
  .command('assemble')
  .description('Build the Word document from previously captured runs')
  .requiredOption('-a, --app <name>', 'application slug from config/apps')
  .option('--old-run <runId>', 'specific old-version run to use')
  .option('--new-run <runId>', 'specific new-version run to use')
  .option('-o, --out <path>', 'output .docx path')
  .action(
    async (opts: {
      app: string;
      oldRun?: string;
      newRun?: string;
      out?: string;
    }) => {
      const app = await loadAppConfig(opts.app);
      await assembleDocument(app, {
        runIds: {
          ...(opts.oldRun ? { old: opts.oldRun } : {}),
          ...(opts.newRun ? { new: opts.newRun } : {}),
        },
        ...(opts.out ? { outputPath: opts.out } : {}),
      });
    },
  );

program
  .command('run')
  .description('Capture both versions and assemble the document')
  .requiredOption('-a, --app <name>', 'application slug from config/apps')
  .option('--headed', 'show the browser while capturing')
  .action(async (opts: { app: string; headed?: boolean }) => {
    const app = await loadAppConfig(opts.app);
    const runIds: Partial<Record<VersionId, string>> = {};

    for (const version of ['old', 'new'] as VersionId[]) {
      if (!app.versions[version]) {
        log.info(`No ${version} version configured; skipping.`);
        continue;
      }
      const { trace } = await captureVersion(app, version, {
        headless: !opts.headed,
      });
      runIds[version] = trace.runId;
    }

    await assembleDocument(app, { runIds });
  });

program
  .command('serve')
  .description('Start the web interface for pasting URLs and generating documents')
  .option('-p, --port <number>', 'port to listen on', '5173')
  .action(async (opts: { port: string }) => {
    const { serve } = await import('./server/app.js');
    await serve(Number(opts.port));
  });

function asVersion(value: string): VersionId {
  if (value !== 'old' && value !== 'new') {
    throw new Error(`--version-id must be "old" or "new", received "${value}"`);
  }
  return value;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
