#!/usr/bin/env node
// Standalone setup runner for Crucix
import { runSetupWizard } from '../lib/setup-wizard.mjs';

const isCli = process.argv.includes('--cli');
const isWeb = process.argv.includes('--web');

await runSetupWizard({ cli: isCli, web: isWeb });
