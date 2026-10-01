import { configureSharp } from '@pipeline/core/imaging';
import { runWorker } from '@pipeline/core/worker';
import { variants } from './handler';

configureSharp();
await runWorker('VARIANTS', variants);
