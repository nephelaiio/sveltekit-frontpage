import type { ILogObj } from 'tslog';

import { Command } from 'commander';
import { execSync } from 'child_process';
import { Logger } from 'tslog';
import * as toml from 'toml';
import * as fs from 'fs';

const CONFIG_FILE = 'wrangler.toml';
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

function isGithubAction(): boolean {
	return process.env.GITHUB_ACTIONS === 'true';
}

function readConfig(configFile: string = CONFIG_FILE) {
	const config = toml.parse(fs.readFileSync(configFile, 'utf-8'));
	return config;
}

function deployCloudflareWorker(branch: string): string | null {
	logger.debug('Entering deploy command handler');
	const config = readConfig(CONFIG_FILE);
	const workerName = `${branch}-${config.name}`;
	const command = `npm exec wrangler publish -- --name ${workerName}`;
	try {
		logger.debug(`Running command: ${command}`);
		const outBuffer = execSync(command);
		const workerId = outBuffer
			.toString()
			.split('\n')
			.filter((line) => line.match(/.*Deployment ID:/))[0]
			.split(':')[1]
			.trim();
		logger.info(`worker deployed successfully with id ${workerId}`);
		logger.debug('Exiting deploy command handler');
		return workerId;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} catch (error: any) {
		const { status, outBuffer, errBuffer } = error;
		const stderr = (errBuffer && errBuffer.toString()) || 'unknown error';
		const stdout = (outBuffer && outBuffer.toString()) || 'no output';
		logger.error(`worker deployment failed: ${status || 'interrupted'}`);
		logger.error(`stdout: ${stdout}`);
		logger.error(`stderr: ${stderr}`);
		return null;
	}
}

function deploy(branch: string): void {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const workerId = deployCloudflareWorker(branch);
}

function removeCloudflareWorker(branch: string): string | null {
	logger.debug('Entering remove command handler');
	const config = readConfig(CONFIG_FILE);
	const workerName = `${branch}-${config.name}`;
	const command = `npm exec wrangler delete -- --name ${workerName}`;
	logger.debug(command);
	try {
		execSync(command);
	} catch {} // eslint-disable-line no-empty
	logger.info(`worker ${workerName} removed successfully`);
	logger.debug('Exiting remove command handler');
	return null;
}

function remove(branch: string): void {
	removeCloudflareWorker(branch);
}

async function handle<T>(program: Command, fn: (x: T) => void, arg: T) {
	logger.debug('Entering generic command handler');
	const verbose = program.opts()['verbose'];
	const quiet = program.opts()['quiet'];
	if (verbose) logger.settings.minLevel = LOG_LEVELS.debug;
	if (quiet) logger.settings.minLevel = LOG_LEVELS.fatal;
	if (isGithubAction()) logger.settings.minLevel = LOG_LEVELS.fatal;
	fn(arg);
	logger.debug('Exiting generic command handler');
}

function main() {
	const program = new Command();

	program
		.version('0.0.1', '--version', 'output the current version')
		.description('worker deployment tool')
		.option('-v, --verbose', 'verbose output', false)
		.option('-q, --quiet', 'quiet output (overrides verbose)', false);
	program
		.command('deploy')
		.option('-b, --branch <branch>', 'branch name')
		.action((options) => handle(program, deploy, options.branch));
	program
		.command('remove')
		.option('-b, --branch <branch>', 'branch name')
		.action((options) => handle(program, remove, options.branch));
	program.parse(process.argv);
}

main();
