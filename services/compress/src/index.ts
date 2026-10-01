import { configureSharp } from '@pipeline/core/imaging';
import { runWorker } from '@pipeline/core/worker';
import { compress } from './handler';

configureSharp();
await runWorker('COMPRESS', compress);
