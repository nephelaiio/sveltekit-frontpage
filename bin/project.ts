import type { ILogObj } from 'tslog';

import { Command } from 'commander';
import { execSync } from 'child_process';
import { Logger } from 'tslog';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

if (fs.existsSync(`${process.cwd()}/.env`)) {
	dotenv.config({ path: `${process.cwd()}/.env` });
}

const MAX_DEPLOYMENTS = 5;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || null;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const SVELTE_BUILD_DIR = '.svelte-kit/cloudflare';
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

async function genericAPI(
	url: string,
	path: string,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
	headers: HeadersInit,
	body: object | null = null
) {
	const uri = `${url}/${path}`;
	logger.debug(`${method} ${uri}`);
	async function apiReturn(result: Response) {
		if (!(result.ok || (result.status == 404 && method == 'DELETE'))) {
			throw new Error(`${method} ${uri} failed with status ${result.status}`);
		} else {
			if (result.status == 204) {
				logger.debug(`${method} ${uri} succeeded with status ${result.status}`);
				return null;
			} else {
				const response = await result.json();
				logger.debug(`${method} ${uri} succeeded with status ${result.status}`);
				return response;
			}
		}
	}
	if (body != null) {
		const result = await fetch(uri, { method, headers, body: JSON.stringify(body) });
		return apiReturn(result);
	} else {
		const result = await fetch(uri, { method, headers });
		return apiReturn(result);
	}
}

const githubAPI = (
	path: string,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
	body: object | null = null
) => {
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/vnd.github.v3+json',
		Authorization: `token ${GITHUB_TOKEN}`
	};
	return genericAPI('https://api.github.com', path, method, headers, body);
};

const cloudflareAPI = (
	path: string,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
	body: object | null = null
) => {
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/json',
		Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`
	};
	return genericAPI('https://api.cloudflare.com/client/v4', path, method, headers, body);
};

function execute(command: string, mode: 'run' | 'exec' | 'cli' = 'exec'): string {
	const npm = `npm ${mode} --`;
	const cmd = `${mode == 'cli' ? '' : npm} ${command}`;
	try {
		logger.debug(`Executing '${cmd}'`);
		const output = execSync(cmd).toString();
		return output;
	} catch (error: any) {
		const { status } = error;
		logger.error(`Command execution failed with status ${status || 'interrupted'}`);
		throw new Error(`Failed to execute '${cmd}'`);
	}
}

async function deploy(name: string, environment: string, head: string): Promise<void> {
	logger.debug('Entering deploy command handler');
	const allProjects = await cloudflareAPI(`accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects`);
	const projectsMatch = allProjects.result.filter((x: any) => x.name === name);
	if (projectsMatch.length === 0) {
		// create cloudflare pages project
		execute(`wrangler pages project create ${name} --production-branch ${head}`);
	}
	// publish to cloudflare pages
	// if path SVELTE_BUILD_DIR does not exist, wrangler will fail
	if (!fs.existsSync(SVELTE_BUILD_DIR)) {
		execute('build', 'run');
	}
	const publish = execute(
		`wrangler pages publish ${SVELTE_BUILD_DIR} --project-name ${name} --branch ${environment} --commit-dirty true`
	);
	const publishUrl = `${publish.split(' ').at(-1)}`.trim();
	logger.debug(`Project deployed at url ${publishUrl}`);
	console.log(publishUrl);
	logger.debug('Exiting deploy command handler');
}

async function cleanGithubDeployments(repository: string, environment: string): Promise<void> {
	const allDeployments = await githubAPI(`repos/${repository}/deployments`);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const envDeployments = allDeployments.filter((x: any) => x.environment === environment);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const sortedDeployments = envDeployments.sort((x: any, y: any) => {
		const xDate = new Date(x.updated_at);
		const yDate = new Date(y.updated_at);
		xDate >= yDate;
	});
	logger.debug(`Found ${allDeployments.length} total deployments`);
	logger.debug(`Found ${sortedDeployments.length} environment deployments`);
	logger.debug(sortedDeployments.map((x: any) => x.updated_at));
	if (sortedDeployments.length > MAX_DEPLOYMENTS) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const extraDeployments = sortedDeployments.slice(MAX_DEPLOYMENTS, sortedDeployments.length);
		logger.debug(`Removing ${extraDeployments.length} deployments`);
		logger.debug(extraDeployments.map((x: any) => x.updated_at));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		extraDeployments.forEach(async (deployment: any) => {
			logger.debug(`Removing deployment ${deployment.id}: ${deployment.updated_at}`);
			const inactive = { state: 'inactive' };
			await githubAPI(
				`repos/${repository}/deployments/${deployment.id}/statuses`,
				'POST',
				inactive
			);
			await githubAPI(`repos/${repository}/deployments/${deployment.id}`, 'DELETE');
			logger.debug(`Deployment ${deployment.id} removed`);
		});
	}
}

async function clean(repository: string, environment: string): Promise<void> {
	logger.debug('Entering clean command handler');
	cleanGithubDeployments(repository, environment);
	logger.debug('Exiting clean command handler');
}

function checkConfig() {
	if (!GITHUB_TOKEN) {
		logger.fatal('GITHUB_TOKEN environment variable is not set');
		process.exit(1);
	}
	if (!CLOUDFLARE_API_TOKEN) {
		logger.fatal('CLOUDFLARE_API_TOKEN environment variable is not set');
		process.exit(1);
	}
	if (!CLOUDFLARE_ACCOUNT_ID) {
		logger.fatal('CLOUDFLARE_ACCOUNT_ID environment variable is not set');
		process.exit(1);
	}
}

function main() {
	const program = new Command();
	program
		.version('0.0.1', '--version', 'output the current version')
		.description('page deployment tool')
		.helpOption('-h, --help', 'output usage information')
		.option('-v, --verbose', 'verbose output', false)
		.option('-q, --quiet', 'quiet output (overrides verbose)', false)
		.hook('preAction', (program, _) => {
			const isVerbose = program.opts()['verbose'];
			const isQuiet = program.opts()['quiet'];
			const isGithubAction = process.env.GITHUB_ACTIONS === 'true';
			if (isVerbose) logger.settings.minLevel = LOG_LEVELS.debug;
			if (isQuiet) logger.settings.minLevel = LOG_LEVELS.fatal;
			if (isGithubAction) logger.settings.minLevel = LOG_LEVELS.fatal;
		});
	program
		.command('deploy')
		.argument('<name>', 'page project name')
		.argument('<environment>', 'page environment')
		.option('-h, --head [name]', 'head branch', 'master')
		.action((name, environment, options, program) => {
			deploy(name, environment, options.head);
		});
	program
		.command('clean')
		.argument('<repository>', 'github repository in <owner>/<repo> format')
		.argument('<environment>', 'page environment')
		.action((repository, environment, options, program) => {
			clean(repository, environment);
		});
	program.parse(process.argv);
}

//process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
checkConfig();
try {
	main();
} catch (error: any) {
	logger.fatal(error.message);
	process.exit(1);
}
