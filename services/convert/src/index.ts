import { configureSharp } from '@pipeline/core/imaging';
import { runWorker } from '@pipeline/core/worker';
import { convert } from './handler';

configureSharp();
await runWorker('CONVERT', convert);
