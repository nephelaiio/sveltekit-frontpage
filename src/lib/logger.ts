import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';

const LOG_LEVELS = {
	silly: 0,
	trace: 1,
	debug: 2,
	info: 3,
	warn: 4,
	error: 5,
	fatal: 6
};
const logger: Logger<ILogObj> = new Logger({ name: 'worker', minLevel: LOG_LEVELS.info });

export { logger, LOG_LEVELS };
