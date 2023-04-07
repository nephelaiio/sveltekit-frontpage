import type { ILogObj } from 'tslog';

import { Command } from 'commander';
import { execSync } from 'child_process';
import { Logger } from 'tslog';
import * as toml from 'toml';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

if (fs.existsSync(`${process.cwd()}/.env`)) {
	dotenv.config({ path: `${process.cwd()}/.env` });
}

const config = {
	GITHUB_API_URL: 'https://api.github.com/repos',
	GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || null,
	WRANGLER_CONFIG: 'wrangler.toml',
	LOG_LEVELS: {
		silly: 0,
		trace: 1,
		debug: 2,
		info: 3,
		warn: 4,
		error: 5,
		fatal: 6
	}
};
const logger: Logger<ILogObj> = new Logger({ name: 'worker', minLevel: config.LOG_LEVELS.info });

function readConfig(configFile: string = config.WRANGLER_CONFIG) {
	return toml.parse(fs.readFileSync(configFile, 'utf-8'));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
//async function githubAPI(method: string, path: string, body: any = null): Promise<any[]> {
//const headers = { Authorization: `Bearer ${config.cloudflare_api_token}` };
//const url = `${config.cloudflare_api_url}/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/${path}`;
//logger.debug('Calling Cloudflare API:');
//logger.debug(`  curl -X${method} ${url} -H "Authorization: ${headers.Authorization}"`);
//const response = await fetch(url, {
//	method,
//	headers,
//	body
//});
//if (!response.ok) {
//	throw new Error(`Failed to fetch worker data: ${response.status}`);
//}
//const data = await response.json();
//return [data.result].flat();
//}

function cloudflareWorkerName(prefix: string): string {
	const { name } = readConfig(config.WRANGLER_CONFIG);
	if (prefix != '' && prefix != 'main' && prefix != 'master') {
		return `${prefix}-${name}`;
	} else {
		return name;
	}
}

function deployCloudflareWorker(name: string) {
	const command = `npm exec wrangler publish -- --name ${name.trim()}`;
	try {
		logger.debug(`Executing ${command}`);
		const output = execSync(`${command} 2>&1`).toString();
		const deploymentId = output
			.split('\n')
			.filter((line) => line.match(/.*Deployment ID:/))[0]
			.split(':')[1]
			.trim();
		const workerUrl = output
			.split('\n')
			.filter((line) => line.match(/.*workers.dev$/))[0]
			.trim();
		logger.info(`Worker deployment ${deploymentId} successful`);
		logger.info(`Worker deployed at ${workerUrl}`);
		return { deploymentId, workerUrl };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} catch (error: any) {
		const { status, outBuffer, errBuffer } = error;
		const stderr = (errBuffer && errBuffer.toString()) || 'unknown error';
		const stdout = (outBuffer && outBuffer.toString()) || 'no output';
		logger.error(`worker deployment failed wiith code ${status || 'interrupted'}`);
		logger.error(`stdout: ${stdout}`);
		logger.error(`stderr: ${stderr}`);
		throw new Error(`Failed to deploy cloudflare Worker ${name}`);
	}
}

async function deploy(name: string) {
	logger.debug('Entering deploy command handler');
	const { workerUrl } = deployCloudflareWorker(name);
	logger.debug(`Worker deployed at ${workerUrl}`);
	logger.debug('Exiting deploy command handler');
}

function removeCloudflareWorker(name: string): void {
	const command = `npm exec wrangler delete -- --name ${name}`;
	logger.debug(command);
	try {
		execSync(command);
	} catch {} // eslint-disable-line no-empty
	logger.info(`worker ${name} removed successfully`);
}

function remove(name: string): void {
	logger.debug('Entering remove command handler');
	removeCloudflareWorker(name);
	logger.debug('Exiting remove command handler');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
async function handle(program: Command, fn: (x: string) => void, args: any) {
	const isVerbose = program.opts()['verbose'];
	const isQuiet = program.opts()['quiet'];
	const isGithubAction = process.env.GITHUB_ACTIONS === 'true';
	if (isVerbose) logger.settings.minLevel = config.LOG_LEVELS.debug;
	if (isQuiet) logger.settings.minLevel = config.LOG_LEVELS.fatal;
	if (isGithubAction) logger.settings.minLevel = config.LOG_LEVELS.fatal;
	logger.debug(`Running action handler with args ${JSON.stringify(args)}`);
	const workerName = process.env.WORKER_NAME
		? cloudflareWorkerName(process.env.WORKER_NAME)
		: cloudflareWorkerName(program.opts()['prefix']);
	logger.debug(`Deploying cloudflare worker ${workerName}`);
	fn(workerName);
}

function checkConfig() {
	if (!config.GITHUB_REPOSITORY) {
		logger.fatal('GITHUB_REPOSITORY environment variable is not set');
		process.exit(1);
	}
}

function main() {
	const program = new Command();

	program
		.version('0.0.1', '--version', 'output the current version')
		.description('worker deployment tool')
		.option('-v, --verbose', 'verbose output', false)
		.option('-q, --quiet', 'quiet output (overrides verbose)', false)
		.option('-p, --prefix', 'deployment name prefix', 'test');
	program.command('deploy').action((options) => handle(program, deploy, options));
	program.command('remove').action((options) => handle(program, remove, options));
	program.parse(process.argv);
}

checkConfig();
main();
